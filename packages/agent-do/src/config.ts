/**
 * Watchdog / batching policy for the agent DO (unified-turn-state.md §5.1).
 *
 * All values are soft deadlines: the alarm is a backstop with ~1 minute of
 * scheduling jitter, never the real-time path. The config is persisted per DO
 * (`storage.kv`) so it survives eviction and replays deterministically.
 */

import { z } from "zod";

export const WATCHDOG_CONFIG_KV_KEY = "watchdog-config";

export interface WatchdogConfig {
  /** Model-call cap: single outbound op platform limit (§5.1). */
  modelCallCapMs: number;
  /** Default per-tool-call execution timeout, overridable per tool.call. */
  execTimeoutMs: number;
  /** Transport grace added on top of the exec timeout before re-asking. */
  execGraceMs: number;
  /** Total turn backstop: stuck turns get explicit failure past this. */
  turnWatchdogMs: number;
  /** Pre-first-byte provider failures retried with backoff, at most N (§4.2). */
  maxPreFirstByteRetries: number;
  /** Retry backoff base (exponential: base * 2^(attempt-1)). */
  retryBackoffBaseMs: number;
  /** model.delta merge batching: flush after this many bytes… */
  deltaFlushBytes: number;
  /** …or this much wall time, whichever first (§1.1 "合并批量"). */
  deltaFlushMs: number;
  /** Payloads above this size bypass the log into R2 (§1.1). */
  r2BypassBytes: number;
  /** Per-execution re-ask cap before the turn watchdog owns the decision. */
  maxDispatchAttempts: number;
  /**
   * Wait safety cap (M1.5 T2; omp wait.ts:25 WAIT_MAX_MS). No
   * caller-selectable timeout (omp docs/tools/wait.md:16) — this is
   * deployment-time input only, never model-reachable.
   */
  waitMaxMs: number;
  /** Message-only wait window ladder (omp docs/tools/wait.md:17). */
  peerWaitLadderMs: number[];
  /** Consecutive-wait gap that resets the ladder (omp wait.md:17, ≥60s). */
  peerLadderResetGapMs: number;
  /**
   * Task-cluster knobs (M1.5 T16; omp task/settings.ts anchors). Depth cap
   * mirrors omp task.maxRecursionDepth (default 2, <0 disables); async
   * mirrors omp async.enabled (non-blocking spawns go background when on).
   */
  taskMaxRecursionDepth: number;
  taskAsyncEnabled: boolean;
  /** omp task/types.ts:29-32 delivery caps (PI_TASK_MAX_OUTPUT_*). */
  taskMaxOutputBytes: number;
  taskMaxOutputLines: number;
  /** omp result-summary.ts:16 inline summary threshold. */
  taskInlineSummaryCapChars: number;
  /**
   * T18 batch/concurrency/budget knobs (omp task/settings.ts anchors).
   * maxConcurrency mirrors omp task.maxConcurrency (default 32, 0 = no
   * cap) — session-level, resized in place, unified across calls.
   */
  taskMaxConcurrency: number;
  /**
   * omp task.softRequestBudget (default 200): the session notice lands at
   * the budget; 1.5× hard-stops the run forcing a terminal yield that still
   * delivers partial findings.
   */
  taskSoftRequestBudget: number;
  /** omp task.maxRuntimeMs (default 0 = off): wall-clock hard stop. */
  taskMaxRuntimeMs: number;
  /**
   * Ask cap (M1.5 T4; omp settings `ask.timeout`, docs/tools/ask.md §Limits:
   * "defaults to 0 seconds (disabled)"). 0 = no cap — a pending interaction
   * suspends the turn watchdog until resolved or interrupted; a non-zero
   * value arms the alarm-carried auto-select expiry.
   */
  askTimeoutMs: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  modelCallCapMs: 15 * 60_000,
  execTimeoutMs: 10 * 60_000,
  execGraceMs: 5 * 60_000,
  turnWatchdogMs: 30 * 60_000,
  maxPreFirstByteRetries: 2,
  retryBackoffBaseMs: 500,
  deltaFlushBytes: 2048,
  deltaFlushMs: 100,
  r2BypassBytes: 100 * 1024,
  maxDispatchAttempts: 5,
  waitMaxMs: 30 * 60_000,
  peerWaitLadderMs: [5_000, 10_000, 30_000, 60_000, 300_000],
  peerLadderResetGapMs: 60_000,
  taskMaxRecursionDepth: 2,
  taskAsyncEnabled: true,
  taskMaxOutputBytes: 500_000,
  taskMaxOutputLines: 5000,
  taskInlineSummaryCapChars: 5000,
  taskMaxConcurrency: 32,
  taskSoftRequestBudget: 200,
  taskMaxRuntimeMs: 0,
  askTimeoutMs: 0,
};

