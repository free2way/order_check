#!/usr/bin/env sh
#
# Smoke test the Order Status Board API.
#
# Usage:
#   APP_BASE_URL=http://127.0.0.1:18080 ops/smoke.sh
#
# Verifies:
#   * GET  /healthz                 -> 200, service=order-status-app, version=0.1.0
#   * POST /api/orders/evaluate     -> the three business statuses
#       paid=false, stock=false     -> WAITING_PAYMENT
#       paid=true,  stock=false     -> WAITING_STOCK
#       paid=true,  stock=true      -> READY_TO_SHIP
#
# Exits non-zero on the first mismatch.

set -eu

APP_BASE_URL="${APP_BASE_URL:-http://127.0.0.1:18080}"
BASE="${APP_BASE_URL%/}"

if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required but was not found in PATH\n' >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'node is required but was not found in PATH\n' >&2
  exit 2
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT TERM

fail() {
  printf 'SMOKE FAIL: %s\n' "$*" >&2
  exit 1
}

# request <method> <path> [json-body] -> prints HTTP status code, body in $BODY_FILE
BODY_FILE="$WORK_DIR/body.json"
request() {
  method="$1"
  path="$2"
  body="${3:-}"
  if [ -n "$body" ]; then
    code="$(curl --silent --show-error --output "$BODY_FILE" --write-out '%{http_code}' \
      --request "$method" --header 'Content-Type: application/json' \
      --data "$body" "$BASE$path")" || fail "curl failed for $method $path"
  else
    code="$(curl --silent --show-error --output "$BODY_FILE" --write-out '%{http_code}' \
      --request "$method" "$BASE$path")" || fail "curl failed for $method $path"
  fi
  printf '%s' "$code"
}

check_health() {
  code="$(request GET /healthz)"
  [ "$code" = "200" ] || fail "/healthz returned HTTP $code"
  node -e '
    const fs = require("node:fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (body.service !== "order-status-app") {
      console.error("expected service=order-status-app but got " + body.service);
      process.exit(1);
    }
    if (body.version !== "0.1.0") {
      console.error("expected version=0.1.0 but got " + body.version);
      process.exit(1);
    }
  ' "$BODY_FILE" || fail "/healthz payload is invalid"
  printf 'ok  /healthz -> service=order-status-app version=0.1.0\n'
}

check_order() {
  expected="$1"
  paid="$2"
  stock="$3"
  payload="{\"orderId\":\"SMOKE-${expected}\",\"paid\":${paid},\"stock\":${stock}}"
  code="$(request POST /api/orders/evaluate "$payload")"
  [ "$code" = "200" ] || fail "evaluate ${expected} returned HTTP $code"
  node -e '
    const fs = require("node:fs");
    const expected = process.argv[2];
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (body.status !== expected) {
      console.error("expected status " + expected + " but got " + body.status);
      process.exit(1);
    }
    if (typeof body.message !== "string" || !/[\u4e00-\u9fff]/.test(body.message)) {
      console.error("expected a Chinese message but got " + JSON.stringify(body.message));
      process.exit(1);
    }
  ' "$BODY_FILE" "$expected" || fail "evaluate ${expected} payload is invalid"
  printf 'ok  POST /api/orders/evaluate paid=%s stock=%s -> %s\n' "$paid" "$stock" "$expected"
}

printf 'Smoke testing %s\n' "$BASE"
check_health
check_order WAITING_PAYMENT false false
check_order WAITING_STOCK true false
check_order READY_TO_SHIP true true
printf 'SMOKE OK\n'
