import type { AnyAgentEvent } from "./fsm-events.js";
import { executionIdFor } from "./ids.js";
import type { WatchdogConfig } from "./config.js";

/**
 * Turn/execution FSM state, derived exclusively by replaying the event log
 * (§0 iron rule 2: "重放即真相"). One reducer, `applyEvent`, is shared by
 * cold-start replay, live appends and the watchdog, so live state and
 * rebuilt state are equal by construction (I14 pins this with a test).
 */

export class FsmViolationError extends Error {
  constructor(message: string) {
    super(`FSM violation: ${message}`);
    this.name = "FsmViolationError";
  }
}

export type TurnFsmStatus =
  "queued" | "model_call" | "tools_running" | "cancelling" | "completed" | "failed" | "cancelled";

export const TERMINAL_TURN_STATUSES: readonly TurnFsmStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export type ExecutionStatus =
  | "called"
  | "dispatched"
  | "running"
  | "ok"
  | "error"
  | "timeout"
  | "cancelled"
  | "outcome_unknown";

export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "ok",
  "error",
  "timeout",
  "cancelled",
  "outcome_unknown",
];

export interface TurnRuntime {
  turnId: string;
  inputSeq: number;
  inputCreatedAt: number;
  inputId: string;
  status: TurnFsmStatus;
  steerSeqs: number[];
  consumedSteerSeqs: number[];
  modelCallIds: number[];
  executionIds: string[];
  failedReason?: string;
}

export interface ModelCallRuntime {
  modelCallId: number;
  turnId: string;
  status: "running" | "completed" | "sealed" | "failed";
  startedAt: number;
  deltaChars: number;
  aborted: boolean;
}

export interface ExecutionRuntime {
  executionId: string;
  callSeq: number;
  turnId: string;
  /** Registry tool name from the tool.call row (edge routing + wait caps). */
  tool: string;
  status: ExecutionStatus;
  attempts: number;
  dispatchSeqs: number[];
  lastDispatchAt: number | null;
  /** tool.call journal timestamp — wait-cap deadlines derive from it. */
  callCreatedAt: number;
  timeoutMs: number;
  execStarted: boolean;
  lastOutputOffset: number;
  resultSeq: number | null;
}

/** Journal-folded pending-interaction row (M1.5 T4; replay truth). */
export interface InteractionRuntime {
  interactionId: string;
  turnId: string;
  executionId: string;
  status: "pending" | "resolved" | "interrupted";
  /** Non-null only on the pending→bounded row (omp ask.timeout). */
  expiresAt: number | null;
}

export interface ReplayState {
  threadId: string | null;
  title: string | null;
  machineId: string | null;
  threadCreatedAt: number | null;
  latestSeq: number;
  eventCount: number;
  activeTurnId: string | null;
  turns: Map<string, TurnRuntime>;
  /** inputId (and steer inputIds) → consuming turn, for input dedup (I2/I8). */
  inputIds: Map<string, { turnId: string; kind: "input" | "steer"; seq: number }>;
  /** Keyed by modelCallId = the `model.call_started` event seq (§0). */
  modelCalls: Map<number, ModelCallRuntime>;
  executions: Map<string, ExecutionRuntime>;
  /**
   * The child-journal `task.subagent_identity` row (M1.5 T16) — a subagent
   * DO's replay-derivable self-knowledge: subagent wire surface, depth
   * verdict and the parent-completion hook all read this. null for Main.
   */
  subagentIdentity: {
    spawnId: string;
    agentId: string;
    parentThreadId: string;
    sourceThreadId: string | null;
    originKind: string | null;
    depth: number;
    /** T17 structured contract mirrored from the spawn plan (optional). */
    outputSchema?: unknown;
    schemaMode?: "permissive" | "strict";
  } | null;
  /**
   * The identity row's journal timestamp (T18 wall-clock budget origin) —
   * the fold-level twin of SubagentIdentityRecord.createdAt. null for Main.
   */
  identityCreatedAt: number | null;
  /**
   * Pending interactions (M1.5 T4 ask) — the journal-folded SPA-visible ask
   * state, keyed by interactionId (tools/ask.ts projectInteractions).
   */
  interactions: Map<string, InteractionRuntime>;
}

