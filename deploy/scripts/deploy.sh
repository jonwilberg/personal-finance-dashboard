#!/usr/bin/env bash
# Deploy the latest main now, instead of waiting for the timer (it checks every minute anyway):
#
#   sudo deploy/scripts/deploy.sh
#
# Same steps as the timer (deploy/scripts/auto-deploy.sh): only an image CI published from main, with a verified
# attestation, is deployed; the app must come up healthy or the previous version and database are put back.
set -euo pipefail

exec "$(dirname "${BASH_SOURCE[0]}")/auto-deploy.sh" "$@"
