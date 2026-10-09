import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('production reuses the staging image without registry access', async () => {
  const script = await readFile(path.join(APP_DIR, 'ops', 'deploy.sh'), 'utf8');
  assert.match(script, /docker image inspect "\$IMAGE"/);
  assert.match(script, /up --detach --no-build --pull never/);
  assert.doesNotMatch(script, /\bpull order-status-app\b/);
});

test('production uses an isolated compose project and generated container name', async () => {
  const [script, compose] = await Promise.all([
    readFile(path.join(APP_DIR, 'ops', 'deploy.sh'), 'utf8'),
    readFile(path.join(APP_DIR, 'compose.yaml'), 'utf8'),
  ]);
  assert.match(script, /PROJECT_NAME="\$\{COMPOSE_PROJECT_NAME:-order-status-production\}"/);
  assert.doesNotMatch(compose, /^\s*container_name:/m);
});
