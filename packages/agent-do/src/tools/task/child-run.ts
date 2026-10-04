import { executionIdFor } from "../../ids.js";
import type { AnyAgentEvent } from "../../fsm-events.js";
import {
  subagentIdentityOf,
  type SubagentIdentityRecord,
  MAX_OUTPUT_LINES,
} from "./types.js";

/**
 * M1.5 T17 child-run gate (proposal §3 T17) — the replay-pure fold over the
 * CHILD journal that decides what a subagent run does next. omp anchor:
 * executor.ts:2210 (MAX_YIELD_RETRIES=3), :2345-2375 (forced toolChoice),
 * :2372-2375 + docs/tools/task.md:186 (SYSTEM WARNING), yield.ts:272-285
 * (schema override + empty abort), :1673-1676/:2420-2424/:2524-2527
 * (yield-supersession — task semantics §7 "移植必抄").
 *
 * Everything here is a deterministic fold: driveTurn completion, a grandchild
 * completion callback and cold-start recovery all re-derive the same verdict
 * from the same log, so the ladder/supersession/settle decisions survive
 * eviction and replay (§1 replay-consistency default).
 */

/** omp yield.ts:28 format hint — the one string the ladder reuses verbatim. */
export const YIELD_FORMAT_HINT =
  'Submit success as {"data":<your output>} or failure as {"error":"message"}.';

/** omp docs/tools/task.md:186 verbatim — now WITH the T17 ladder clause. */
export const NO_YIELD_WARNING =
  "SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.";

/** 3-consecutive-empty-result abort (yield.ts:281-285 quality gate). */
export const EMPTY_YIELD_ABORT =
  "Subagent aborted: 3 consecutive empty yield submissions (yield quality gate).";

/** strict schemaMode: retries exhausted → the run fails, no override. */
export const STRICT_SCHEMA_FAILED =
  "Subagent failed: outputSchema validation failed 3 consecutive times (schemaMode strict).";

/** Tool-result marker prefix for a schema-failed yield (fold counts these). */
export const SCHEMA_VIOLATION_PREFIX = "outputSchema violation:";

/** Tool-result marker proving an accepted payload carries schemaOverridden. */
export const SCHEMA_OVERRIDE_MARKER = "schemaOverridden";

const SUPERSEDE_PREFIX =
  "[superseded] A background async-result arrived after your last yield; that yield is void. Submit a NEW yield that accounts for it. ";

const REMINDER_BODIES = [
  "Reminder 1/3: the run is still open — submit your final result with the `yield` tool now.",
  "Reminder 2/3: no usable yield received yet. Call `yield` before anything else.",
  "Final reminder (3/3): this attempt is forced — `yield` is the only permitted next call.",
];

/** omp MAX_YIELD_RETRIES (executor.ts:2210). */
export const MAX_YIELD_RETRIES = 3;

export function reminderText(attempt: number, stale: boolean): string {
  const body = REMINDER_BODIES[Math.min(attempt, MAX_YIELD_RETRIES) - 1] ?? REMINDER_BODIES[0];
  return `${stale ? SUPERSEDE_PREFIX : ""}${body} ${YIELD_FORMAT_HINT}`;
}

// ---------------------------------------------------------------------------
// Fold state
// ---------------------------------------------------------------------------

/** One accumulated incremental section (`type: string[]` yield call). */
export interface ChildSection {
  labels: string[];
  data?: unknown;
  callSeq: number;
}

/** The run's terminal yield (later calls win), with payload classification. */
export interface TerminalYield {
  callSeq: number;
  /** "error-form" delivers status error; the rest deliver ok. */
  form: "data" | "error" | "finalize";
  data?: unknown;
  error?: string;
  /** finalize form: the payload is the last assistant text before the call. */
  assistantText?: string;
  /** Accepted via the permissive 3-failure override (marker in the result). */
  schemaOverridden: boolean;
}

interface ReminderMarker {
  seq: number;
  inputId: string;
  turnId?: string;
  terminal?: "completed" | "failed" | "cancelled";
}

