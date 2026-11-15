#!/usr/bin/env bash
# Update the server to the latest main and restart the app:
#
#   deploy/scripts/deploy.sh
#
# Pulls main, rebuilds the image, restarts the containers and waits until the app answers its health check.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE=(docker compose -f "$REPO_DIR/deploy/compose.yaml")

cd "$REPO_DIR"
git fetch --quiet origin main
git merge --ff-only origin/main
echo "==> At $(git log -1 --format='%h %s')"

"${COMPOSE[@]}" build --pull app
"${COMPOSE[@]}" up -d --remove-orphans

echo "==> Waiting for the app to be healthy"
for _ in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q app)" 2>/dev/null || true)"
  if [[ "$status" == "healthy" ]]; then
    docker image prune -f >/dev/null
    echo "==> Up and healthy"
    exit 0
  fi
  sleep 2
done
echo "The app didn't become healthy. Its logs:" >&2
"${COMPOSE[@]}" logs --tail 50 app >&2
exit 1
