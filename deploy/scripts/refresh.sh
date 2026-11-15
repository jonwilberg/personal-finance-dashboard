#!/usr/bin/env bash
# Fetch new transactions for every connected bank account (run daily by cron; see deploy/cron/finance).
# Pings HEALTHCHECK_REFRESH_URL from deploy/backup.env when set, so a run that fails or never happens gets noticed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
[[ -f "$REPO_DIR/deploy/backup.env" ]] && source "$REPO_DIR/deploy/backup.env"

status=0
docker compose -f "$REPO_DIR/deploy/compose.yaml" exec -T app finance refresh-all || status=$?

if [[ -n "${HEALTHCHECK_REFRESH_URL:-}" ]]; then
  curl -fsS -m 10 --retry 3 "$HEALTHCHECK_REFRESH_URL/$status" >/dev/null || true
fi
exit "$status"
