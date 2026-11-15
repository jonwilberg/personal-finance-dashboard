#!/usr/bin/env bash
# Deploys the latest main, when there is a new one. Run every minute by the finance-deploy timer (deploy/systemd/),
# as root; also by deploy/scripts/deploy.sh to deploy straight away.
#
#   1. Brings the checkout (scripts, compose file) up to date with origin/main.
#   2. Looks up which image ghcr.io/<repo>:main points to. Same as running: nothing more to do, quietly.
#   3. Verifies the image's attestation: built by this repository's CI workflow, from main, on GitHub's runners.
#      An image that fails is never run.
#   4. Snapshots the database, pulls the image by digest, tags it finance-app:current and restarts the app.
#   5. If the app isn't healthy within two minutes: puts the snapshot and the previous image back.
#
# Pings HEALTHCHECK_DEPLOY_URL from deploy/backup.env after every run when set (a heartbeat: the timer also stopping
# gets noticed). Everything runs inside main(), so bash has read the whole script before step 1 may change it.
set -euo pipefail

main() {
  local repo_dir deploy_dir compose repo image lock
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  deploy_dir="$repo_dir/deploy"
  compose=(docker compose -f "$deploy_dir/compose.yaml")
  repo="jonwilberg/personal-finance-dashboard"
  image="ghcr.io/$repo"
  lock=/run/finance-deploy.lock

  # One run at a time; a deploy can take longer than the timer's interval.
  exec 9>"$lock"
  flock -n 9 || return 0

  # shellcheck disable=SC1091
  [[ -f "$deploy_dir/backup.env" ]] && source "$deploy_dir/backup.env"
  # Called plainly (not as `deploy || ...`, which would switch off set -e inside it): any failed step stops the run,
  # and the ping reports how it ended.
  trap 'ping_healthcheck $?' EXIT
  deploy "$@"
}

ping_healthcheck() {
  if [[ -n "${HEALTHCHECK_DEPLOY_URL:-}" ]]; then
    curl -fsS -m 10 --retry 2 "$HEALTHCHECK_DEPLOY_URL/$1" >/dev/null || true
  fi
}

deploy() {
  local owner digest current
  # The checkout belongs to the login user; update it as them, so files keep their owner.
  owner="$(stat -c %U "$repo_dir")"
  runuser -u "$owner" -- git -C "$repo_dir" fetch --quiet origin main
  runuser -u "$owner" -- git -C "$repo_dir" merge --quiet --ff-only origin/main

  digest="$(docker buildx imagetools inspect "$image:main" --format '{{.Manifest.Digest}}')"
  [[ "$digest" == sha256:* ]] || { echo "Couldn't read the digest of $image:main: $digest" >&2; return 1; }
  current="$(docker image inspect finance-app:current --format '{{join .RepoDigests " "}}' 2>/dev/null || true)"
  if [[ " $current " == *"@$digest "* ]]; then
    return 0 # already running it
  fi

  echo "==> New image $digest"
  # The attestation comes from the registry (--bundle-from-oci) and is checked against Sigstore's public trust root,
  # so no GitHub login is needed; gh just won't start without a token. Any call that did need GitHub's API would fail
  # with this placeholder, so it can only make verification fail, never pass.
  if ! GH_TOKEN=no-login-needed gh attestation verify "oci://$image@$digest" \
      --repo "$repo" \
      --signer-workflow "$repo/.github/workflows/ci.yml" \
      --source-ref refs/heads/main \
      --deny-self-hosted-runners \
      --bundle-from-oci >/dev/null; then
    echo "The image's attestation didn't verify: not deploying it." >&2
    return 1
  fi
  echo "==> Attestation verified (built by ci.yml from main)"

  docker pull --quiet "$image@$digest" >/dev/null
  snapshot
  if docker image inspect finance-app:current >/dev/null 2>&1; then
    docker tag finance-app:current finance-app:previous
  fi
  docker tag "$image@$digest" finance-app:current
  "${compose[@]}" up -d --remove-orphans

  if wait_healthy; then
    echo "==> Deployed $(git -C "$repo_dir" log -1 --format='%h %s')"
    docker image prune -f >/dev/null
    return 0
  fi

  echo "The new version didn't become healthy. Its logs:" >&2
  "${compose[@]}" logs --tail 40 app >&2 || true
  if docker image inspect finance-app:previous >/dev/null 2>&1; then
    echo "==> Rolling back to the previous version and the database from just before" >&2
    "${compose[@]}" stop app
    install -m 0600 -o 10001 -g 10001 "$deploy_dir/data/finance.db.before-deploy" "$deploy_dir/data/finance.db"
    docker tag finance-app:previous finance-app:current
    "${compose[@]}" up -d
    wait_healthy || echo "The previous version isn't healthy either." >&2
  fi
  return 1
}

# The database as it was just before this deploy, in case the new version has to be rolled back.
snapshot() {
  local db="$deploy_dir/data/finance.db" keep="$deploy_dir/data/finance.db.before-deploy"
  [[ -f "$db" ]] || return 0
  sqlite3 -readonly "$db" ".backup '$keep.tmp'"
  chown 10001:10001 "$keep.tmp" && chmod 0600 "$keep.tmp"
  mv "$keep.tmp" "$keep"
}

wait_healthy() {
  local container status
  for _ in $(seq 1 60); do
    container="$("${compose[@]}" ps -q app)"
    status="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    sleep 2
  done
  return 1
}

main "$@"
