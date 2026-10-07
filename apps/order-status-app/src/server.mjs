/**
 * HTTP API server for the Order Status Board.
 *
 * Zero third-party dependencies, ES modules, node:http only.
 *
 * Routes:
 *   GET  /healthz                 -> { service, version, status }
 *   POST /api/orders/evaluate     -> { orderId, paid, stock, status, message }
 *   GET  /*                       -> static files from <app>/public
 *
 * Error envelope (all errors): { error: { code, message } }
 */

import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateOrder, InvalidOrderError } from './domain.mjs';

export const SERVICE_NAME = 'order-status-app';
export const DEFAULT_VERSION = '0.1.0';
export const MAX_BODY_BYTES = 64 * 1024; // 64 KiB

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(MODULE_DIR, '..', 'public');

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
});

/**
 * Send a JSON response, guarding against double-sends and aborted sockets.
 */
function sendJson(res, statusCode, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

/**
 * Read the request body up to `limit` bytes.
 *
 * When the limit is exceeded the rest of the stream is drained and discarded
 * so the socket stays healthy and the caller can still return a clean 413.
 *
 * @returns {Promise<{ text: string, tooLarge: boolean }>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0; // drop what we buffered so far
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve({
        text: tooLarge ? '' : Buffer.concat(chunks).toString('utf8'),
        tooLarge,
      });
    });

    req.on('error', reject);
  });
}

async function handleEvaluate(req, res) {
  const { text, tooLarge } = await readBody(req, MAX_BODY_BYTES);

  if (tooLarge) {
    sendError(res, 413, 'PAYLOAD_TOO_LARGE', `请求体不能超过 ${MAX_BODY_BYTES} 字节`);
    return;
  }

  const contentType = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (contentType !== 'application/json') {
    sendError(res, 400, 'INVALID_CONTENT_TYPE', 'Content-Type 必须是 application/json');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    sendError(res, 400, 'INVALID_JSON', '请求体不是合法的 JSON');
    return;
  }

  try {
    sendJson(res, 200, evaluateOrder(payload));
  } catch (error) {
    if (error instanceof InvalidOrderError || error?.code === 'INVALID_INPUT') {
      sendError(res, 400, 'INVALID_INPUT', error.message);
    } else {
      sendError(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
    }
  }
}

/**
 * Resolve a request pathname to a file inside `publicDir`.
 *
 * Returns the absolute path, or `null` when the resolved path escapes the
 * public directory or the pathname is malformed.
 */
function resolveStaticPath(publicDir, pathname) {
  const baseDir = path.resolve(publicDir);
  let relative = pathname === '/' || pathname === '' ? '/index.html' : pathname;
  if (relative.endsWith('/')) {
    relative += 'index.html';
  }

  const candidate = path.resolve(baseDir, `.${relative}`);
  if (candidate !== baseDir && !candidate.startsWith(baseDir + path.sep)) {
    return null;
  }
  return candidate;
}

async function serveStatic(req, res, publicDir) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    sendError(res, 400, 'INVALID_PATH', '请求路径不合法');
    return;
  }

  if (pathname.includes('\0')) {
    sendError(res, 400, 'INVALID_PATH', '请求路径不合法');
    return;
  }

  let target = resolveStaticPath(publicDir, pathname);
  if (target === null) {
    sendError(res, 403, 'FORBIDDEN', '禁止访问该路径');
    return;
  }

  let stats;
  try {
    stats = await stat(target);
  } catch {
    sendError(res, 404, 'NOT_FOUND', '资源未找到');
    return;
  }

  if (stats.isDirectory()) {
    target = resolveStaticPath(publicDir, `${pathname.replace(/\/$/, '')}/`);
    if (target === null) {
      sendError(res, 403, 'FORBIDDEN', '禁止访问该路径');
      return;
    }
    try {
      stats = await stat(target);
    } catch {
      sendError(res, 404, 'NOT_FOUND', '资源未找到');
      return;
    }
  }

  if (!stats.isFile()) {
    sendError(res, 404, 'NOT_FOUND', '资源未找到');
    return;
  }

  let data;
  try {
    data = await readFile(target);
  } catch {
    sendError(res, 404, 'NOT_FOUND', '资源未找到');
    return;
  }

  const contentType = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.byteLength,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(data);
  }
}

async function handleRequest(req, res, options) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', '请求方法不被允许');
      return;
    }
    sendJson(res, 200, {
      service: SERVICE_NAME,
      version: options.version,
      status: 'ok',
    });
    return;
  }

  if (pathname === '/api/orders/evaluate') {
    if (req.method !== 'POST') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', '请求方法不被允许');
      return;
    }
    await handleEvaluate(req, res);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res, options.publicDir);
    return;
  }

  sendError(res, 404, 'NOT_FOUND', '资源未找到');
}

/**
 * Create a configured (but not yet listening) HTTP server.
 *
 * @param {{ version?: string, publicDir?: string }} [options]
 * @returns {import('node:http').Server}
 */
export function createAppServer(options = {}) {
  const version = options.version ?? process.env.APP_VERSION ?? DEFAULT_VERSION;
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const servedOptions = { version, publicDir };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, servedOptions).catch(() => {
      sendError(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
    });
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  return server;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const parsedPort = Number.parseInt(process.env.PORT ?? '8080', 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 8080;
  const server = createAppServer();

  server.listen(port, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`${SERVICE_NAME} listening on http://0.0.0.0:${actualPort}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`${SERVICE_NAME} received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    // Safety net in case a connection refuses to close.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
