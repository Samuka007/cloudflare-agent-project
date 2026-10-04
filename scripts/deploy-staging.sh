#!/usr/bin/env bash
# Deploy the composed worker + staged SPA to cap-server-staging.
#
# SINGLE SOURCE for the staging deploy flow (#175), executed verbatim by:
#   - the GHA CD workflow (.github/workflows/deploy-staging.yml) on every
#     merge to main — credentials from repo secrets;
#   - the flake app `nix run .#staging-deploy` for manual deploys —
#     credentials from the local .dev.vars.
#
# SERVER_VERSION=<short sha> rides the deploy itself via
# `wrangler deploy --secrets-file` (docs: secrets not in the file are
# preserved from the previous version; code+secret in one operation). This
# replaces the old `wrangler versions secret put` pre-stamp whose interaction
# with a plain `deploy` was never verified (docs/research/deployable-units.md
# U1 缺口 3).
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

SKIP_SPA=0
if [[ "${1:-}" == "--skip-spa-build" ]]; then SKIP_SPA=1; fi

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN not set (repo secrets on CI, .dev.vars locally)}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID not set (repo secrets on CI, .dev.vars locally)}"

if [[ ! -d node_modules ]]; then
  echo "ERROR: node_modules missing — run 'pnpm install --frozen-lockfile' first" >&2
  exit 1
fi

if [[ $SKIP_SPA -eq 0 ]]; then
  bash scripts/stage-bb-spa.sh
fi

SHA="$(git rev-parse --short HEAD)"
echo "== deploying cap-server-staging @ $SHA (SERVER_VERSION=$SHA) =="

SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/staging-secrets.XXXXXX.env")"
trap 'rm -f "$SECRETS_FILE"' EXIT
printf 'SERVER_VERSION=%s\n' "$SHA" > "$SECRETS_FILE"

(
  cd apps/server-worker
  pnpm exec wrangler deploy -c wrangler.staging.jsonc --secrets-file "$SECRETS_FILE"
)
echo "== deployed $SHA =="
