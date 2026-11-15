#!/usr/bin/env bash
# Nightly backup (run by cron as root; see deploy/cron/finance):
#   1. a consistent snapshot of the SQLite database (safe while the app runs), checked for damage,
#   2. compressed and uploaded to the private Cloudflare R2 bucket: daily/ always, monthly/ on the 1st,
#   3. daily copies older than 35 days and monthly ones older than 400 days deleted.
# Any failed step stops the run. Settings in deploy/backup.env (see backup.env.example). Restore with
# deploy/scripts/restore.sh.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_DIR/deploy/backup.env"
WORK="$(mktemp -d)"

finish() {
  local status=$?
  rm -rf "$WORK"
  if [[ -n "${HEALTHCHECK_BACKUP_URL:-}" ]]; then
    curl -fsS -m 10 --retry 3 "$HEALTHCHECK_BACKUP_URL/$status" >/dev/null || true
  fi
  exit "$status"
}
trap finish EXIT

: "${BACKUP_BUCKET:?Set BACKUP_BUCKET in deploy/backup.env}"
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_R2_ENDPOINT="${R2_ENDPOINT:?}" RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?}"

DB="$REPO_DIR/deploy/data/finance.db"
NAME="finance-$(date +%Y-%m-%d).db.gz"
chmod 0700 "$WORK"

sqlite3 -readonly "$DB" ".backup '$WORK/finance.db'"
check="$(sqlite3 "$WORK/finance.db" 'PRAGMA integrity_check;')"
if [[ "$check" != "ok" ]]; then
  echo "The snapshot failed its integrity check: $check" >&2
  exit 1
fi
gzip -9 -c "$WORK/finance.db" >"$WORK/$NAME"

rclone copyto "$WORK/$NAME" "r2:$BACKUP_BUCKET/daily/$NAME"
if [[ "$(date +%d)" == "01" ]]; then
  rclone copyto "$WORK/$NAME" "r2:$BACKUP_BUCKET/monthly/$NAME"
fi
rclone delete --min-age 35d "r2:$BACKUP_BUCKET/daily"
rclone delete --min-age 400d "r2:$BACKUP_BUCKET/monthly"
echo "Backed up $NAME ($(stat -c %s "$WORK/$NAME") bytes)"
