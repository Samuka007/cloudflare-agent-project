import type { AnyAgentEvent } from "./fsm-events.js";
import { executionIdFor } from "./ids.js";
import type {
  AsyncResultContribution,
  ModelRequest,
  PriorModelCall,
  SteerContribution,
  ToolResultContribution,
} from "./provider.js";
import { boundaryOwnerSeqs, renderAsyncResultText } from "./tools/task/plan.js";

/**
 * Event log → model request projection (#28 ruling ③ translation layer).
 *
 * Pure, deterministic fold over the log — the same property the DO's
 * `buildModelRequest` needs, extracted here so the runtime projection and the
 * replay tests share one implementation (omp §1.5: every model call rebuilds
 * its full context from the log; this rebuild *is* the replay-consistency
 * guarantee). Only the model-visible trio (#28 ruling ③) enters the request:
 * turn input → input, model calls → assistant slices, tool calls/results →
 * the pairing structure. State events (dispatch/exec_started/output/…) are
 * context-invisible by ruling.
 *
 * Steer attribution: a `turn.steer` enters the context at the boundary of the
 * model call whose `model.call_started.consumedSteerSeqs` records it (§2.3,
 * I9) — consumed once, then permanently part of that call's slice.
 */

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

interface CallSlice {
  modelCallId: number;
  steerSeqs: number[];
  steers: SteerContribution[];
  text: string;
  /** toolCalls in `tool.call` seq order; index-aligned with `executionIds`. */
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
  executionIds: string[];
  toolNameByExecutionId: Map<string, string>;
  /** Terminal results by executionId (each fills its `tool.call` slot). */
  resultByExecutionId: Map<string, ToolResultContribution>;
  completed: boolean;
}

