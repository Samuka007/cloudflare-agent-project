#!/usr/bin/env node
/**
 * Issue #592: `eslint .` dies with SIGTERM (exit 143) on memory-constrained
 * dev boxes.
 *
 * Root cause (measured, per-scope peak RSS of a fresh `eslint <scope>`
 * process, typescript-eslint projectService loading that project's whole TS
 * program into the heap):
 *
 *   packages/protocol        ~0.7 GB
 *   packages/mcp             ~0.7 GB
 *   packages/agent-config    ~1.0 GB
 *   packages/agent-durable   ~1.0 GB
 *   packages/daemon-service  ~1.2 GB
 *   apps/provider-app        ~0.7 GB
 *   apps/server-worker       ~2.0 GB (workers-types ambient lib + decorators)
 *   scripts                  ~0.7 GB
 *
 * One `eslint .` process keeps every project's program alive at once
 * (typescript-eslint's projectService holds one ProjectService instance for
 * the whole run), so the single-process footprint approaches the ~7 GB sum.
 * GitHub CI runners (7 GB, no OOM daemon) squeak by; dev boxes run an OOM
 * manager (this repo's primary dev box runs earlyoom -m10) that SIGTERMs the
 * eslint process → pnpm reports exit 143 (128+SIGTERM) mid-run.
 *
 * Fix: same eslint flat config (eslint.config.mjs is untouched — the FILE
 * scope is unchanged), but one eslint process per workspace scope, run
 * sequentially. Peak RSS stays at the ~2 GB worst single scope instead of
 * the multi-GB sum, and a violation in one scope still fails the run.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Dirs that never contain lintable source (mirrors eslint.config.mjs ignores). */
const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", "public", ".git"]);

function hasLintableFiles(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(current, entry.name));
      } else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name)) {
        return true;
      }
    }
  }
  return false;
}

/** Workspace scopes with lintable files: packages/*, apps/*, scripts. */
const scopes = ["packages", "apps"]
  .flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${group}/${e.name}`),
  )
  .concat("scripts")
  .filter((scope) => hasLintableFiles(join(root, scope)));

const eslintBin = join(root, "node_modules", ".bin", "eslint");
let failed = false;
for (const scope of scopes) {
  const result = spawnSync(eslintBin, [scope], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`eslint ${scope}: ${result.error.message}`);
    failed = true;
  } else if (result.status !== 0) {
    console.error(`eslint ${scope}: exit ${result.status}`);
    failed = true;
  }
}
if (failed) process.exit(1);
