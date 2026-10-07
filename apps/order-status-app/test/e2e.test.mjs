/**
 * End-to-end integration tests for the Order Status Board.
 *
 * Unlike http.test.mjs (which isolates routes with a temporary public dir),
 * these tests exercise the *shipped* `public/` assets against the real server
 * created by `createAppServer()` with default options, and verify the direct
 * execution path (`node src/server.mjs`) plus SIGTERM shutdown.
 *
 * Uses node:test/assert + global fetch only. No dependencies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAppServer, SERVICE_NAME, DEFAULT_VERSION } from '../src/server.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join('src', 'server.mjs');

/**
 * Start a server on a random loopback port, run `fn(baseUrl)`, then always
 * close the server and its keep-alive sockets.
 */
async function withServer(fn, options = {}) {
  const server = createAppServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

async function postJson(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/api/orders/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

test('the shipped SPA is served, wired to the API, and returns business results', async () => {
  await withServer(async (baseUrl) => {
    // 1. The UI document is served from public/index.html.
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();

    assert.match(html, /<title>订单履约状态台<\/title>/);
    assert.match(html, /订单履约状态台/);
    // Required controls for acceptance criterion 4.
    assert.match(html, /id="order-id"/);
    assert.match(html, /id="paid"/);
    assert.match(html, /id="stock"/);
    assert.match(html, /已支付/);
    assert.match(html, /有库存/);
    assert.match(html, /评估订单/);
    // Same-origin local assets only.
    assert.match(html, /(?:\/|\.\/)app\.js/);
    assert.match(html, /(?:\/|\.\/)styles\.css/);
    // The order ID input must not enforce a native UTF-16 `maxlength`; the
    // script validates by Unicode code points so valid supplementary-plane
    // identifiers can reach the API.
    assert.doesNotMatch(html, /\bmaxlength\s*=/i);
    assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1|localhost)/);
    assert.doesNotMatch(html, /@import/);

    // 2. The assets the page references are actually served.
    const css = await fetch(`${baseUrl}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    assert.ok((await css.text()).length > 0);

    const js = await fetch(`${baseUrl}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    const jsSource = await js.text();
    assert.match(jsSource, /\/api\/orders\/evaluate/);
    assert.match(jsSource, /application\/json/);
    // The controller delegates order ID validation to the shared module that
    // counts Unicode code points (matching the server domain).
    assert.match(jsSource, /order-id\.mjs/);

    const orderIdModule = await fetch(`${baseUrl}/order-id.mjs`);
    assert.equal(orderIdModule.status, 200);
    assert.match(orderIdModule.headers.get('content-type') ?? '', /javascript/);
    assert.match(await orderIdModule.text(), /countOrderIdCharacters/);

    // 3. The API route the page uses returns the three business statuses.
    const cases = [
      [{ orderId: 'E2E-1', paid: false, stock: false }, 'WAITING_PAYMENT'],
      [{ orderId: 'E2E-2', paid: true, stock: false }, 'WAITING_STOCK'],
      [{ orderId: 'E2E-3', paid: true, stock: true }, 'READY_TO_SHIP'],
    ];
    for (const [payload, expected] of cases) {
      const { response, body } = await postJson(baseUrl, payload);
      assert.equal(response.status, 200);
      assert.equal(body.status, expected);
      assert.match(body.message, /[\u4e00-\u9fff]/, `${expected} needs a Chinese message`);
    }

    // 4. Invalid input from the same page surface yields the unified 400 error.
    const invalid = await postJson(baseUrl, { orderId: '   ', paid: true, stock: true });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_INPUT');
  });
});

test('direct execution listens on the requested port, serves healthz, and exits on SIGTERM', async () => {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: '0', APP_VERSION: DEFAULT_VERSION },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = once(child, 'exit');
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start; log:\n${stdout}${stderr}`)), 10000);
      const check = () => {
        const match = stdout.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      child.stdout.on('data', check);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`server exited before listening; log:\n${stdout}${stderr}`));
      });
    });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      service: SERVICE_NAME,
      version: DEFAULT_VERSION,
      status: 'ok',
    });

    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(signal, null, `expected a clean exit, got signal ${signal}`);
    assert.equal(code, 0, `expected exit code 0, got ${code}; stderr:\n${stderr}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
});
