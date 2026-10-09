/**
 * Deployment-script contract and behavioural tests for ops/deploy.sh.
 *
 * The static assertions guard the production safety contract (never build,
 * never pull, require the staging-verified image ID). The behavioural tests run
 * the real script against a fake `docker` executable on PATH and assert what
 * the script actually does, including the digest check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = path.join(APP_DIR, 'ops', 'deploy.sh');
const COMPOSE = path.join(APP_DIR, 'compose.yaml');

const SHA = 'deadbeefcafe0123456789deadbeefcafe0123456';
const STAGING_IMAGE = `local/order-status-app:${SHA}`;
const IMAGE_ID = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const FAKE_DOCKER = [
  '#!/usr/bin/env sh',
  'log="${FAKE_DOCKER_LOG:?FAKE_DOCKER_LOG must be set}"',
  'printf \'docker %s\\n\' "$*" >> "$log"',
  '',
  'case "$1" in',
  '  build)',
  '    printf \'build image=%s\\n\' "$3" >> "$log"',
  '    exit "${FAKE_BUILD_EXIT:-0}"',
  '    ;;',
  '  image)',
  '    if [ "${FAKE_IMAGE_MISSING:-0}" = "1" ]; then',
  '      printf \'Error response from daemon: No such image\\n\' >&2',
  '      exit 1',
  '    fi',
  '    printf \'%s\\n\' "${FAKE_IMAGE_ID:-sha256:stagingid}"',
  '    exit 0',
  '    ;;',
  '  inspect)',
  '    printf \'%s\\n\' "${FAKE_CONTAINER_STATUS:-healthy}"',
  '    exit 0',
  '    ;;',
  '  pull)',
  '    printf \'top-level pull image=%s\\n\' "${ORDER_STATUS_IMAGE:-}" >> "$log"',
  '    exit "${FAKE_PULL_EXIT:-0}"',
  '    ;;',
  '  compose)',
  '    sub=""',
  '    for arg in "$@"; do',
  '      case "$arg" in',
  '        up|pull|ps) sub="$arg"; break ;;',
  '      esac',
  '    done',
  '    project=""',
  '    prev=""',
  '    for arg in "$@"; do',
  '      if [ "$prev" = "--project-name" ]; then project="$arg"; break; fi',
  '      prev="$arg"',
  '    done',
  '    case "$sub" in',
  '      up)',
  '        printf \'compose up project=%s image=%s port=%s\\n\' "$project" "${ORDER_STATUS_IMAGE:-}" "${ORDER_STATUS_PORT:-}" >> "$log"',
  '        exit "${FAKE_COMPOSE_UP_EXIT:-0}"',
  '        ;;',
  '      pull)',
  '        printf \'compose pull project=%s image=%s\\n\' "$project" "${ORDER_STATUS_IMAGE:-}" >> "$log"',
  '        exit "${FAKE_COMPOSE_PULL_EXIT:-0}"',
  '        ;;',
  '      ps)',
  '        printf \'%s\\n\' "${FAKE_CONTAINER_ID:-fake-container-id}"',
  '        exit 0',
  '        ;;',
  '      *)',
  '        printf \'unexpected compose invocation\\n\' >&2',
  '        exit 1',
  '        ;;',
  '    esac',
  '    ;;',
  '  *)',
  '    printf \'unexpected docker invocation: %s\\n\' "$*" >&2',
  '    exit 1',
  '    ;;',
  'esac',
  '',
].join('\n');

async function setupFakeDocker(t) {
  // /tmp is often mounted noexec, so keep the fake binary next to the app.
  const dir = await mkdtemp(path.join(APP_DIR, '.deploy-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir, { recursive: true });
  const dockerPath = path.join(binDir, 'docker');
  await writeFile(dockerPath, FAKE_DOCKER);
  await chmod(dockerPath, 0o755);
  const logFile = path.join(dir, 'docker.log');
  await writeFile(logFile, '');
  return { dir, binDir, logFile };
}

function runDeploy(args, { binDir, logFile }, env = {}) {
  return spawnSync('sh', [DEPLOY, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: logFile,
      ...env,
    },
  });
}

async function readLog(logFile) {
  return readFile(logFile, 'utf8');
}

function findLine(log, prefix) {
  return log.split('\n').find((line) => line.startsWith(prefix));
}

function assertNoBuildOrPull(log, message) {
  assert.doesNotMatch(log, /^docker build\b/m, message);
  assert.doesNotMatch(log, /^docker pull\b/m, message);
  assert.doesNotMatch(log, /compose pull/, message);
}

test('production contract never builds or pulls and requires the staging image ID', async () => {
  const script = await readFile(DEPLOY, 'utf8');
  // Production must gate on the exact staging-built image ID.
  assert.match(script, /PIGO_DEPLOY_IMAGE_ID is required for production/);
  assert.match(script, /docker image inspect --format '\{\{\.Id\}\}' "\$IMAGE"/);
  // Promotion only ever applies the already-verified local image.
  assert.match(script, /up -d --no-build --pull never/);
  assert.doesNotMatch(script, /compose[\s\S]{0,120}\bpull order-status-app\b/);
});

test('production uses an isolated compose project and no fixed container name', async () => {
  const [script, compose] = await Promise.all([
    readFile(DEPLOY, 'utf8'),
    readFile(COMPOSE, 'utf8'),
  ]);
  assert.match(script, /PROJECT_NAME="\$\{COMPOSE_PROJECT_NAME:-order-status-production\}"/);
  assert.doesNotMatch(compose, /^\s*container_name:/m);
});

test('staging builds the full-commit-SHA image and starts with --pull never', async (t) => {
  const fake = await setupFakeDocker(t);
  const result = runDeploy(['staging', SHA], fake, { PIGO_DEPLOY_IMAGE: STAGING_IMAGE });
  assert.equal(result.status, 0, result.stderr);

  const log = await readLog(fake.logFile);
  assert.match(log, new RegExp(`^docker build --tag ${STAGING_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm'));
  assert.match(log, new RegExp(`build image=${STAGING_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const upLine = findLine(log, 'compose up ');
  assert.ok(upLine, 'compose up should have been called');
  assert.match(upLine, /project=order-status-app/);
  assert.match(upLine, new RegExp(`image=${STAGING_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(log, /^docker compose .*up -d --no-build --pull never$/m);
  // Staging is allowed to build, but it must never contact a registry.
  assert.doesNotMatch(log, /^docker pull\b/m);
  assert.doesNotMatch(log, /compose pull/);
});

test('production reuses the matching image ID and never builds or pulls', async (t) => {
  const fake = await setupFakeDocker(t);
  const result = runDeploy(['production', SHA], fake, {
    ORDER_STATUS_IMAGE: STAGING_IMAGE,
    PIGO_DEPLOY_IMAGE_ID: IMAGE_ID,
    FAKE_IMAGE_ID: IMAGE_ID,
  });
  assert.equal(result.status, 0, result.stderr);

  const log = await readLog(fake.logFile);
  assert.match(log, /docker image inspect --format \{\{\.Id\}\} local\/order-status-app:/);
  assertNoBuildOrPull(log, 'production must never build or pull');

  const upLine = findLine(log, 'compose up ');
  assert.ok(upLine, 'compose up should have been called');
  assert.match(upLine, /project=order-status-production/);
  assert.match(log, /^docker compose .*up -d --no-build --pull never$/m);
});

test('production fails immediately when the local image ID does not match', async (t) => {
  const fake = await setupFakeDocker(t);
  const result = runDeploy(['production', SHA], fake, {
    ORDER_STATUS_IMAGE: STAGING_IMAGE,
    PIGO_DEPLOY_IMAGE_ID: 'sha256:expected-but-different',
    FAKE_IMAGE_ID: IMAGE_ID,
  });
  assert.notEqual(result.status, 0, 'mismatched digest must fail the deploy');
  assert.match(result.stderr, /Image ID mismatch/i);

  const log = await readLog(fake.logFile);
  assertNoBuildOrPull(log, 'a mismatch must not fall back to a build or a pull');
  assert.equal(findLine(log, 'compose up '), undefined, 'a mismatch must abort before compose up');
});

test('production requires PIGO_DEPLOY_IMAGE_ID to be non-empty', async (t) => {
  const fake = await setupFakeDocker(t);
  const result = runDeploy(['production', SHA], fake, {
    ORDER_STATUS_IMAGE: STAGING_IMAGE,
    PIGO_DEPLOY_IMAGE_ID: '',
  });
  assert.notEqual(result.status, 0, 'missing image ID must fail the deploy');
  assert.match(result.stderr, /PIGO_DEPLOY_IMAGE_ID is required/);

  const log = await readLog(fake.logFile);
  assertNoBuildOrPull(log, 'a missing image ID must not build or pull');
  assert.equal(findLine(log, 'compose up '), undefined, 'a missing image ID must abort before compose up');
});

test('production fails instead of pulling when the local image is missing', async (t) => {
  const fake = await setupFakeDocker(t);
  const result = runDeploy(['production', SHA], fake, {
    ORDER_STATUS_IMAGE: STAGING_IMAGE,
    PIGO_DEPLOY_IMAGE_ID: IMAGE_ID,
    FAKE_IMAGE_MISSING: '1',
  });
  assert.notEqual(result.status, 0, 'a missing local image must fail the deploy');
  assert.match(result.stderr, /Staging-verified local image is missing/);

  const log = await readLog(fake.logFile);
  assertNoBuildOrPull(log, 'a missing image must not trigger a pull');
  assert.equal(findLine(log, 'compose up '), undefined);
});

test('PIGO_DEPLOY_IMAGE is honoured when ORDER_STATUS_IMAGE is unset', async (t) => {
  const fake = await setupFakeDocker(t);
  const result = runDeploy(['staging', SHA], fake, { PIGO_DEPLOY_IMAGE: STAGING_IMAGE });
  assert.equal(result.status, 0, result.stderr);
  const log = await readLog(fake.logFile);
  assert.match(log, new RegExp(`^docker build --tag ${STAGING_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm'));
});

test('staging and production use different compose projects and ports', async (t) => {
  const stagingFake = await setupFakeDocker(t);
  const staging = runDeploy(['staging', SHA], stagingFake, { PIGO_DEPLOY_IMAGE: STAGING_IMAGE });
  assert.equal(staging.status, 0, staging.stderr);
  const stagingUp = findLine(await readLog(stagingFake.logFile), 'compose up ');

  const productionFake = await setupFakeDocker(t);
  const production = runDeploy(['production', SHA], productionFake, {
    ORDER_STATUS_IMAGE: STAGING_IMAGE,
    PIGO_DEPLOY_IMAGE_ID: IMAGE_ID,
    FAKE_IMAGE_ID: IMAGE_ID,
  });
  assert.equal(production.status, 0, production.stderr);
  const productionUp = findLine(await readLog(productionFake.logFile), 'compose up ');

  const projectOf = (line) => /project=(\S+)/.exec(line)[1];
  const portOf = (line) => /port=(\S+)/.exec(line)[1];
  assert.notEqual(projectOf(stagingUp), projectOf(productionUp), 'projects must differ');
  assert.notEqual(portOf(stagingUp), portOf(productionUp), 'ports must differ');
});
