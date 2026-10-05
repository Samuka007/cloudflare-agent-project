/**
 * scripts/pm-harness.ts — #206 the persistent PM harness carrier.
 *
 * PM session bootstrap is ONE cell:
 *
 *     %load "scripts/pm-harness.ts"
 *
 * What it does, in order:
 *  1. cache-bust dynamic-imports plugins/pm-harness/src/core.ts (`?t=<now>` — pm.md
 *     坑档 "AP 模块变更后内核需带 ?t= 重 import", encoded as default behavior)
 *     and installs the FRESH instance as globalThis.AP. The assignment is
 *     unconditional: the module's own `??=` mount would keep a stale AP
 *     across cache-busted reloads, which is exactly the drift it exists to
 *     prevent;
 *  2. weaves the spawn transport (#206): when the omp eval kernel exposes
 *     globalThis.agent, it is registered as AP.lane's spawn transport —
 *     `(p) => agent(p.prompt, {isolated: true, label: p.label})`, the #200
 *     kernel recipe. Without the kernel global the slot is left untouched so
 *     a confirm dispatch reports transport-missing on the report — never a
 *     silent skip;
 *  3. stamps the ready flag: globalThis.AP_READY = true and
 *     globalThis.AP_HARNESS = { loadedAt, module, transport, ready }.
 *
 * First dispatch, end to end (#206 acceptance — real ticket, real spawn):
 *
 *     await AP.lane(<number>, {}, { confirm: true });
 *     // gate → worktree add → real spawn (agent://<id> handle) → guarded
 *     // board flip (Status → In Progress). rep.agentId carries the roster id.
 *
 * Consumers: the eval JS kernel (%load — top-level await runs there) and
 * `pnpm --filter @cap/scripts typecheck`. No test of its own: the transport
 * seam is covered by L1 in plugins/pm-harness/test/core.test.ts (#206 describe), and
 * the real-bridge demo is the ticket's manual acceptance (smoke test stays
 * env-gated: AP_LANE_SMOKE=1 + a kernel agent global).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AP, SpawnRequest } from "../plugins/pm-harness/src/core.js";

/** omp eval-kernel global as a named unchecked view: the typeof guard below
 *  is the runtime validation (absent global → transport=missing). */
type KernelAgent = (prompt: string, opts: { isolated: boolean; label: string }) => unknown;

interface HarnessState {
  loadedAt: string;
  module: string;
  transport: "globalThis.agent" | "missing";
  ready: boolean;
}

/** The module surface the harness consumes. Typed via a static type-only
 *  import (erased at runtime) — the runtime instance below arrives through
 *  the cache-busted dynamic import. */
interface AutopilotModule {
  AP: typeof AP;
  registerSpawn: (fn: ((p: SpawnRequest) => unknown) | null) => void;
}

/** Locates plugins/pm-harness/src/core.ts: cwd first (documented usage — the eval
 *  kernel starts at the repo root), then walking up from this module's dir,
 *  ≤6 levels (same shape as resolveJeapiKey's .env.local walk). */
function resolveAutopilotPath(): string {
  const meta = import.meta as { dir?: string; url?: string };
  const roots: string[] = [process.cwd()];
  if (typeof meta.dir === "string") roots.push(meta.dir);
  else if (typeof meta.url === "string") roots.push(dirname(fileURLToPath(meta.url)));
  for (const root of roots) {
    let dir = root;
    for (let i = 0; i < 6; i += 1) {
      const candidate = join(dir, "plugins", "pm-harness", "src", "core.ts");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("pm-harness: plugins/pm-harness/src/core.ts not found from cwd or module dir");
}

const modulePath = resolveAutopilotPath();

// Static import cannot work here BY DESIGN (#206 ticket mandate): the whole
// point is a runtime-selected specifier — `?t=<now>` cache-bust — so module
// edits reach the kernel without a session restart (pm.md 坑档). Every static
// import of the core would pin the kernel's first cached instance forever.
// Cache-bust import: a fresh module instance per load. The harness is the
// one sanctioned entry through which staleness cannot leak — everything the
// PM touches afterwards (AP, spawnOverride state) lives in THIS instance.
const mod = (await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`)) as AutopilotModule;

// Unconditional install: ??= (the module's self-mount) would preserve a
// stale AP across reloads — the exact failure the cache-bust targets.
const scope = globalThis as { AP?: typeof AP; AP_READY?: boolean; AP_HARNESS?: HarnessState };
scope.AP = mod.AP;

const kernelScope = globalThis as { agent?: KernelAgent };
let transport: HarnessState["transport"];
if (typeof kernelScope.agent === "function") {
  const agent = kernelScope.agent;
  mod.registerSpawn((p) => agent(p.prompt, { isolated: true, label: p.label }));
  transport = "globalThis.agent";
} else {
  transport = "missing";
}

scope.AP_HARNESS = {
  loadedAt: new Date().toISOString(),
  module: modulePath,
  transport,
  ready: true,
};
scope.AP_READY = true;

console.log(
  `pm-harness: AP ready (transport=${transport}) — await AP.lane(<number>, {}, { confirm: true })` +
    (transport === "missing"
      ? " — no globalThis.agent here: lane(confirm) reports transport-missing (register one or run in the omp kernel)"
      : ""),
);