export interface ChildRunState {
  identity: SubagentIdentityRecord | undefined;
  /** Expected payload contract (identity row mirror of the spawn plan). */
  outputSchema: unknown;
  schemaMode: "permissive" | "strict";
  sections: ChildSection[];
  terminal: TerminalYield | undefined;
  reminders: ReminderMarker[];
  warning: string | undefined;
  completed: { status: "ok" | "error"; output: string } | undefined;
  /** A `task.async_result` landed after the terminal yield → it is void. */
  stale: boolean;
  /** Spawn plans of this run without a settlement (the park gate). */
  pendingSpawns: string[];
  /** Trailing yield submissions that carried no payload at all. */
  emptyStreak: number;
  /** Trailing yield payloads rejected by the outputSchema validator. */
  schemaFailStreak: number;
  /** Last non-empty assistant text (+ its call seq) — finalize-form payload. */
  lastAssistantText: { text: string; seq: number } | undefined;
  liveTurn: boolean;
  lastTurn: { terminal: "completed" | "failed" | "cancelled"; reason?: string } | undefined;
  events: readonly AnyAgentEvent[];
}

/**
 * The single-pass fold. Malformed rows are skipped like every other journal
 * projection (latestContextNotes precedent); ordering is seq order, which the
 * log guarantees (I1).
 */
export function projectChildRun(events: readonly AnyAgentEvent[]): ChildRunState {
  const identityRecord = subagentIdentityOf(events);
  const state: ChildRunState = {
    identity: identityRecord,
    outputSchema: identityRecord?.outputSchema,
    schemaMode: identityRecord?.schemaMode ?? "permissive",
    sections: [],
    terminal: undefined,
    reminders: [],
    warning: undefined,
    completed: undefined,
    stale: false,
    pendingSpawns: [],
    emptyStreak: 0,
    schemaFailStreak: 0,
    lastAssistantText: undefined,
    liveTurn: false,
    lastTurn: undefined,
    events,
  };

  const turnsByInputId = new Map<string, string>();
  const turnTerminal = new Map<string, "completed" | "failed" | "cancelled">();
  const turnFailedReason = new Map<string, string>();
  let lastTurnId: string | undefined;
  let lastAssistantText: { text: string; seq: number } | undefined;
  const pendingYieldCalls = new Map<string, { seq: number; args: YieldCallArgs }>();
  const asyncSeqs: number[] = [];
  const settledSpawns = new Set<string>();
  const plannedSpawns = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case "model.call_completed": {
        if (event.data.text !== "") {
          lastAssistantText = { text: event.data.text, seq: event.seq };
        }
        break;
      }
      case "turn.input": {
        turnsByInputId.set(event.data.inputId, event.data.turnId);
        lastTurnId = event.data.turnId;
        break;
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled": {
        const verdict =
          event.type === "turn.completed" ? "completed" : event.type === "turn.failed" ? "failed" : "cancelled";
        turnTerminal.set(event.data.turnId, verdict);
        if (event.type === "turn.failed") turnFailedReason.set(event.data.turnId, event.data.reason);
        break;
      }
      case "tool.call": {
        if (event.data.tool === "yield") {
          pendingYieldCalls.set(executionIdFor(event.threadId, event.seq), {
            seq: event.seq,
            args: event.data.arguments,
          });
        }
        break;
      }
      case "tool.result": {
        const call = pendingYieldCalls.get(event.data.executionId);
        if (call === undefined) break;
        foldYieldOutcome(
          state,
          call,
          event.data.status,
          typeof event.data.output === "string" ? event.data.output : "",
          lastAssistantText,
        );
        break;
      }
      case "task.spawn_planned": {
        plannedSpawns.add(event.data.spawnId);
        break;
      }
      case "task.spawn_settled": {
        settledSpawns.add(event.data.spawnId);
        break;
      }
      case "task.async_result": {
        asyncSeqs.push(event.seq);
        break;
      }
      case "task.yield_reminder": {
        state.reminders.push({ seq: event.seq, inputId: event.data.inputId });
        break;
      }
      case "task.yield_warning": {
        state.warning = event.data.text;
        break;
      }
      case "task.yield_completed": {
        state.completed = { status: event.data.status, output: event.data.output };
        break;
      }
      // Context-invisible rows for the fold (state events, foreign journal
      // families, transport bookkeeping) — enumerated for exhaustiveness.
      case "experimental_context_notes":
      case "job.delivered":
      case "job.registered":
      case "job.settled":
      case "model.call_failed":
      case "model.call_retry":
      case "model.call_sealed":
      case "model.call_started":
      case "model.delta":
      case "interaction.interrupted":
      case "interaction.registered":
      case "interaction.resolved":
      case "peer.message":
      case "peer.message_consumed":
      case "task.subagent_identity":
      case "thread.created":
      case "todo_phases":
      case "tool.dispatch":
      case "tool.exec_started":
      case "tool.output":
      case "turn.cancel_requested":
      case "turn.steer":
        break;
    }
  }

  for (const reminder of state.reminders) {
    const turnId = turnsByInputId.get(reminder.inputId);
    if (turnId !== undefined) {
      reminder.turnId = turnId;
      reminder.terminal = turnTerminal.get(turnId);
    }
  }
  state.pendingSpawns = [...plannedSpawns].filter((spawnId) => !settledSpawns.has(spawnId));
  const terminalCallSeq = state.terminal?.callSeq;
  state.stale =
    terminalCallSeq !== undefined && asyncSeqs.some((asyncSeq) => asyncSeq > terminalCallSeq);
  if (lastTurnId !== undefined) {
    const terminal = turnTerminal.get(lastTurnId);
    state.lastTurn =
      terminal === undefined
        ? undefined
        : {
            terminal,
            ...(turnFailedReason.has(lastTurnId) ? { reason: turnFailedReason.get(lastTurnId) } : {}),
          };
    state.liveTurn = terminal === undefined;
  }
  return state;
}