export function emptyReplayState(): ReplayState {
  return {
    threadId: null,
    title: null,
    machineId: null,
    threadCreatedAt: null,
    latestSeq: 0,
    eventCount: 0,
    activeTurnId: null,
    turns: new Map(),
    inputIds: new Map(),
    modelCalls: new Map(),
    executions: new Map(),
    subagentIdentity: null,
    identityCreatedAt: null,
    interactions: new Map(),
  };
}

export function replayEvents(events: readonly AnyAgentEvent[]): ReplayState {
  const state = emptyReplayState();
  for (const event of events) applyEvent(state, event);
  return state;
}

function turn(state: ReplayState, turnId: string): TurnRuntime {
  const runtime = state.turns.get(turnId);
  if (runtime === undefined) {
    throw new FsmViolationError(`unknown turn ${turnId} at seq ${state.latestSeq}`);
  }
  return runtime;
}

function requireActive(state: ReplayState): TurnRuntime {
  if (state.activeTurnId === null) {
    throw new FsmViolationError(`no active turn at seq ${state.latestSeq}`);
  }
  return turn(state, state.activeTurnId);
}

function requireNonTerminal(runtime: TurnRuntime): void {
  if (TERMINAL_TURN_STATUSES.includes(runtime.status)) {
    throw new FsmViolationError(`turn ${runtime.turnId} already ${runtime.status}`);
  }
}

function requireCall(state: ReplayState, turnId: string, modelCallId: number): ModelCallRuntime {
  const call = state.modelCalls.get(modelCallId);
  if (call?.turnId !== turnId) {
    throw new FsmViolationError(`unknown modelCallId ${modelCallId} for turn ${turnId}`);
  }
  return call;
}

/** Call lookup by id alone — for events whose turn may already be terminal. */
function requireCallOf(state: ReplayState, modelCallId: number): ModelCallRuntime {
  const call = state.modelCalls.get(modelCallId);
  if (call === undefined) {
    throw new FsmViolationError(`unknown modelCallId ${modelCallId} at seq ${state.latestSeq}`);
  }
  return call;
}