export function modelRequestFromEvents(
  events: readonly AnyAgentEvent[],
  turnId: string,
  modelCallId: number,
): ModelRequest {
  // M1.5 T16 async-result attribution runs over the FULL log — background
  // completions land between turns, so the per-turn filter below never sees
  // them. Boundary rule (boundaryOwnerSeqs): a result rides the first call
  // that starts after it; it then stays in that call's slice forever.
  const asyncRows = events.filter(
    (event): event is Extract<AnyAgentEvent, { type: "task.async_result" }> =>
      event.type === "task.async_result",
  );
  const callStartSeqs = events
    .filter((event) => event.type === "model.call_started")
    .map((event) => event.seq);
  const asyncResultsByCall = new Map<number, AsyncResultContribution[]>();
  for (const row of asyncRows) {
    const contribution: AsyncResultContribution = {
      seq: row.seq,
      spawnId: row.data.spawnId,
      agentId: row.data.agentId,
      status: row.data.status,
      text: renderAsyncResultText(row.data.agentId, row.data.status, row.data.output),
    };
    const boundary = boundaryOwnerSeqs(callStartSeqs, row.seq);
    // boundary -1: the result landed after every call that has started — it
    // is pending until the NEXT run's boundary and never enters the current
    // request (a mid-call arrival belongs to the future, replay-safe either
    // way: the same log always projects the same request).
    if (boundary === -1) continue;
    const bucket = asyncResultsByCall.get(boundary);
    if (bucket === undefined) asyncResultsByCall.set(boundary, [contribution]);
    else bucket.push(contribution);
  }

  const turnEvents = events.filter(
    (event) => "turnId" in event.data && event.data.turnId === turnId,
  );
  const inputEvents = turnEvents.filter((event) => event.type === "turn.input");
  if (inputEvents.length !== 1) {
    throw new ProjectionError(
      `turn ${turnId}: expected exactly one turn.input, found ${inputEvents.length}`,
    );
  }
  const inputEvent = inputEvents[0];
  if (inputEvent === undefined) {
    throw new ProjectionError(`turn ${turnId}: turn.input vanished mid-projection`);
  }
  const input = inputEvent.data.content.map((part) => part.text).join("\n");
  if (input === "") {
    throw new ProjectionError(`turn ${turnId}: turn.input has empty text`);
  }

  const steerTexts = new Map<number, string>();
  const slices = new Map<number, CallSlice>();
  const callOrder: number[] = [];
  const executionToCall = new Map<string, number>();

  for (const event of turnEvents) {
    switch (event.type) {
      // Thread-scoped journal families that never appear inside a turn slice
      // (JobRegistry entries, notebook revisions, interaction rows — the
      // ask's model-visible surface is its tool.result) fall through untouched.
      case "experimental_context_notes":
      case "interaction.interrupted":
      case "interaction.registered":
      case "interaction.resolved":
      case "job.delivered":
      case "job.registered":
      case "job.settled":
      case "peer.message":
      case "peer.message_consumed":
      case "task.spawn_planned":
      case "task.spawn_settled":
      case "task.subagent_identity":
      case "task.yield_reminder":
      case "task.yield_warning":
      case "task.yield_completed":
      case "task.budget_notice":
        break;
      case "task.async_result":
        // Consumed above from the full log; the turn filter skips it here.
        break;
      case "turn.steer": {
        steerTexts.set(event.seq, event.data.content.map((part) => part.text).join("\n"));
        break;
      }
      case "model.call_started": {
        const slice: CallSlice = {
          modelCallId: event.seq,
          steerSeqs: [...event.data.consumedSteerSeqs],
          steers: [],
          text: "",
          toolCalls: [],
          executionIds: [],
          toolNameByExecutionId: new Map(),
          resultByExecutionId: new Map(),
          completed: false,
        };
        slices.set(event.seq, slice);
        callOrder.push(event.seq);
        break;
      }
      case "model.call_completed": {
        const slice = slices.get(event.data.modelCallId);
        if (slice === undefined) {
          throw new ProjectionError(
            `seq ${event.seq}: model.call_completed for unknown call ${event.data.modelCallId}`,
          );
        }
        slice.text = event.data.text;
        slice.toolCalls = event.data.toolCalls.map((call) => ({
          name: call.name,
          arguments: call.arguments,
        }));
        slice.completed = true;
        break;
      }
      case "tool.call": {
        const slice = slices.get(event.data.modelCallId);
        if (slice === undefined) {
          throw new ProjectionError(
            `seq ${event.seq}: tool.call for unknown call ${event.data.modelCallId}`,
          );
        }
        const executionId = executionIdFor(event.threadId, event.seq);
        slice.executionIds.push(executionId);
        slice.toolNameByExecutionId.set(executionId, event.data.tool);
        executionToCall.set(executionId, event.data.modelCallId);
        break;
      }
      case "tool.result": {
        const callId = executionToCall.get(event.data.executionId);
        const slice = callId !== undefined ? slices.get(callId) : undefined;
        if (slice === undefined) {
          throw new ProjectionError(
            `seq ${event.seq}: tool.result for unknown execution ${event.data.executionId}`,
          );
        }
        slice.resultByExecutionId.set(event.data.executionId, {
          executionId: event.data.executionId,
          tool: slice.toolNameByExecutionId.get(event.data.executionId) ?? "unknown",
          status: event.data.status,
          output: typeof event.data.output === "string" ? event.data.output : "",
        });
        break;
      }
      case "turn.input":
        // Captured before the walk (exactly-one invariant above).
        break;
      // Thread lifecycle + state events are context-invisible (ruling ③).
      case "thread.created":
      case "experimental_context_notes":
      case "todo_phases":
      case "model.call_failed":
      case "model.call_retry":
      case "model.call_sealed":
      case "model.delta":
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

  // Resolve steer texts per boundary after the walk: attribution is by
  // consumedSteerSeqs, not log adjacency (a steer may log before or after the
  // call_started that consumes it).
  for (const slice of slices.values()) {
    for (const seq of slice.steerSeqs) {
      const text = steerTexts.get(seq);
      if (text === undefined) {
        throw new ProjectionError(`call ${slice.modelCallId} consumes unknown steer seq ${seq}`);
      }
      slice.steers.push({ seq, text });
    }
  }

  const current = slices.get(modelCallId);
  if (current === undefined) {
    throw new ProjectionError(`turn ${turnId}: no model.call_started for call ${modelCallId}`);
  }

  // "Prior" is temporal: only calls whose boundary precedes the current
  // call's belong in this request. Replaying an earlier call's request from
  // a longer final log must reconstruct the request as it was THEN — later
  // calls are the future and never enter it.
  const currentIndex = callOrder.indexOf(modelCallId);
  if (currentIndex === -1) {
    throw new ProjectionError(`call ${modelCallId} missing from call order`);
  }
  const priorCalls: PriorModelCall[] = [];
  for (const callId of callOrder.slice(0, currentIndex)) {
    const slice = slices.get(callId);
    if (slice === undefined) {
      throw new ProjectionError(`call ${callId} in call order but missing from slices`);
    }
    if (!slice.completed) {
      // Pre-first-byte failed attempt on the retry path: zero wire content
      // (no deltas, no tool calls) — the retry replaces it in history. A
      // sealed call never reaches a next model call, so this is safe.
      continue;
    }
    const toolResults = slice.executionIds.map((executionId) => {
      const result = slice.resultByExecutionId.get(executionId);
      if (result === undefined) {
        throw new ProjectionError(
          `call ${callId}: execution ${executionId} has no terminal tool.result — dangling tool_use`,
        );
      }
      return result;
    });
    const priorAsync = asyncResultsByCall.get(callId) ?? [];
    if (toolResults.length !== slice.toolCalls.length) {
      throw new ProjectionError(
        `call ${callId}: ${slice.toolCalls.length} toolCalls vs ${toolResults.length} results`,
      );
    }
    priorCalls.push({
      modelCallId: callId,
      steers: slice.steers,
      text: slice.text,
      toolCalls: slice.toolCalls,
      toolResults,
      asyncResults: priorAsync,
    });
  }

  const firstEvent = events[0];
  if (firstEvent === undefined) {
    throw new ProjectionError("cannot project a request from an empty log");
  }
  return {
    threadId: firstEvent.threadId,
    turnId,
    modelCallId,
    input,
    steers: current.steers,
    priorCalls,
    // The current call's boundary rows ride the trailing user message (wire
    // appends them after the steers); prior calls carry theirs permanently.
    asyncResults: asyncResultsByCall.get(modelCallId) ?? [],
    // T17 reminder ladder: the reminder marker bound to THIS turn's inputId
    // (task.yield_reminder.inputId === turn.input.inputId) forces `yield` as
    // the tool choice for every model call of that turn. Only the 3rd-tier
    // marker carries forced=true (the verdict that appended it — every
    // reminder turn has a marker, so the join alone cannot tier them).
    ...(events.some(
      (event) =>
        event.type === "task.yield_reminder" &&
        event.data.forced &&
        event.data.inputId === inputEvent.data.inputId,
    )
      ? { toolChoice: { name: "yield" } }
      : {}),
  };
}
