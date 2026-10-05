import { toolRegistryRow, type BatchScheduleClass } from "./registry.js";

/**
 * #328 C3 — conflict-aware tool-batch scheduling (pi parity anchor: pi
 * agent-loop.ts executeToolCalls defaults a batch to parallel execution and
 * tools/file-mutation-queue.ts serializes same-file mutations; the matrix
 * §4 C3 gap recorded that this system had neither).
 *
 * A model call's tool-call batch is split into ordered waves: wave 0
 * dispatches together, settles (every execution terminal), then wave 1
 * dispatches, and so on. Within a wave every pair is conflict-free, so
 * read-only calls run in parallel while same-file write/write and
 * read/write conflicts serialize — pi's "default parallel + per-file
 * mutation queue" semantics expressed at the dispatch scheduler.
 *
 * Everything here is pure and journal-derived: the class is a registry-row
 * constant and the key is a lexical function of the journaled call
 * arguments, so a replay or watchdog re-ask recomputes the identical
 * schedule from the log (no second authority, no wall-clock input).
 *
 * Deliberate conservatism (the DO has no filesystem to consult):
 * - glob/grep/find read a SCOPE, not a file — they carry no key and
 *   therefore serialize against exclusive calls (a scope read may overlap
 *   any file a same-batch write touches). Read-vs-read stays parallel.
 * - bash/eval/task/... have no path argument that bounds what they touch —
 *   unkeyed exclusive calls are batch barriers (they conflict with every
 *   non-detached call). The blocking wait/ask pair is detached instead:
 *   they park on in-DO wake channels, touch no file, and the t19
 *   photo-finish batch `[wait, write proc://<job>/kill]` only terminates
 *   when both dispatch together.
 * - keys are lexically normalized only (`./a` ≡ `a`); spellings that
 *   resolve to the same file but normalize apart (`/abs/x` vs `x`)
 *   under-lock in the worst case, never over-lock — the failure mode is
 *   lost parallelism, not a lost mutual exclusion.
 */

/** One batch member the scheduler orders. */
export interface BatchScheduleItem {
  executionId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/** Scheduling class of one batch member. */
export interface ScheduledCall {
  executionId: string;
  batchClass: BatchScheduleClass;
  key: string | null;
}

/** Registry row classification; unknown tools (mcp__*) are exclusive. */
export function batchScheduleClass(tool: string): BatchScheduleClass {
  return toolRegistryRow(tool)?.schedule ?? "exclusive";
}

/** Trailing read selector strip (`file.ts:50-100` reads the same file). */
const READ_SELECTOR = /:\d+(?:-\d+)?$/;

/**
 * Lexical path normalization for mutex keys: collapse duplicate slashes and
 * `.` segments, strip a trailing line-selector. `..` is NOT resolved (no
 * base to resolve against in the DO) — divergent spellings can only
 * over-serialize, never break exclusion.
 */
export function normalizeScheduleKey(raw: string): string {
  const withoutSelector = READ_SELECTOR.test(raw) ? raw.replace(READ_SELECTOR, "") : raw;
  const segments: string[] = [];
  for (const segment of withoutSelector.split("/")) {
    if (segment === "" || segment === ".") continue;
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * File-mutex key of one call: the journaled path argument for single-file
 * tools, the first input line for hashline edit (omp hashline input carries
 * the target path as its header), null for scope reads and everything
 * unkeyed. Null keys join the conservative barrier for exclusive calls.
 */
export function batchScheduleKey(tool: string, args: Record<string, unknown>): string | null {
  switch (tool) {
    case "read":
    case "write":
      return typeof args.path === "string" && args.path.length > 0
        ? normalizeScheduleKey(args.path)
        : null;
    case "edit": {
      const input = args.input;
      if (typeof input !== "string") return null;
      const newline = input.indexOf("\n");
      const header = (newline === -1 ? input : input.slice(0, newline)).trim();
      return header.length > 0 ? normalizeScheduleKey(header) : null;
    }
    default:
      // glob/grep/find scope reads and every unkeyed tool.
      return null;
  }
}

/**
 * Pairwise conflict: detached calls share no surface with the batch; two
 * reads never conflict; otherwise same non-null key conflicts (same-file
 * write/write + read/write) and any unkeyed participant conflicts with an
 * exclusive call.
 */
export function batchCallsConflict(a: ScheduledCall, b: ScheduledCall): boolean {
  if (a.batchClass === "detached" || b.batchClass === "detached") return false;
  if (a.batchClass === "read" && b.batchClass === "read") return false;
  if (a.key !== null && a.key === b.key) return true;
  return a.key === null || b.key === null;
}

/**
 * Order one batch into dispatch waves. Wave k dispatches only after every
 * wave < k settled; within a wave, executionIds keep the model's call
 * order (journal seq order — append happens before scheduling). Greedy
 * earliest-wave placement: each call lands one wave after its latest
 * conflicting predecessor, so independent calls share the first wave.
 */
export function scheduleBatch(items: BatchScheduleItem[]): string[][] {
  const waves: string[][] = [];
  const placed: { call: ScheduledCall; wave: number }[] = [];
  for (const item of items) {
    const call: ScheduledCall = {
      executionId: item.executionId,
      batchClass: batchScheduleClass(item.tool),
      key: batchScheduleKey(item.tool, item.arguments),
    };
    let wave = 0;
    for (const prior of placed) {
      if (batchCallsConflict(prior.call, call)) wave = Math.max(wave, prior.wave + 1);
    }
    placed.push({ call, wave });
    while (waves.length <= wave) waves.push([]);
    waves[wave]?.push(item.executionId);
  }
  return waves;
}
