#!/usr/bin/env bash
# Issue #592: one-command bootstrap for a fresh clone.
#
#   pnpm bootstrap
#
# brings the repo to a state where `pnpm typecheck` and `pnpm lint` pass:
#   1. git submodules (bb/, pm-autopilot/) — bb/packages/* are pnpm workspace
#      members and bb's dist .d.ts feeds typecheck, so a fresh clone without
#      them cannot even install/typecheck.
#   2. pnpm install --frozen-lockfile (also runs the `prepare` script, which
#      installs the husky git hooks).
#   3. pnpm build:bb — five bb packages emit dist/ that typecheck consumes
#      and the vitest worker pipeline loads (mirrors the CI step order).
#
# Idempotent: safe to re-run on an already-bootstrapped checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[bootstrap] git submodules (bb, pm-autopilot)"
git submodule update --init --recursive

echo "[bootstrap] pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "[bootstrap] pnpm build:bb (dist consumed by typecheck/tests)"
pnpm build:bb

echo "[bootstrap] done — try: pnpm typecheck && pnpm lint"
