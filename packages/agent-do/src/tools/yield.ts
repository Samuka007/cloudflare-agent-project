import type { EdgeToolResult } from "./edge.js";
import type { AnyAgentEvent } from "../fsm-events.js";
import {
  projectChildRun,
  SCHEMA_VIOLATION_PREFIX,
  SCHEMA_OVERRIDE_MARKER,
  MAX_YIELD_RETRIES,
  YIELD_FORMAT_HINT,
} from "./task/child-run.js";
import { validateAgainstJsonSchema } from "./task/schema-validate.js";

/**
 * M1.5 T17 full yield semantics (proposal §3 T17): the child's only terminal
 * channel. omp anchor `T:yield.ts` — wire shape {type?, data?, error?}
 * (yield.ts:262-269, `required: []`), the format hint (:28), mutual
 * exclusivity of data/error (:166-175), incremental `type: string[]` section
 * accumulation, the string-`type` finalize form, the outputSchema quality
 * gate (:272-278 — permissive accepts an invalid payload with
 * `schemaOverridden` after 3 consecutive failures, strict fails) and the
 * empty-result abort (:281-285). The reminder ladder and supersession are
 * the DO's driver decision (tools/task/child-run.ts childRunVerdict); this
 * tool is the per-call verdict surface.
 */

/** omp yield.ts:28 verbatim. */
export { YIELD_FORMAT_HINT };

export interface YieldToolArgs {
  /** Incremental section labels (string[]) vs a terminal type string. */
  type?: string | string[];
  data?: unknown;
  /** Failure reason; mutually exclusive with data (omp yield.ts:266). */
  error?: string;
}

/** The DO-bound fold source — the yield verdict reads the child journal. */
export interface YieldToolContext {
  /** Sync in tests (the fold source is an in-memory array), async in the DO. */
  events(): AnyAgentEvent[] | Promise<AnyAgentEvent[]>;
}

/** omp yield.ts:134-147 — a string, or a non-empty all-string array. */
function isYieldType(value: unknown): value is string | string[] {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string"))
  );
}

export async function runYieldTool(
  args: YieldToolArgs,
  ctx: YieldToolContext | undefined,
): Promise<EdgeToolResult> {
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
  if (args.error !== undefined && !hasError) {
    return { status: "error", output: "error must be a non-empty string when present." };
  }

  // Incremental sections: `type: string[]` labels accumulate (data optional
  // as the section body). Never terminal; the ladder keeps running until a
  // terminal form lands.
  if (Array.isArray(args.type)) {
    if (hasError) {
      return {
        status: "error",
        output: `${YIELD_FORMAT_HINT} incremental section calls (type: string[]) cannot carry an error.`,
      };
    }
    return { status: "ok", output: "Section recorded." };
  }

  // No payload at all: an empty submission. Not a usable yield — the fold
  // counts consecutive empties and aborts the run at the third.
  if (!hasData && !hasError && typeof args.type !== "string") {
    return { status: "error", output: YIELD_FORMAT_HINT };
  }

  // error-form / finalize-form: terminal without a structured payload.
  if (!hasData) {
    if (typeof args.type === "string" && ctx !== undefined) {
      const gate = projectChildRun(await ctx.events());
      if (gate.lastAssistantText === undefined) {
        return {
          status: "error",
          output: `${YIELD_FORMAT_HINT} finalize form (type string without data) needs a prior assistant turn to deliver; include data instead.`,
        };
      }
    }
    return { status: "ok", output: "Result submitted." };
  }

  // data-form: enforce the outputSchema contract when the spawn declared one
  // (task semantics §1.2: permissive retries exhausted → invalid payload
  // accepted with schemaOverridden; strict fails).
  if (ctx === undefined) return { status: "ok", output: "Result submitted." };
  const gate = projectChildRun(await ctx.events());
  if (gate.outputSchema === undefined) return { status: "ok", output: "Result submitted." };
  const violations = validateAgainstJsonSchema(args.data, gate.outputSchema);
  if (violations.length === 0) return { status: "ok", output: "Result submitted." };

  const priorFailures = gate.schemaFailStreak;
  const violationText = `${SCHEMA_VIOLATION_PREFIX} ${violations.join("; ")}`;
  if (priorFailures >= MAX_YIELD_RETRIES) {
    if (gate.schemaMode === "strict") {
      return {
        status: "error",
        output: `${violationText} — schemaMode strict: the run fails after ${MAX_YIELD_RETRIES} consecutive validation failures; no override.`,
      };
    }
    return {
      status: "ok",
      output: `Result submitted. (${SCHEMA_OVERRIDE_MARKER}: payload failed outputSchema validation ${MAX_YIELD_RETRIES} consecutive times and is accepted under schemaMode permissive)`,
    };
  }
  const nextRejection = priorFailures + 1;
  const overrideNote =
    gate.schemaMode === "permissive" && nextRejection === MAX_YIELD_RETRIES
      ? ` The next invalid submission will be accepted with ${SCHEMA_OVERRIDE_MARKER} (schemaMode permissive).`
      : gate.schemaMode === "strict"
        ? ` schemaMode strict: ${MAX_YIELD_RETRIES} consecutive failures fail the run.`
        : "";
  return {
    status: "error",
    output: `${violationText} Fix the payload and re-yield (rejection ${nextRejection}/${MAX_YIELD_RETRIES}).${overrideNote}`,
  };
}