/** Raw yield arguments as journaled — the classifier narrows per field. */
type YieldCallArgs = Record<string, unknown>;

/** Classify one resolved yield call into the fold state (streaks/terminal/sections). */
function foldYieldOutcome(
  state: ChildRunState,
  call: { seq: number; args: YieldCallArgs },
  status: string,
  output: string,
  lastAssistantText: { text: string; seq: number } | undefined,
): void {
  const args = call.args;
  const errorText = typeof args.error === "string" && args.error !== "" ? args.error : undefined;
  const hasError = errorText !== undefined;
  const hasData = args.data !== undefined;
  const typeIsString = typeof args.type === "string";
  const labels = stringLabelArray(args.type);

  if (status === "ok") {
    // Any accepted yield resets both consecutive-failure streaks.
    state.emptyStreak = 0;
    state.schemaFailStreak = 0;
    if (labels !== undefined && !hasData && !hasError) {
      recordSection(state, labels, undefined, call.seq);
      return;
    }
    if (labels !== undefined) {
      // Labelled section WITH body content.
      recordSection(state, labels, args.data, call.seq);
      return;
    }
    if (hasError) {
      state.terminal = { callSeq: call.seq, form: "error", error: errorText, schemaOverridden: false };
      return;
    }
    if (hasData) {
      state.terminal = {
        callSeq: call.seq,
        form: "data",
        data: args.data,
        schemaOverridden: output.includes(SCHEMA_OVERRIDE_MARKER),
      };
      return;
    }
    if (typeIsString) {
      // finalize form: the payload is the last assistant turn.
      const assistant =
        lastAssistantText !== undefined && lastAssistantText.seq < call.seq
          ? lastAssistantText.text
          : undefined;
      state.terminal = {
        callSeq: call.seq,
        form: "finalize",
        ...(assistant === undefined ? {} : { assistantText: assistant }),
        schemaOverridden: false,
      };
      return;
    }
    return; // ok with nothing classifiable — treat as noise
  }

  // Rejected submissions extend exactly one streak; any other rejection
  // (shape errors, transport) breaks both consecutive runs.
  if (!hasData && !hasError && !typeIsString) {
    state.emptyStreak += 1;
    state.schemaFailStreak = 0;
    return;
  }
  if (hasData && output.startsWith(SCHEMA_VIOLATION_PREFIX)) {
    state.schemaFailStreak += 1;
    state.emptyStreak = 0;
    return;
  }
  state.emptyStreak = 0;
  state.schemaFailStreak = 0;
}

/** omp yield.ts:134-147 — a non-empty all-string array (type guard keeps the narrowing). */
function stringLabelArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return undefined;
  return value.every((label): label is string => typeof label === "string") ? value : undefined;
}

/**
 * omp "calls accumulate by section": a repeated label list UPDATES the
 * existing section in place (first-occurrence position, latest content)
 * instead of stacking a duplicate — the accumulated record is one entry per
 * distinct section, in first-submission order.
 */
