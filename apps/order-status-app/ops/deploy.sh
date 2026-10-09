#!/usr/bin/env sh
#
# Deploy the Order Status Board with Docker Compose.
#
# Usage:
#   ops/deploy.sh <environment> <image-tag>
#
#   environment  staging | production
#   image-tag    immutable tag, e.g. the merged commit SHA (staging) or a
#                released version tag (production)
#
# Behaviour:
#   * staging   builds ${ORDER_STATUS_IMAGE:-${PIGO_DEPLOY_IMAGE:-local/order-status-app:<tag>}}
#               locally and tags it with the full commit SHA
#   * production never builds or pulls: it verifies with `docker image inspect`
#     that the local image ID equals the executor-provided PIGO_DEPLOY_IMAGE_ID
#     and then only runs `compose up --no-build --pull never`
#   * both run `compose up -d` (idempotent) and wait for the healthcheck
#   * never runs `docker prune`, never removes unrelated images/containers, and
#     never pushes to a registry
#
# Environment variables:
#   ORDER_STATUS_IMAGE   full image reference (compose-facing)
#   PIGO_DEPLOY_IMAGE    full image reference (executor-facing); used when
#                        ORDER_STATUS_IMAGE is not set
#   PIGO_DEPLOY_IMAGE_ID exact local image ID produced by the staging deploy;
#                        required for production and compared byte-for-byte
#                        against the image that ORDER_STATUS_IMAGE points to
#   ORDER_STATUS_PORT    host loopback port (staging default: 18080,
#                        production default: 18081)
#   APP_VERSION          version reported by /healthz (default: 0.1.0)

set -eu

usage() {
  printf 'Usage: %s <environment> <image-tag>\n' "$(basename "$0")" >&2
  printf '  environment  staging | production\n' >&2
  printf '  image-tag    immutable tag, e.g. the merged commit SHA\n' >&2
}

ENVIRONMENT="${1:-}"
IMAGE_TAG="${2:-}"

if [ -z "$ENVIRONMENT" ] || [ -z "$IMAGE_TAG" ]; then
  usage
  exit 2
fi

case "$ENVIRONMENT" in
  staging | production | prod) ;;
  *)
    printf 'Unsupported environment: %s\n' "$ENVIRONMENT" >&2
    usage
    exit 2
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  printf 'docker is required but was not found in PATH\n' >&2
  exit 2
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
APP_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$APP_DIR/compose.yaml"

case "$ENVIRONMENT" in
  staging)
    # Keep the existing staging project identity so this upgrade does not leave
    # a legacy container behind on the staging port.
    PROJECT_NAME="order-status-app"
    DEFAULT_PORT="18080"
    ;;
  production | prod)
    # Production must be a separate stack (and loopback port) so promotion never
    # replaces the staging deployment or collides with it on the same host.
    PROJECT_NAME="${COMPOSE_PROJECT_NAME:-order-status-production}"
    DEFAULT_PORT="18081"
    ;;
esac

# Prefer the compose-facing reference; fall back to the executor-provided one.
# The default keeps staging's full-commit-SHA local image name.
IMAGE="${ORDER_STATUS_IMAGE:-${PIGO_DEPLOY_IMAGE:-local/order-status-app:${IMAGE_TAG}}}"
export ORDER_STATUS_IMAGE="$IMAGE"
export APP_VERSION="${APP_VERSION:-0.1.0}"
export ORDER_STATUS_PORT="${ORDER_STATUS_PORT:-$DEFAULT_PORT}"

printf '==> Deploying %s\n' "$ENVIRONMENT"
printf '    project : %s\n' "$PROJECT_NAME"
printf '    image   : %s\n' "$IMAGE"
printf '    port    : 127.0.0.1:%s -> 8080\n' "$ORDER_STATUS_PORT"

case "$ENVIRONMENT" in
  staging)
    printf '==> Building image %s\n' "$IMAGE"
    docker build --tag "$IMAGE" "$APP_DIR"
    ;;
  production | prod)
    # Production never builds or pulls. The executor has already verified that
    # this exact image passed staging on this host, so a missing image or a
    # mismatched ID is a hard consistency failure, never permission to contact
    # a registry.
    if [ -z "${PIGO_DEPLOY_IMAGE_ID:-}" ]; then
      printf 'PIGO_DEPLOY_IMAGE_ID is required for production deployments\n' >&2
      exit 1
    fi
    LOCAL_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
    if [ -z "$LOCAL_IMAGE_ID" ]; then
      printf 'Staging-verified local image is missing: %s\n' "$IMAGE" >&2
      exit 1
    fi
    if [ "$LOCAL_IMAGE_ID" != "$PIGO_DEPLOY_IMAGE_ID" ]; then
      printf 'Image ID mismatch for %s\n' "$IMAGE" >&2
      printf '  expected (PIGO_DEPLOY_IMAGE_ID): %s\n' "$PIGO_DEPLOY_IMAGE_ID" >&2
      printf '  actual   (local image ID)      : %s\n' "$LOCAL_IMAGE_ID" >&2
      exit 1
    fi
    printf '==> Reusing staging-verified local image %s (%s)\n' "$IMAGE" "$LOCAL_IMAGE_ID"
    ;;
esac

printf '==> Applying compose stack (idempotent)\n'
docker compose \
  --file "$COMPOSE_FILE" \
  --project-name "$PROJECT_NAME" \
  up -d --no-build --pull never

# Wait for the container healthcheck so a broken rollout fails the deploy.
CONTAINER_ID="$(docker compose --file "$COMPOSE_FILE" --project-name "$PROJECT_NAME" ps -q order-status-app)"
if [ -z "$CONTAINER_ID" ]; then
  printf 'Could not find the order-status-app container after compose up\n' >&2
  exit 1
fi

ATTEMPT=0
while [ "$ATTEMPT" -lt 30 ]; do
  STATUS="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER_ID" 2>/dev/null || printf 'unknown')"
  case "$STATUS" in
    healthy)
      printf '==> %s is healthy\n' "$PROJECT_NAME"
      printf '==> Deployment finished successfully\n'
      exit 0
      ;;
    unhealthy | exited | dead)
      printf 'Container status is %s; deployment failed.\n' "$STATUS" >&2
      exit 1
      ;;
    *)
      ATTEMPT=$((ATTEMPT + 1))
      sleep 2
      ;;
  esac
done

printf 'Timed out waiting for %s to become healthy\n' "$PROJECT_NAME" >&2
exit 1