/** Mutate `state` by one event, enforcing every FSM transition guard. */
export function applyEvent(state: ReplayState, event: AnyAgentEvent): void {
  state.latestSeq = event.seq;
  state.eventCount += 1;
  switch (event.type) {
    case "thread.created": {
      const { title, machineId } = event.data;
      if (state.threadId !== null) {
        throw new FsmViolationError("duplicate thread.created");
      }
      state.threadId = event.threadId;
      state.title = title;
      state.machineId = machineId;
      state.threadCreatedAt = event.createdAt;
      return;
    }
    case "turn.input": {
      const { turnId, inputId } = event.data;
      if (state.activeTurnId !== null) {
        throw new FsmViolationError(
          `turn.input for ${turnId} while ${state.activeTurnId} active — input must become turn.steer`,
        );
      }
      state.turns.set(turnId, {
        turnId,
        inputSeq: event.seq,
        inputCreatedAt: event.createdAt,
        inputId,
        status: "queued",
        steerSeqs: [],
        consumedSteerSeqs: [],
        modelCallIds: [],
        executionIds: [],
      });
      state.inputIds.set(inputId, { turnId, kind: "input", seq: event.seq });
      state.activeTurnId = turnId;
      return;
    }
    case "turn.steer": {
      const runtime = requireActive(state);
      requireNonTerminal(runtime);
      const inputId = event.data.inputId;
      if (state.inputIds.has(inputId)) {
        throw new FsmViolationError(`duplicate inputId ${inputId}`);
      }
      runtime.steerSeqs.push(event.seq);
      state.inputIds.set(inputId, {
        turnId: runtime.turnId,
        kind: "steer",
        seq: event.seq,
      });
      return;
    }
    case "model.call_started": {
      const runtime = requireActive(state);
      requireNonTerminal(runtime);
      const { consumedSteerSeqs } = event.data;
      if (runtime.status !== "queued" && runtime.status !== "tools_running") {
        throw new FsmViolationError(`model.call_started from ${runtime.status}`);
      }
      for (const seq of consumedSteerSeqs) {
        if (!runtime.consumedSteerSeqs.includes(seq)) runtime.consumedSteerSeqs.push(seq);
      }
      const modelCallId = event.seq;
      runtime.modelCallIds.push(modelCallId);
      state.modelCalls.set(modelCallId, {
        modelCallId,
        turnId: runtime.turnId,
        status: "running",
        startedAt: event.createdAt,
        deltaChars: 0,
        aborted: false,
      });
      runtime.status = "model_call";
      return;
    }
    case "model.delta": {
      const runtime = requireActive(state);
      const call = requireCall(state, runtime.turnId, event.data.modelCallId);
      if (call.status !== "running") {
        throw new FsmViolationError(`model.delta on ${call.status} call ${call.modelCallId}`);
      }
      const text = event.data.text;
      call.deltaChars +=
        typeof text === "string" ? new TextEncoder().encode(text).byteLength : text.__blob__.size;
      return;
    }
    case "model.call_completed": {
      const runtime = requireActive(state);
      const call = requireCall(state, runtime.turnId, event.data.modelCallId);
      if (call.status !== "running") {
        throw new FsmViolationError(`call_completed on ${call.status} call`);
      }
      call.status = "completed";
      const toolCalls = event.data.toolCalls;
      if (toolCalls.length > 0) runtime.status = "tools_running";
      return;
    }
    case "model.call_sealed":
    case "model.call_failed": {
      // Watchdog expiry appends turn.failed BEFORE aborting the in-flight
      // call, so the cancellation echo (model.call_failed{aborted}, or a
      // racing alarm seal) legitimately lands after the terminal row. The
      // call row must still exist and be running; only the active-turn
      // demand is relaxed — and a late echo never rewinds a terminal turn.
      const call = requireCallOf(state, event.data.modelCallId);
      if (call.status !== "running") {
        throw new FsmViolationError(`${event.type} on ${call.status} call`);
      }
      const runtime = state.turns.get(call.turnId);
      if (runtime === undefined) {
        throw new FsmViolationError(`unknown turn ${call.turnId} for ${event.data.modelCallId}`);
      }
      call.status = event.type === "model.call_sealed" ? "sealed" : "failed";
      call.aborted = event.type === "model.call_failed" && event.data.aborted === true;
      // §2.1 retry row: a retryable call_failed rewinds the turn to QUEUED so
      // the backoff's next `model.call_started` is a legal transition.
      if (
        event.type === "model.call_failed" &&
        event.data.retryable &&
        !TERMINAL_TURN_STATUSES.includes(runtime.status)
      ) {
        runtime.status = "queued";
      }
      return;
    }
    case "model.call_retry": {
      const runtime = requireActive(state);
      requireCall(state, runtime.turnId, event.data.failedModelCallId);
      return;
    }
    case "tool.call": {
      const runtime = requireActive(state);
      if (runtime.status !== "tools_running") {
        throw new FsmViolationError(`tool.call from ${runtime.status}`);
      }
      const lastCallId = runtime.modelCallIds[runtime.modelCallIds.length - 1];
      const call = lastCallId === undefined ? undefined : state.modelCalls.get(lastCallId);
      if (call?.status !== "completed") {
        throw new FsmViolationError("tool.call without a completed model call");
      }
      const { timeoutMs } = event.data;
      const executionId = executionIdFor(event.threadId, event.seq);
      const execution: ExecutionRuntime = {
        executionId,
        callSeq: event.seq,
        turnId: runtime.turnId,
        tool: event.data.tool,
        status: "called",
        attempts: 0,
        dispatchSeqs: [],
        lastDispatchAt: null,
        callCreatedAt: event.createdAt,
        timeoutMs,
        execStarted: false,
        lastOutputOffset: 0,
        resultSeq: null,
      };
      state.executions.set(executionId, execution);
      runtime.executionIds.push(executionId);
      return;
    }
    case "tool.dispatch": {
      const runtime = requireActive(state);
      requireNonTerminal(runtime);
      const executionId = event.data.executionId;
      const execution = state.executions.get(executionId);
      if (execution?.turnId !== runtime.turnId) {
        throw new FsmViolationError(`tool.dispatch for unknown ${executionId}`);
      }
      if (TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
        throw new FsmViolationError(`tool.dispatch on terminal ${executionId}`);
      }
      if (execution.status === "called") execution.status = "dispatched";
      execution.attempts = event.data.attempt;
      execution.dispatchSeqs.push(event.seq);
      execution.lastDispatchAt = event.createdAt;
      return;
    }
    case "tool.exec_started": {
      const executionId = event.data.executionId;
      const execution = state.executions.get(executionId);
      if (execution === undefined) {
        throw new FsmViolationError(`tool.exec_started for unknown ${executionId}`);
      }
      if (TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
        throw new FsmViolationError(`tool.exec_started on terminal ${executionId}`);
      }
      execution.execStarted = true;
      if (execution.status === "dispatched") execution.status = "running";
      return;
    }
    case "tool.output": {
      const executionId = event.data.executionId;
      const execution = state.executions.get(executionId);
      if (execution === undefined) {
        throw new FsmViolationError(`tool.output for unknown ${executionId}`);
      }
      if (TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
        throw new FsmViolationError(`tool.output on terminal ${executionId}`);
      }
      const offset = event.data.offset;
      const chunk = event.data.chunk;
      const chunkSize =
        typeof chunk === "string"
          ? new TextEncoder().encode(chunk).byteLength
          : chunk.__blob__.size;
      if (offset >= execution.lastOutputOffset) {
        execution.lastOutputOffset = offset + chunkSize;
      }
      return;
    }
    case "tool.result": {
      const executionId = event.data.executionId;
      const execution = state.executions.get(executionId);
      if (execution === undefined) {
        throw new FsmViolationError(`tool.result for unknown ${executionId}`);
      }
      if (TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
        throw new FsmViolationError(
          `duplicate tool.result for ${executionId} (I6: results are at-most-once)`,
        );
      }
      execution.status = event.data.status;
      execution.resultSeq = event.seq;
      return;
    }
    case "turn.cancel_requested": {
      const runtime = requireActive(state);
      requireNonTerminal(runtime);
      runtime.status = "cancelling";
      return;
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled": {
      const runtime = turn(state, event.data.turnId);
      if (
        runtime.status === "completed" ||
        runtime.status === "failed" ||
        runtime.status === "cancelled"
      ) {
        throw new FsmViolationError(`terminal event on already-${runtime.status} turn (I10)`);
      }
      const allExecutionsTerminal = runtime.executionIds.every((id) => {
        const execution = state.executions.get(id);
        return execution !== undefined && TERMINAL_EXECUTION_STATUSES.includes(execution.status);
      });
      if (event.type === "turn.cancelled") {
        if (runtime.status !== "cancelling") {
          throw new FsmViolationError(`turn.cancelled from ${runtime.status}`);
        }
      }
      if (!allExecutionsTerminal) {
        throw new FsmViolationError(`${event.type} with non-terminal executions`);
      }
      if (event.type === "turn.completed") runtime.status = "completed";
      else if (event.type === "turn.failed") {
        runtime.failedReason = event.data.reason;
        runtime.status = "failed";
      } else runtime.status = "cancelled";
      if (state.activeTurnId === runtime.turnId) state.activeTurnId = null;
      return;
    }
    case "experimental_context_notes": {
      // Thread-scoped journal data, not FSM state; the notebook projection
      // (tools/edge.ts latestContextNotes) folds it from the log.
      return;
    }
    case "job.registered":
    case "job.settled":
    case "job.delivered":
    case "peer.message":
    case "peer.message_consumed":
    case "task.spawn_planned":
    case "task.spawn_settled":
    case "task.async_result":
    case "task.yield_reminder":
    case "task.yield_warning":
    case "task.yield_completed": {
      // Thread-scoped JobRegistry journal data, not FSM state (proposal §3 T2:
      // jobs outlive turns); the projections in tools/job-registry.ts fold
      // them from the log — the task family (proposal §3 T16) likewise, via
      // tools/task/*, the T17 yield-gate family via tools/task/child-run.ts,
      // and the T18 budget marker (fold-owned, driver-appended).
      return;
    }
    case "task.budget_notice": {
      return;
    }
    case "task.subagent_parked":
    case "task.subagent_revived":
    case "task.subagent_aborted": {
      // T19 lifecycle rows — folded by tools/task/lifecycle.ts (four-state
      // registry), never FSM state (same rule as the task family above).
      return;
    }
    case "task.subagent_identity": {
      // Exactly one identity row per child DO: runSubagent dedups by the
      // identity projection before appending, so a second row is a spawn bug.
      if (state.subagentIdentity !== null) {
        throw new FsmViolationError("duplicate task.subagent_identity");
      }
      state.subagentIdentity = {
        spawnId: event.data.spawnId,
        agentId: event.data.agentId,
        parentThreadId: event.data.parentThreadId,
        sourceThreadId: event.data.sourceThreadId,
        originKind: event.data.originKind,
        depth: event.data.depth,
        ...(event.data.outputSchemaJson === undefined
          ? {}
          : { outputSchema: JSON.parse(event.data.outputSchemaJson) as unknown }),
        ...(event.data.schemaMode === undefined ? {} : { schemaMode: event.data.schemaMode }),
      };
      state.identityCreatedAt = event.createdAt;
      return;
    }
    case "todo_phases": {
      // Thread-scoped journal data, not FSM state; the todo projection
      // (tools/session-tree.ts todoJournalState) folds it from the log.
      return;
    }
    case "interaction.registered": {
      // Thread-scoped interaction journal (proposal §3 T4); the ask
      // projection and the watchdog expiry family fold it from the log.
      const { interactionId, turnId, executionId, expiresAt } = event.data;
      turn(state, turnId);
      state.interactions.set(interactionId, {
        interactionId,
        turnId,
        executionId,
        status: "pending",
        expiresAt,
      });
      return;
    }
    case "interaction.resolved": {
      const interaction = state.interactions.get(event.data.interactionId);
      if (interaction === undefined) {
        throw new FsmViolationError(`interaction.resolved for unknown ${event.data.interactionId}`);
      }
      if (interaction.status !== "pending") {
        throw new FsmViolationError(
          `interaction ${interaction.interactionId} already ${interaction.status} (resolutions are at-most-once)`,
        );
      }
      interaction.status = "resolved";
      return;
    }
    case "interaction.interrupted": {
      const interaction = state.interactions.get(event.data.interactionId);
      if (interaction === undefined) {
        throw new FsmViolationError(
          `interaction.interrupted for unknown ${event.data.interactionId}`,
        );
      }
      if (interaction.status !== "pending") {
        throw new FsmViolationError(
          `interaction ${interaction.interactionId} already ${interaction.status} (interrupts are at-most-once)`,
        );
      }
      interaction.status = "interrupted";
      return;
    }
  }
}