function recordSection(
  state: ChildRunState,
  labels: string[],
  data: unknown,
  callSeq: number,
): void {
  const key = labels.join("\u0000");
  const existing = state.sections.find((section) => section.labels.join("\u0000") === key);
  if (existing === undefined) {
    state.sections.push({ labels, ...(data === undefined ? {} : { data }), callSeq });
    return;
  }
  existing.callSeq = callSeq;
  if (data === undefined) delete existing.data;
  else existing.data = data;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type ChildRunVerdict =
  | { kind: "noop"; reason: string }
  | { kind: "remind"; text: string; forced: boolean; reuseInputId?: string }
  | { kind: "settle"; status: "ok" | "error"; output: string };

/**
 * The run-end decision, derived purely from the fold. Order matters:
 * settled-marker → live turn → failed/cancelled turn → quality gates
 * (empty abort, strict schema) → settle-or-ladder on the active/stale yield.
 */
export function childRunVerdict(state: ChildRunState): ChildRunVerdict {
  if (state.identity === undefined) return { kind: "noop", reason: "not a subagent" };
  if (state.completed !== undefined) return { kind: "noop", reason: "run already settled" };
  if (state.liveTurn) return { kind: "noop", reason: "reminder/assignment turn still live" };
  if (state.lastTurn?.terminal === "cancelled") {
    return { kind: "settle", status: "error", output: "Subagent run cancelled before yielding." };
  }
  if (state.lastTurn?.terminal === "failed") {
    return {
      kind: "settle",
      status: "error",
      output: `Subagent run failed (${state.lastTurn.reason ?? "unknown"}) before yielding.`,
    };
  }
  if (state.emptyStreak >= MAX_YIELD_RETRIES) {
    return { kind: "settle", status: "error", output: EMPTY_YIELD_ABORT };
  }
  if (state.schemaMode === "strict" && state.schemaFailStreak >= MAX_YIELD_RETRIES) {
    return { kind: "settle", status: "error", output: STRICT_SCHEMA_FAILED };
  }

  const superseded = state.terminal !== undefined && state.stale;
  if (state.terminal !== undefined && !superseded) {
    if (state.pendingSpawns.length > 0) {
      // omp executor.ts:2420-2424 — only a yield with no pending owner work
      // is terminal; the grandchild settlements re-kick this verdict.
      return { kind: "noop", reason: `parked: ${state.pendingSpawns.length} pending owned spawn(s)` };
    }
    return {
      kind: "settle",
      ...renderYieldDelivery({ terminal: state.terminal, sections: state.sections }),
    };
  }

  // No usable yield (none yet, or a stale one voided by a late async-result):
  // omp re-runs the reminder ladder demanding a yield that accounts for the
  // background results (executor.ts:1673-1676, :2420-2424).
  const cycleBase = state.terminal?.callSeq ?? Number.NEGATIVE_INFINITY;
  const cycle = state.reminders.filter((reminder) => reminder.seq > cycleBase);
  const stale = superseded;
  if (cycle.length >= MAX_YIELD_RETRIES) {
    return { kind: "settle", status: "error", output: NO_YIELD_WARNING };
  }
  if (cycle.length > 0) {
    const last = cycle[cycle.length - 1];
    if (last !== undefined) {
      if (last.turnId === undefined) {
        // Marker appended, crash before the turn drove: re-send the SAME
        // reminder turn (inputId dedup makes this idempotent).
        const attempt = cycle.length;
        return {
          kind: "remind",
          text: reminderText(attempt, stale),
          forced: attempt >= MAX_YIELD_RETRIES,
          reuseInputId: last.inputId,
        };
      }
      if (last.terminal === undefined) {
        return { kind: "noop", reason: "reminder turn still live" };
      }
      // Driven and terminal without a usable yield → next tier below.
    }
  }
  const attempt = cycle.length + 1;
  return {
    kind: "remind",
    text: reminderText(attempt, stale),
    forced: attempt >= MAX_YIELD_RETRIES,
  };
}

// ---------------------------------------------------------------------------
// Delivery rendering
// ---------------------------------------------------------------------------

/**
 * Render the settled result the parent receives: accumulated incremental
 * sections first, then the terminal payload (data JSON, error text, or the
 * finalize form's last assistant turn), plus the schemaOverridden warning
 * when the payload rode the permissive override in.
 */
export function renderYieldDelivery(state: {
  terminal: TerminalYield;
  sections: ChildSection[];
}): { status: "ok" | "error"; output: string } {
  const terminal = state.terminal;
  if (terminal.form === "error") {
    return { status: "error", output: terminal.error ?? "" };
  }
  const payload =
    terminal.form === "finalize"
      ? terminal.assistantText ?? "(no assistant text before yield)"
      : typeof terminal.data === "string"
        ? terminal.data
        : JSON.stringify(terminal.data, null, 2);
  const parts: string[] = [];
  for (const section of state.sections) {
    const heading = `## ${section.labels.join(" / ")}`;
    if (section.data === undefined) parts.push(heading);
    else {
      const body = typeof section.data === "string" ? section.data : JSON.stringify(section.data, null, 2);
      parts.push(`${heading}\n\n${body}`);
    }
  }
  parts.push(payload);
  let output = parts.join("\n\n");
  if (terminal.schemaOverridden) {
    output += `\n\n[WARNING] ${SCHEMA_OVERRIDE_MARKER}: payload failed outputSchema validation ${MAX_YIELD_RETRIES} times and was accepted under schemaMode permissive.`;
  }
  return { status: "ok", output };
}

// ---------------------------------------------------------------------------
// Artifacts — the <id>.md / <id>.jsonl sidecar render helpers
// ---------------------------------------------------------------------------

/** The child journal as JSONL (one `{seq,type,data}` per line). */
export function renderJournalJsonl(events: readonly AnyAgentEvent[]): string {
  const lines = events.map((event) => JSON.stringify({ seq: event.seq, type: event.type, data: event.data }));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

const HISTORY_LINE_CAP = 200;

/** omp history:// semantics: compact transcript, readable live or parked. */
export function renderAgentHistory(events: readonly AnyAgentEvent[], agentId: string): string {
  const toolNameByExecutionId = new Map<string, string>();
  const lines: string[] = [`transcript ${agentId} — ${events.length} events`];
  const cap = (text: string): string =>
    text.length > HISTORY_LINE_CAP ? `${text.slice(0, HISTORY_LINE_CAP)}…` : text;
  for (const event of events) {
    switch (event.type) {
      case "task.subagent_identity":
        lines.push(`[${event.seq}] identity ${event.data.agentId} depth=${event.data.depth}`);
        break;
      case "turn.input":
        lines.push(`[${event.seq}] input: ${cap(event.data.content.map((part) => part.text).join(" "))}`);
        break;
      case "turn.steer":
        lines.push(`[${event.seq}] steer: ${cap(event.data.content.map((part) => part.text).join(" "))}`);
        break;
      case "model.call_completed": {
        const tools = event.data.toolCalls.map((call) => call.name).join(", ");
        lines.push(
          `[${event.seq}] assistant: ${cap(event.data.text)}${tools === "" ? "" : ` | tools: ${tools}`}`,
        );
        break;
      }
      case "tool.call":
        toolNameByExecutionId.set(executionIdFor(event.threadId, event.seq), event.data.tool);
        break;
      case "tool.result": {
        const tool = toolNameByExecutionId.get(event.data.executionId) ?? "unknown";
        const output = typeof event.data.output === "string" ? event.data.output : "(blob)";
        lines.push(`[${event.seq}] ${tool} → ${event.data.status}: ${cap(output)}`);
        break;
      }
      case "task.spawn_planned":
        lines.push(`[${event.seq}] spawn ${event.data.agentId} (${event.data.mode})`);
        break;
      case "task.spawn_settled":
        lines.push(`[${event.seq}] spawn-settled ${event.data.agentId} ${event.data.status}`);
        break;
      case "task.async_result":
        lines.push(
          `[${event.seq}] async-result ${event.data.agentId} ${event.data.status}: ${cap(event.data.output)}`,
        );
        break;
      case "task.yield_reminder":
        lines.push(`[${event.seq}] yield-reminder (inputId ${event.data.inputId})`);
        break;
      case "task.yield_warning":
        lines.push(`[${event.seq}] ${event.data.text}`);
        break;
      case "task.yield_completed":
        lines.push(`[${event.seq}] settled ${event.data.status}: ${cap(event.data.output)}`);
        break;
      case "experimental_context_notes":
      case "job.delivered":
      case "job.registered":
      case "job.settled":
      case "model.call_failed":
      case "model.call_retry":
      case "model.call_sealed":
      case "model.call_started":
      case "model.delta":
      case "interaction.interrupted":
      case "interaction.registered":
      case "interaction.resolved":
      case "peer.message":
      case "peer.message_consumed":
      case "thread.created":
      case "todo_phases":
      case "tool.dispatch":
      case "tool.exec_started":
      case "tool.output":
      case "turn.cancel_requested":
      case "turn.cancelled":
      case "turn.completed":
      case "turn.failed":
        break;
    }
  }
  const capped = lines.slice(0, MAX_OUTPUT_LINES);
  if (capped.length < lines.length) capped.push(`… [truncated at ${MAX_OUTPUT_LINES} lines]`);
  return `${capped.join("\n")}\n`;
}
