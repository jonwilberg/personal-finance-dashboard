#!/usr/bin/env bash
# Starts an app image the way the server runs it (read-only, no privileges, behind Cloudflare Access) with throwaway
# settings, and checks that it comes up healthy, answers its health check, and turns away a request without a login.
# Used by CI before an image is published:
#
#   deploy/scripts/smoke-test.sh finance-app:ci
set -euo pipefail

image="${1:?Usage: smoke-test.sh <image>}"
name="finance-smoke-$$"
work="$(mktemp -d)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# A throwaway bank key and an empty, writable data folder for the app's user.
openssl genrsa -out "$work/test.pem" 2048 2>/dev/null
chmod 0644 "$work/test.pem"
mkdir "$work/data" && chmod 0777 "$work/data"

docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -e FINANCE_DATA_DIR=/data \
  -e ENABLE_BANKING_APP_ID=smoke-test \
  -e ENABLE_BANKING_KEY_PATH=/run/secrets/enablebanking.pem \
  -e ENABLE_BANKING_REDIRECT_URL=https://finance.example.com/callback \
  -e CF_ACCESS_TEAM_DOMAIN=example.cloudflareaccess.com \
  -e CF_ACCESS_AUD=smoke-test \
  -v "$work/data:/data" -v "$work/test.pem:/run/secrets/enablebanking.pem:ro" \
  -p 127.0.0.1:18765:8765 "$image" >/dev/null

status=""
for _ in $(seq 1 45); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null || echo gone)"
  [[ "$status" == "healthy" || "$status" == "gone" ]] && break
  sleep 2
done
if [[ "$status" != "healthy" ]]; then
  echo "The image didn't become healthy ($status). Its logs:" >&2
  docker logs "$name" >&2 || true
  exit 1
fi

check() {
  local path="$1" want="$2" got
  got="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:18765$path")"
  if [[ "$got" != "$want" ]]; then
    echo "$path answered $got, expected $want" >&2
    exit 1
  fi
  echo "$path: $got"
}
check /healthz 200
check /api/overview 403 # no Cloudflare Access login
check / 403
echo "Smoke test passed: $image"