export function turnTerminal(runtime: TurnRuntime): boolean {
  return TERMINAL_TURN_STATUSES.includes(runtime.status);
}

export function executionTerminal(execution: ExecutionRuntime): boolean {
  return TERMINAL_EXECUTION_STATUSES.includes(execution.status);
}

export interface DueWork {
  sealedModelCallIds: number[];
  reaskExecutionIds: string[];
  /** Non-terminal wait executions past their WAIT_MAX_MS cap (§3 T2). */
  waitCapExecutionIds: string[];
  /** Pending bounded interactions past their expiresAt (§3 T4, omp
   * ask.timeout auto-select; null expiresAt never appears here). */
  interactionExpiryExecutionIds: string[];
  turnWatchdogExpiredTurnIds: string[];
  nextDeadlineAt: number | null;
}

/**
 * Watchdog deadline arithmetic (§2.5): the alarm handler seals overdue model
 * calls, re-asks overdue executions with the same executionId, and explicitly
 * fails turns that outlive the total backstop. Everything is recomputed from
 * replayed state; the alarm itself carries no state.
 *
 * Wait executions (M1.5 T2) add two deadline families:
 * - the per-wait 30-minute safety cap (`waitMaxMs` from the tool.call's
 *   journal timestamp — replay-derivable, alarm-carried, practice 4);
 * - a turn-watchdog extension: a turn blocked in a wait is not stuck until
 *   the wait cap passes, so the active turn's backstop deadline moves out to
 *   cover it. The alarm handler resolves wait caps BEFORE turn expiry, so the
 *   cap result lands and the turn proceeds (omp semantics: wait returns a
 *   still-running snapshot at the cap, never a failed turn).
 *
 * Blocked asks (M1.5 T4) add the same shape with no default cap: a turn
 * blocked on a pending interaction is not stuck — the user IS the deadline
 * (bb leaves the composer locked until resolve or interrupt), so an unbounded
 * pending interaction suspends the turn watchdog outright, and a bounded one
 * (`expiresAt`, the ask.timeout arm) extends it to the expiry, which the
 * alarm resolves BEFORE turn expiry with an auto-selected ruling.
 */
