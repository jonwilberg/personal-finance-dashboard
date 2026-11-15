#!/usr/bin/env bash
# Put a database back from a backup, or move one in:
#
#   sudo deploy/scripts/restore.sh [backup name, e.g. finance-2026-11-20.db.gz]
#       Downloads that backup from R2 (default: the newest daily one).
#   sudo deploy/scripts/restore.sh --file <finance.db>
#       Uses a plain database file you copied to the server (e.g. when moving in from your PC).
#
# Stops the app, keeps the current database as finance.db.before-restore-<time>, puts the new one in place, checks
# it, and starts the app again.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE=(docker compose -f "$REPO_DIR/deploy/compose.yaml")
DATA="$REPO_DIR/deploy/data"
APP_UID=10001
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 0700 "$WORK"

if [[ "${1:-}" == "--file" ]]; then
  cp "${2:?Usage: restore.sh --file <finance.db>}" "$WORK/finance.db"
else
  # shellcheck disable=SC1091
  source "$REPO_DIR/deploy/backup.env"
  export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG_R2_ENDPOINT="${R2_ENDPOINT:?}" RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?}"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?}"
  NAME="${1:-$(rclone lsf "r2:$BACKUP_BUCKET/daily" | sort | tail -1)}"
  [[ -n "$NAME" ]] || { echo "No backups found in r2:$BACKUP_BUCKET/daily" >&2; exit 1; }
  echo "==> Restoring $NAME"
  folder=daily
  rclone lsf "r2:$BACKUP_BUCKET/daily/$NAME" >/dev/null 2>&1 || folder=monthly
  rclone copyto "r2:$BACKUP_BUCKET/$folder/$NAME" "$WORK/finance.db.gz"
  gunzip "$WORK/finance.db.gz"
fi

[[ "$(sqlite3 "$WORK/finance.db" 'PRAGMA integrity_check;')" == "ok" ]] || { echo "That database is damaged." >&2; exit 1; }

echo "==> Stopping the app"
"${COMPOSE[@]}" stop app || true
if [[ -f "$DATA/finance.db" ]]; then
  keep="$DATA/finance.db.before-restore-$(date +%Y%m%d-%H%M%S)"
  mv "$DATA/finance.db" "$keep"
  echo "==> Kept the old database as $keep"
fi
rm -f "$DATA/finance.db-wal" "$DATA/finance.db-shm"
install -m 0600 -o "$APP_UID" -g "$APP_UID" "$WORK/finance.db" "$DATA/finance.db"

echo "==> Starting the app"
"${COMPOSE[@]}" up -d
echo "Done."
