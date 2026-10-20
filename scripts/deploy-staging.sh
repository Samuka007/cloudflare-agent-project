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
#
# D1 migrations (#295 → #591/#594 → #601): the control plane migrates through
# the drizzle ledger (apps/server-worker/drizzle/, applied by `wrangler d1
# migrations apply DB_V2 --remote` below BEFORE `wrangler deploy` — a worker
# version never goes live against a schema its code assumes but the DB lacks;
# the #288 walkthrough outage's lesson). The ledger records one apply per
# migration tag and never replays; the legacy 14-file replay chain and the
# hand-written db layer were deleted in T9 (#601), which also lands the
# one-shot DROP teardown of the legacy database. Docs:
# docs/ops/staging-d1-migrations.md.
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

# #566: the worker imports bb packages through their dist JS (exports default
# condition) — build the five dist-emitting bb packages before wrangler
# bundles, so the deploy can never ship a stale or missing dist.
echo "== building bb dist packages =="
pnpm build:bb

# SEC-W5-001 (#397): deploy-time gate-armed assertion. #505 removed the flag —
# gate state IS the credential pair (middleware/access.ts derives it from
# ACCESS_TEAM_DOMAIN + ACCESS_AUD), so the assert script checks that the
# retired var has not crept back into the JSONC config and that both secrets
# exist on the worker (live `wrangler secret list`). Either missing = a
# staging deploy whose control plane answers 503 access_gate_disabled on
# every /api/v1 + /ws request — dead on arrival.
echo "== asserting Access gate credentials (config + worker secrets, SEC-W5-001) =="
node scripts/assert-staging-gate.mjs

if [[ $SKIP_SPA -eq 0 ]]; then
  bash scripts/stage-bb-spa.sh
fi

echo "== dropping legacy control-plane tables on cap-control-plane (staging, T9 #601) =="
# W6 db campaign T9 (#601): the legacy replay chain (migrations/*.sql, the
# hand-written db layer, the 0011-unregistered-file drift class) is deleted
# with the code — the drizzle ledger on cap-control-plane-v2 below is the
# only migration apparatus. What remains here is the one-shot teardown of
# the LEGACY cap-control-plane database: every old table dropped (children
# before parents for the FK-enabled D1), idempotent via IF EXISTS, so the
# stale schema cannot outlive its readers. The database itself is deleted
# in the campaign closeout — delete this block together with it.
(
  cd apps/server-worker
  pnpm exec wrangler d1 execute cap-control-plane --remote -y \
    -c wrangler.staging.jsonc \
    --command "DROP TABLE IF EXISTS pending_interactions; DROP TABLE IF EXISTS thread_tabs; DROP TABLE IF EXISTS host_daemon_sessions; DROP TABLE IF EXISTS threads; DROP TABLE IF EXISTS environments; DROP TABLE IF EXISTS thread_sections; DROP TABLE IF EXISTS project_sources; DROP TABLE IF EXISTS app_settings; DROP TABLE IF EXISTS app_theme; DROP TABLE IF EXISTS web_search; DROP TABLE IF EXISTS tool_capabilities; DROP TABLE IF EXISTS origin_allowlist; DROP TABLE IF EXISTS permission_mode; DROP TABLE IF EXISTS compaction_settings; DROP TABLE IF EXISTS image_source; DROP TABLE IF EXISTS provider_configs; DROP TABLE IF EXISTS hosts; DROP TABLE IF EXISTS projects;"
)

# W6 db campaign (#591/#594): the drizzle-era control plane migrates through
# the LEDGER — `wrangler d1 migrations apply` records each file in the D1
# d1_migrations table and applies every pending migration exactly once
# (second run is a tracked no-op). The migration set is drizzle-kit generated
# (apps/server-worker/src/db/schema.ts → drizzle/); migrations_dir comes from
# the DB_V2 entry in wrangler.staging.jsonc. T9 (#601): the worker's sole
# control plane — the legacy cap-control-plane database only hosts the
# teardown DROP block above until the closeout deletes it.
echo "== applying drizzle ledger migrations to cap-control-plane-v2 (staging) =="
(
  cd apps/server-worker
  # Non-interactive runs skip wrangler's confirm step on their own.
  pnpm exec wrangler d1 migrations apply DB_V2 --remote \
    -c wrangler.staging.jsonc
)

SHA="$(git rev-parse --short HEAD)"
echo "== deploying cap-server-staging @ $SHA (SERVER_VERSION=$SHA) =="

SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/staging-secrets.XXXXXX.env")"
trap 'rm -f "$SECRETS_FILE"' EXIT
printf 'SERVER_VERSION=%s\n' "$SHA" > "$SECRETS_FILE"

# #398/SEC-W5-002: the daemon-face credentials have no in-repo fallback (the
# composed worker fails closed without them), so pass real secrets through
# when provided — CI repo secrets or local .dev.vars (via `nix run
# .#staging-deploy`). Absent keys are omitted: wrangler preserves the
# previous deployment's secret, and a first-ever deployment without them
# fails closed on the daemon face by design.
for secret in ENROLL_KEY DAEMON_HOST_KEY; do
  if [[ -n "${!secret:-}" ]]; then
    printf '%s=%s\n' "$secret" "${!secret}" >> "$SECRETS_FILE"
  fi
done

(
  cd apps/server-worker
  pnpm exec wrangler deploy -c wrangler.staging.jsonc --secrets-file "$SECRETS_FILE"
)
echo "== deployed $SHA =="
