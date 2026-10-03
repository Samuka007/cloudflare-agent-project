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
  | "queued"
  | "model_call"
  | "tools_running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

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
  status: ExecutionStatus;
  attempts: number;
  dispatchSeqs: number[];
  lastDispatchAt: number | null;
  timeoutMs: number;
  execStarted: boolean;
  lastOutputOffset: number;
  resultSeq: number | null;
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
  if (call === undefined || call.turnId !== turnId) {
    throw new FsmViolationError(`unknown modelCallId ${modelCallId} for turn ${turnId}`);
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
      const runtime = requireActive(state);
      const call = requireCall(state, runtime.turnId, event.data.modelCallId);
      if (call.status !== "running") {
        throw new FsmViolationError(`${event.type} on ${call.status} call`);
      }
      call.status = event.type === "model.call_sealed" ? "sealed" : "failed";
      call.aborted = event.type === "model.call_failed" && event.data.aborted === true;
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
      const call =
        lastCallId === undefined ? undefined : state.modelCalls.get(lastCallId);
      if (call === undefined || call.status !== "completed") {
        throw new FsmViolationError("tool.call without a completed model call");
      }
      const { timeoutMs } = event.data;
      const executionId = executionIdFor(event.threadId, event.seq);
      const execution: ExecutionRuntime = {
        executionId,
        callSeq: event.seq,
        turnId: runtime.turnId,
        status: "called",
        attempts: 0,
        dispatchSeqs: [],
        lastDispatchAt: null,
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
      if (execution === undefined || execution.turnId !== runtime.turnId) {
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
      if (runtime.status === "completed" || runtime.status === "failed" || runtime.status === "cancelled") {
        throw new FsmViolationError(`terminal event on already-${runtime.status} turn (I10)`);
      }
      const allExecutionsTerminal = runtime.executionIds.every((id) => {
        const execution = state.executions.get(id);
        return (
          execution !== undefined && TERMINAL_EXECUTION_STATUSES.includes(execution.status)
        );
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
  turnWatchdogExpiredTurnIds: string[];
  nextDeadlineAt: number | null;
}

/**
 * Watchdog deadline arithmetic (§2.5): the alarm handler seals overdue model
 * calls, re-asks overdue executions with the same executionId, and explicitly
 * fails turns that outlive the total backstop. Everything is recomputed from
 * replayed state; the alarm itself carries no state.
 */
export function computeDueWork(
  state: ReplayState,
  config: WatchdogConfig,
  now: number,
): DueWork {
  const due: DueWork = {
    sealedModelCallIds: [],
    reaskExecutionIds: [],
    turnWatchdogExpiredTurnIds: [],
    nextDeadlineAt: null,
  };
  const deadlines: number[] = [];
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
    const deadline =
      execution.lastDispatchAt + execution.timeoutMs + config.execGraceMs;
    if (now >= deadline && execution.attempts < config.maxDispatchAttempts) {
      due.reaskExecutionIds.push(execution.executionId);
      deadlines.push(now + config.execGraceMs);
    } else if (now < deadline) {
      deadlines.push(deadline);
    }
  }
  const activeTurn =
    state.activeTurnId === null ? undefined : state.turns.get(state.activeTurnId);
  if (activeTurn !== undefined && !turnTerminal(activeTurn)) {
    const deadline = activeTurn.inputCreatedAt + config.turnWatchdogMs;
    if (now >= deadline) due.turnWatchdogExpiredTurnIds.push(activeTurn.turnId);
    else deadlines.push(deadline);
  }
  due.nextDeadlineAt = deadlines.length === 0 ? null : Math.min(...deadlines);
  return due;
}
