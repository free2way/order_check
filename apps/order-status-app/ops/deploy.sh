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
#   * staging   builds ${ORDER_STATUS_IMAGE:-order-status-app:<tag>} locally
#   * production never builds or pulls: it only reuses the exact image that
#     staging already built and verified on this host
#   * both run `compose up -d` (idempotent) and wait for the healthcheck
#   * never runs `docker prune` and never removes unrelated images/containers
#
# Environment variables:
#   ORDER_STATUS_IMAGE  full image reference (default: order-status-app:<tag>)
#   ORDER_STATUS_PORT   host loopback port (default: 18080)
#   APP_VERSION         version reported by /healthz (default: 0.1.0)

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
    ;;
  production | prod)
    # Production must be a separate stack so promotion never replaces staging.
    PROJECT_NAME="${COMPOSE_PROJECT_NAME:-order-status-production}"
    ;;
esac

IMAGE="${ORDER_STATUS_IMAGE:-order-status-app:${IMAGE_TAG}}"
export ORDER_STATUS_IMAGE="$IMAGE"
export APP_VERSION="${APP_VERSION:-0.1.0}"
export ORDER_STATUS_PORT="${ORDER_STATUS_PORT:-18080}"

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
    # this exact digest passed staging on this host; a missing image is therefore
    # a hard consistency failure, not permission to contact a registry.
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then
      printf '==> Reusing staging-verified local image %s\n' "$IMAGE"
    else
      printf 'Staging-verified local image is missing: %s\n' "$IMAGE" >&2
      exit 1
    fi
    ;;
esac

printf '==> Applying compose stack (idempotent)\n'
docker compose \
  --file "$COMPOSE_FILE" \
  --project-name "$PROJECT_NAME" \
  up --detach --no-build --pull never

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