export function computeDueWork(state: ReplayState, config: WatchdogConfig, now: number): DueWork {
  const due: DueWork = {
    sealedModelCallIds: [],
    reaskExecutionIds: [],
    waitCapExecutionIds: [],
    interactionExpiryExecutionIds: [],
    turnWatchdogExpiredTurnIds: [],
    nextDeadlineAt: null,
  };
  const deadlines: number[] = [];
  let waitCapDeadline: number | null = null;
  let pendingAskDeadline: number | null = null;
  let activeTurnBlockedOnPendingAsk = false;
  for (const call of state.modelCalls.values()) {
    if (call.status !== "running") continue;
    const deadline = call.startedAt + config.modelCallCapMs;
    if (now >= deadline) due.sealedModelCallIds.push(call.modelCallId);
    else deadlines.push(deadline);
  }
  for (const execution of state.executions.values()) {
    if (executionTerminal(execution) || execution.lastDispatchAt === null) continue;
    const turnRuntime = state.turns.get(execution.turnId);
    if (turnRuntime === undefined || turnTerminal(turnRuntime)) continue;
    const deadline = execution.lastDispatchAt + execution.timeoutMs + config.execGraceMs;
    if (now >= deadline && execution.attempts < config.maxDispatchAttempts) {
      due.reaskExecutionIds.push(execution.executionId);
      deadlines.push(now + config.execGraceMs);
    } else if (now < deadline) {
      deadlines.push(deadline);
    }
  }
  for (const execution of state.executions.values()) {
    if (executionTerminal(execution) || execution.tool !== "wait") continue;
    const deadline = execution.callCreatedAt + config.waitMaxMs;
    if (now >= deadline) {
      due.waitCapExecutionIds.push(execution.executionId);
      // Retry backstop in case the cap resolution failed to terminalize it.
      deadlines.push(now + config.execGraceMs);
    } else {
      deadlines.push(deadline);
      if (waitCapDeadline === null || deadline > waitCapDeadline) waitCapDeadline = deadline;
    }
  }
  for (const interaction of state.interactions.values()) {
    if (interaction.status !== "pending") continue;
    const turnRuntime = state.turns.get(interaction.turnId);
    if (turnRuntime === undefined || turnTerminal(turnRuntime)) continue;
    if (interaction.expiresAt === null) {
      // Unbounded user-wait: the turn backstop never preempts it (the
      // interrupt path is the user's own way out — bb semantics).
      if (interaction.turnId === state.activeTurnId) activeTurnBlockedOnPendingAsk = true;
      continue;
    }
    if (now >= interaction.expiresAt) {
      due.interactionExpiryExecutionIds.push(interaction.executionId);
      // Retry backstop in case the expiry resolution failed to terminalize.
      deadlines.push(now + config.execGraceMs);
    } else {
      deadlines.push(interaction.expiresAt);
      if (interaction.turnId === state.activeTurnId) {
        pendingAskDeadline =
          pendingAskDeadline === null
            ? interaction.expiresAt
            : Math.max(pendingAskDeadline, interaction.expiresAt);
      }
    }
  }
  const activeTurn = state.activeTurnId === null ? undefined : state.turns.get(state.activeTurnId);
  if (activeTurn !== undefined && !turnTerminal(activeTurn)) {
    // Extend the turn watchdog to cover its blocking waits (see docstring):
    // the wait cap is the terminal promise for that execution, so the
    // backstop moves out to it instead of preempting a legitimate wait.
    const base = activeTurn.inputCreatedAt + config.turnWatchdogMs;
    const deadline = activeTurnBlockedOnPendingAsk
      ? // Suspended: a pending unbounded ask owns the turn indefinitely.
        null
      : pendingAskDeadline !== null
        ? Math.max(base, pendingAskDeadline)
        : waitCapDeadline !== null
          ? Math.max(base, waitCapDeadline)
          : due.waitCapExecutionIds.length > 0
            ? // Cap due this tick: the handler resolves it before expiry.
              now + config.execGraceMs
            : base;
    if (deadline === null) {
      // No deadline while the user-wait pends; nothing to arm for the turn.
    } else if (now >= deadline) {
      due.turnWatchdogExpiredTurnIds.push(activeTurn.turnId);
    } else {
      deadlines.push(deadline);
    }
  }
  due.nextDeadlineAt = deadlines.length === 0 ? null : Math.min(...deadlines);
  return due;
}
