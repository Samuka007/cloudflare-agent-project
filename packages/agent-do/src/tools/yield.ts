import type { EdgeToolResult } from "./edge.js";

/**
 * M1.5 T16 minimal yield gate (proposal §3 T16): the child's only terminal
 * channel. omp anchor `T:yield.ts` — wire shape {type?, data?, error?}
 * (yield.ts:262-269, `required: []`), the format hint (:28) and the mutual
 * exclusivity of data/error (:166-175 "never a usable failure reason" rule).
 *
 * Deliberately NOT here (T17, proposal §3 T17): the reminder ladder
 * (≤3 + forced toolChoice), yield-supersession, `type: string[]` incremental
 * accumulation, schema validation/outputSchema, and the `agent://` artifact
 * sidecars. T16 requires exactly one terminal yield per child run; the
 * child-completion projection (agent-do.ts completeSpawnToParent) takes the
 * LAST terminal yield call as THE result and settles the run failed when
 * there is none.
 */

/** omp yield.ts:28 verbatim. */
export const YIELD_FORMAT_HINT =
  'Submit success as {"data":<your output>} or failure as {"error":"message"}.';

export interface YieldToolArgs {
  /** Incremental section labels (string[]) vs a terminal type string. */
  type?: string | string[];
  data?: unknown;
  /** Failure reason; mutually exclusive with data (omp yield.ts:266). */
  error?: string;
}

/** omp yield.ts:134-147 — a string, or a non-empty all-string array. */
function isYieldType(value: unknown): value is string | string[] {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string"))
  );
}

/**
 * Minimal-gate execute: omp-verbatim shape validation, journal is the only
 * side effect (the tool.call/tool.result rows ARE the yield record — the
 * completion projection folds them; there is no separate yield journal
 * family in T16). Incremental (`type: string[]`) calls acknowledge without
 * accumulating — accumulation semantics land with T17.
 */
export function runYieldTool(args: YieldToolArgs): EdgeToolResult {
  if (args.type !== undefined && !isYieldType(args.type)) {
    return { status: "error", output: "type must be a string or non-empty array of strings" };
  }
  const hasData = args.data !== undefined;
  const hasError = args.error !== undefined && args.error !== "";
  if (hasData && hasError) {
    return {
      status: "error",
      output: `${YIELD_FORMAT_HINT} data and error are mutually exclusive.`,
    };
  }
  if (!hasData && !hasError) {
    return { status: "error", output: YIELD_FORMAT_HINT };
  }
  if (args.error !== undefined && !hasError) {
    return { status: "error", output: "error must be a non-empty string when present." };
  }
  return { status: "ok", output: "Result submitted." };
}

/**
 * Child-completion projection: render the terminal yield payload into the
 * settlement text. `data` stringifies; a bare string passes through; an
 * `error` yield IS the failure text (omp error field semantics). Callers
 * apply the delivery caps afterwards (settleSpawn).
 */
export function renderYieldOutput(yielded: { data?: unknown; error?: string }): {
  status: "ok" | "error";
  output: string;
} {
  if (yielded.error !== undefined) return { status: "error", output: yielded.error };
  if (typeof yielded.data === "string") return { status: "ok", output: yielded.data };
  return { status: "ok", output: JSON.stringify(yielded.data, null, 2) };
}
