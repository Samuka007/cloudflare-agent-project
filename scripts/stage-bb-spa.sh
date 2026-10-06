#!/usr/bin/env bash
# Build the pinned bb SPA submodule and stage it into apps/server-worker/public.
#
# SINGLE SOURCE for the served SPA set (#175): ci.yml, the GHA CD workflow
# (.github/workflows/deploy-staging.yml) and `nix run .#staging-deploy` all
# execute this script. Before #175 the two copy paths drifted: CI excluded
# *.gz/*.br (ci.yml:32) while the flake deploy copied the whole dist
# (flake.nix:74) — the set CI tested was not the set staging served.
#
# Canonical set = full vite dist MINUS precompressed *.gz/*.br: Workers static
# assets compress at the edge, so shipping precompressed copies would only
# double the asset upload.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [[ ! -f bb/apps/app/package.json ]]; then
  echo "ERROR: bb submodule not initialized — run 'git submodule update --init'" >&2
  exit 1
fi
echo "== bb SPA submodule pinned at $(git -C bb rev-parse --short HEAD) =="

# --ignore-scripts: the SPA build needs no native desktop deps (the node-pty
# node-gyp build is desktop-only and fails on CI runners).
if [[ ! -d bb/node_modules ]]; then
  echo "== installing bb workspace deps =="
  pnpm --dir bb install --frozen-lockfile --ignore-scripts
fi

echo "== building bb SPA =="
pnpm --dir bb --filter @bb/app build

if [[ ! -f bb/apps/app/dist/index.html ]]; then
  echo "ERROR: bb/apps/app/dist/index.html missing — build produced no dist" >&2
  exit 1
fi

rm -rf apps/server-worker/public
mkdir -p apps/server-worker/public
(cd bb/apps/app/dist && tar cf - --exclude='*.gz' --exclude='*.br' .) |
  (cd apps/server-worker/public && tar xf -)

# Asset assertions (#39 white-screen regression guard): the entry asset
# referenced by index.html must exist and the bundle must not be a partial
# upload. Formerly inline in the flake app; now shared by every caller.
ENTRY_JS="$(grep -o '/assets/index-[^"]*\.js' apps/server-worker/public/index.html | head -1)"
if [[ -z "$ENTRY_JS" || ! -f "apps/server-worker/public$ENTRY_JS" ]]; then
  echo "ERROR: SPA entry asset missing (index.html -> ${ENTRY_JS:-none}); refusing to continue" >&2
  exit 1
fi
ASSET_COUNT="$(find apps/server-worker/public/assets -maxdepth 1 -type f | wc -l)"
if (( ASSET_COUNT < 10 )); then
  echo "ERROR: only $ASSET_COUNT assets staged; expected a full build (incident #39)" >&2
  exit 1
fi
echo "== SPA staged: $ASSET_COUNT assets, entry $ENTRY_JS =="

# Stage the cap-provider-config frontend plugin (#382): build it from the
# pinned fork, copy the dist beside the SPA assets, and write the descriptor
# the worker's static plugin registry reads
# (apps/server-worker/src/services/plugin-registry.ts). Hash/descriptor
# semantics live in scripts/stage-cap-provider-config.mjs.
echo "== building cap-provider-config plugin =="
# tsx resolves from CWD's node_modules chain — bb owns the devDependency, so
# run inside the submodule (the build script itself is dirname-relative).
(cd bb && node --conditions=source --import tsx scripts/build-cap-provider-config.mjs)
node scripts/stage-cap-provider-config.mjs
