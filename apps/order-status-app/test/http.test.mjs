import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAppServer, DEFAULT_VERSION } from '../src/server.mjs';

/**
 * Start a server on a random local port, run `fn(baseUrl)`, then always close
 * the server (including any keep-alive sockets) so no port or process leaks.
 */
async function withServer(fn, options = {}) {
  const server = createAppServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      // Node keeps keep-alive connections open; force them shut.
      server.closeAllConnections();
    });
  }
}

test('GET /healthz returns service metadata', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = await response.json();
    assert.deepEqual(body, {
      service: 'order-status-app',
      version: DEFAULT_VERSION,
      status: 'ok',
    });
  });
});

test('APP_VERSION environment value is the default version', async () => {
  const previous = process.env.APP_VERSION;
  process.env.APP_VERSION = '9.9.9-test';
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/healthz`);
      const body = await response.json();
      assert.equal(body.version, '9.9.9-test');
    });
  } finally {
    if (previous === undefined) {
      delete process.env.APP_VERSION;
    } else {
      process.env.APP_VERSION = previous;
    }
  }
});

const successCases = [
  [{ orderId: 'ORD-1001', paid: false, stock: false }, 'WAITING_PAYMENT'],
  [{ orderId: 'ORD-2001', paid: true, stock: false }, 'WAITING_STOCK'],
  [{ orderId: 'ORD-3001', paid: true, stock: true }, 'READY_TO_SHIP'],
];

for (const [payload, expectedStatus] of successCases) {
  test(`POST /api/orders/evaluate returns ${expectedStatus}`, async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/orders/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, expectedStatus);
      assert.equal(body.orderId, payload.orderId);
      assert.equal(typeof body.message, 'string');
      assert.ok(body.message.length > 0);
      assert.match(body.message, /[\u4e00-\u9fff]/);
    });
  });
}

test('POST /api/orders/evaluate rejects invalid input with INVALID_INPUT', async () => {
  const invalidPayloads = [
    { orderId: '', paid: true, stock: true },
    { orderId: '   ', paid: true, stock: true },
    { orderId: 'ORD-1', paid: 'yes', stock: true },
    { orderId: 'ORD-1', paid: true, stock: 1 },
  ];

  await withServer(async (baseUrl) => {
    for (const payload of invalidPayloads) {
      const response = await fetch(`${baseUrl}/api/orders/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400, JSON.stringify(payload));
      const body = await response.json();
      assert.equal(body.error.code, 'INVALID_INPUT');
      assert.equal(typeof body.error.message, 'string');
    }
  });
});

test('POST /api/orders/evaluate rejects malformed JSON', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/orders/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid json',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_JSON');
  });
});

test('POST /api/orders/evaluate rejects a non-JSON Content-Type', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/orders/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ orderId: 'ORD-1', paid: true, stock: true }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_CONTENT_TYPE');
  });
});

test('POST /api/orders/evaluate rejects a body over the 64 KiB limit', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/orders/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'a'.repeat(70 * 1024),
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
  });
});

test('unknown route returns 404 with a JSON error envelope', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/no-such-route`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = await response.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

test('non-POST method on the evaluate route returns 405', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/orders/evaluate`);
    assert.equal(response.status, 405);
    const body = await response.json();
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });
});

test('static files are served and path traversal is blocked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'order-status-public-'));
  const publicDir = path.join(root, 'public');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<h1>order status</h1>', 'utf8');
  await writeFile(path.join(root, 'secret.txt'), 'top-secret', 'utf8');

  try {
    await withServer(
      async (baseUrl) => {
        const index = await fetch(`${baseUrl}/`);
        assert.equal(index.status, 200);
        assert.match(await index.text(), /order status/);

        const traversal = await fetch(`${baseUrl}/..%2Fsecret.txt`);
        assert.notEqual(traversal.status, 200);
        assert.equal(traversal.status, 403);
        const body = await traversal.json();
        assert.equal(body.error.code, 'FORBIDDEN');

        const missing = await fetch(`${baseUrl}/missing.html`);
        assert.equal(missing.status, 404);
      },
      { publicDir },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
