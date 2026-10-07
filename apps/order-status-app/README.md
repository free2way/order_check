# Order Status Board (`order-status-app`)

A small, self-contained order fulfillment status board. It exposes a
zero-dependency Node.js HTTP API and a static Chinese single-page UI that lets
an operator check whether an order is waiting for payment, waiting for stock,
or ready to ship.

The application is designed to run independently: the container image contains
everything it needs, and there are no third-party runtime dependencies.

## Requirements

- Node.js 22 (the app uses the built-in `node:http` server and global `fetch`)
- Docker / Docker Compose v2 (only for container builds, deployment and smoke)
- `curl` and `node` on the host for `ops/smoke.sh`

## Project layout

```
apps/order-status-app/
├── package.json        # scripts + metadata (no dependencies)
├── src/                # domain + HTTP server (owned by the API module)
├── public/             # static single-page UI
├── test/               # node:test suites
├── Dockerfile          # node:22-alpine, non-root, /healthz healthcheck
├── .dockerignore
├── compose.yaml        # hardened stack, loopback-only port binding
└── ops/
    ├── deploy.sh       # build (staging) + idempotent compose up
    └── smoke.sh        # healthz + three business scenarios
```

## Local development

No install step is required — there are no dependencies:

```sh
cd apps/order-status-app
npm start            # equivalent to: node src/server.mjs
```

Override the defaults with environment variables:

```sh
PORT=8080 APP_VERSION=0.1.0 npm start
```

| Variable      | Default   | Purpose                                   |
| ------------- | --------- | ----------------------------------------- |
| `PORT`        | `8080`    | HTTP listen port                          |
| `APP_VERSION` | `0.1.0`   | Version reported by `GET /healthz`        |

Open <http://127.0.0.1:8080/> for the UI.

## Tests

```sh
cd apps/order-status-app
npm test
# or, from the repository root:
node --test apps/order-status-app/test/*.test.mjs
```

The suites use the built-in `node:test` runner and `node:assert`; they bind a
random local port and close the server after each test, so no process or port
is left behind.

`npm run check` performs a syntax check of the server and domain modules.

## HTTP API

### `GET /healthz`

```sh
curl -s http://127.0.0.1:8080/healthz
# {"service":"order-status-app","version":"0.1.0","status":"ok"}
```

Product requirement: HTTP `200` with `service=order-status-app` and
`version=0.1.0`.

### `POST /api/orders/evaluate`

Request body (JSON, max 64 KiB):

```json
{ "orderId": "ORDER-1", "paid": true, "stock": false }
```

Response:

```json
{ "orderId": "ORDER-1", "status": "WAITING_STOCK", "message": "..." }
```

Status rules:

| `paid`  | `stock` | `status`          |
| ------- | ------- | ----------------- |
| `false` | any     | `WAITING_PAYMENT` |
| `true`  | `false` | `WAITING_STOCK`   |
| `true`  | `true`  | `READY_TO_SHIP`   |

Invalid input returns HTTP `400` with a JSON error whose `code` is
`INVALID_INPUT`.

## Docker build

```sh
cd apps/order-status-app
docker build -t order-status-app:local .
```

The image is based on `node:22-alpine`, runs as the unprivileged `node` user,
exposes port `8080`, and defines a `HEALTHCHECK` that calls `/healthz`.

Run it directly (hardened flags mirror the compose file):

```sh
docker run --rm \
  --name order-status-app \
  -p 127.0.0.1:18080:8080 \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  order-status-app:local
```

## Docker Compose

The compose stack binds to loopback only and is read-only:

```sh
cd apps/order-status-app
ORDER_STATUS_IMAGE=order-status-app:local \
ORDER_STATUS_PORT=18080 \
docker compose up -d --build
```

| Variable             | Default                    | Purpose                                  |
| -------------------- | -------------------------- | ---------------------------------------- |
| `ORDER_STATUS_IMAGE` | `order-status-app:latest`  | Image reference used by the service      |
| `ORDER_STATUS_PORT`  | `18080`                    | Host loopback port                       |
| `APP_VERSION`        | `0.1.0`                    | Version reported by `/healthz`           |

Security settings: `read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]`,
`security_opt: [no-new-privileges:true]`, plus a container healthcheck.

## Deployment

`ops/deploy.sh` takes an environment and an immutable image tag:

```sh
cd apps/order-status-app

# staging: builds locally, then applies the stack idempotently
ops/deploy.sh staging "$(git rev-parse HEAD)"

# production: expects an already published image, never builds
ops/deploy.sh production 0.1.0
```

The script always runs `docker compose up -d` (idempotent), waits for the
healthcheck, returns non-zero on any failure, and never runs `docker prune` or
removes unrelated images/containers. Override the image reference or port when
needed:

```sh
ORDER_STATUS_IMAGE=registry.example.com/order-status-app:abc123 \
ORDER_STATUS_PORT=18080 \
ops/deploy.sh production abc123
```

For staging, the image tag should be the merged commit SHA.

## Smoke test

`ops/smoke.sh` reads `APP_BASE_URL` and verifies `/healthz` plus the three
business statuses. It exits non-zero on the first mismatch.

```sh
cd apps/order-status-app
APP_BASE_URL=http://127.0.0.1:18080 ops/smoke.sh
```

Expected output ends with `SMOKE OK`.

## Logs

```sh
cd apps/order-status-app
docker compose logs -f order-status-app     # follow stack logs
docker logs -f order-status-app             # follow the container directly
```

## Rollback to the previous image

The stack is named `order-status-app`, so rolling back means re-pointing it at
the previously known-good image and running `compose up -d` again:

```sh
cd apps/order-status-app

# Find the previous tag (CI artifact, registry tag list, or release notes).
PREVIOUS_TAG=0.0.9

ORDER_STATUS_IMAGE=order-status-app:$PREVIOUS_TAG \
  docker compose up -d --no-build
```

Then confirm the rollback:

```sh
APP_BASE_URL=http://127.0.0.1:18080 ops/smoke.sh
```

For a tagged environment with a registry image, use the same command with the
full reference, for example
`ORDER_STATUS_IMAGE=registry.example.com/order-status-app:$PREVIOUS_TAG`.

## Safety notes

- The service is never published on a public interface: compose binds
  `127.0.0.1:${ORDER_STATUS_PORT:-18080}:8080`.
- The container filesystem is read-only; only `/tmp` is writable.
- All Linux capabilities are dropped and privilege escalation is disabled.
- Deployment never prunes Docker state and never touches unrelated workloads.