const configPatchSchema = z.object({
  modelCallCapMs: z.number().int().positive().optional(),
  execTimeoutMs: z.number().int().positive().optional(),
  execGraceMs: z.number().int().nonnegative().optional(),
  turnWatchdogMs: z.number().int().positive().optional(),
  maxPreFirstByteRetries: z.number().int().nonnegative().optional(),
  retryBackoffBaseMs: z.number().int().nonnegative().optional(),
  deltaFlushBytes: z.number().int().positive().optional(),
  deltaFlushMs: z.number().int().positive().optional(),
  r2BypassBytes: z.number().int().positive().optional(),
  maxDispatchAttempts: z.number().int().positive().optional(),
  waitMaxMs: z.number().int().positive().optional(),
  peerWaitLadderMs: z.array(z.number().int().positive()).min(1).optional(),
  peerLadderResetGapMs: z.number().int().positive().optional(),
  taskMaxRecursionDepth: z.number().int().optional(),
  taskAsyncEnabled: z.boolean().optional(),
  taskMaxOutputBytes: z.number().int().positive().optional(),
  taskMaxOutputLines: z.number().int().positive().optional(),
  taskInlineSummaryCapChars: z.number().int().positive().optional(),
  taskMaxConcurrency: z.number().int().nonnegative().optional(),
  taskSoftRequestBudget: z.number().int().positive().optional(),
  taskMaxRuntimeMs: z.number().int().nonnegative().optional(),
  askTimeoutMs: z.number().int().nonnegative().optional(),
});

export type WatchdogConfigPatch = z.infer<typeof configPatchSchema>;

export function mergeWatchdogConfig(
  base: WatchdogConfig,
  patch: WatchdogConfigPatch,
): WatchdogConfig {
  return { ...base, ...patch };
}

export function parseWatchdogConfigPatch(input: unknown): WatchdogConfigPatch {
  return configPatchSchema.parse(input);
}

export function decodeWatchdogConfig(
  raw: string | undefined,
  base: WatchdogConfig,
): WatchdogConfig {
  if (raw === undefined || raw === "") return base;
  return mergeWatchdogConfig(base, parseWatchdogConfigPatch(JSON.parse(raw)));
}

// ---------------------------------------------------------------------------
// Experimental tool gates (#150) — omp gates five tools behind config flags
// that all default false (tools/index.ts:766-772, session/settings.ts:246-249,
// context-settings.ts:66-69): think = cfgExternalThinking, context_notes +
// new_context = cfgCompactionExperimentalContextManagement, checkpoint +
// rewind = cfgCheckpointEnabled. T1/T3 shipped them ungated; this restores
// the omp posture: deployment-time env inputs (#102 patch-over-defaults
// pattern), all default OFF.
// ---------------------------------------------------------------------------

export interface ExperimentalToolConfig {
  /** omp cfgExternalThinking — gates `think` (paired with forceReasoningOff). */
  externalThinking: boolean;
  /** omp cfgCompactionExperimentalContextManagement — gates context_notes + new_context. */
  contextNotes: boolean;
  /** omp cfgCheckpointEnabled — gates checkpoint + rewind. */
  checkpoint: boolean;
}

export const DEFAULT_EXPERIMENTAL_TOOL_CONFIG: ExperimentalToolConfig = {
  externalThinking: false,
  contextNotes: false,
  checkpoint: false,
};

function envFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

/** Deployment env → gate config (#102 patch-over-defaults pattern). */
export function decodeExperimentalToolConfig(env: {
  AGENT_DO_EXTERNAL_THINKING?: string;
  AGENT_DO_CONTEXT_NOTES?: string;
  AGENT_DO_CHECKPOINT?: string;
}): ExperimentalToolConfig {
  return {
    externalThinking: envFlag(env.AGENT_DO_EXTERNAL_THINKING),
    contextNotes: envFlag(env.AGENT_DO_CONTEXT_NOTES),
    checkpoint: envFlag(env.AGENT_DO_CHECKPOINT),
  };
}
