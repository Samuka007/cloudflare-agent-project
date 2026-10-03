import type { AnyAgentEvent } from "./fsm-events.js";
import { executionIdFor } from "./ids.js";
import type {
  ModelRequest,
  PriorModelCall,
  SteerContribution,
  ToolResultContribution,
} from "./provider.js";

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
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
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
      default:
        // thread lifecycle + state events are context-invisible (ruling ③).
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
        throw new ProjectionError(
          `call ${slice.modelCallId} consumes unknown steer seq ${seq}`,
        );
      }
      slice.steers.push({ seq, text });
    }
  }

  const current = slices.get(modelCallId);
  if (current === undefined) {
    throw new ProjectionError(
      `turn ${turnId}: no model.call_started for call ${modelCallId}`,
    );
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
    const slice = slices.get(callId)!;
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
  };
}
