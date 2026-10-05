import type { AnyAgentEvent } from "./fsm-events.js";
import { executionIdFor } from "./ids.js";
import type {
  AsyncResultContribution,
  ModelRequest,
  PriorModelCall,
  PriorTurnHistory,
  SteerContribution,
  ToolResultContribution,
} from "./provider.js";
import { boundaryOwnerSeqs, renderAsyncResultText } from "./tools/task/plan.js";
import { rewindContextCut } from "./tools/session-tree.js";

/**
 * Event log → model request projection (#28 ruling ③ translation layer).
 *
 * Pure, deterministic fold over the log — the same property the DO's
 * `buildModelRequest` needs, extracted here so the runtime projection and the
 * replay tests share one implementation (omp §1.5: every model call rebuilds
 * its full context from the log; this rebuild *is* the replay-consistency
 * guarantee). Only the model-visible trio (#28 ruling ③) enters the request:
 * turn inputs → user-side material, model calls → assistant slices, tool
 * calls/results → the pairing structure. State events
 * (dispatch/exec_started/output/…) are context-invisible by ruling.
 *
 * Session scope (#228): the fold spans every completed turn of the thread,
 * not only the caller's turn — a multi-turn session (child reminder turns,
 * follow-up user messages) carries each prior turn's input and call history
 * into the request as {@link PriorTurnHistory}. An armed rewind cut excludes
 * pre-boundary turns entirely: the branch summary replaces that span (#147).
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
  const firstRow = events[0];
  if (firstRow === undefined) {
    throw new ProjectionError("cannot project a request from an empty log");
  }
  // #147: the assembly truncates at the checkpoint boundary — an armed
  // rewind cut hides the exploration span from every fold below (omp
  // session-context.ts:339-343: summary first, then kept rows, then rows
  // after the cut). All folds (async attribution, steer ledger, turn slices)
  // see only the active branch; the summary rides the request as the overlay.
  // #325: the pair arms as of THIS call — a replay of an earlier call from a
  // longer final log must arm the pair that was completed then, not the
  // latest pair the log ends with (the cut is a temporal fold like every
  // other slice below).
  const cut = rewindContextCut(events, firstRow.threadId, turnId, modelCallId);
  const activeEvents =
    cut === undefined
      ? events
      : events.filter(
          (event) =>
            event.seq > cut.hideThroughSeq ||
            (cut.checkpointResultSeq !== null && event.seq <= cut.checkpointResultSeq),
        );

  // M1.5 T16 async-result attribution runs over the whole active branch
  // (#147: hidden-span rows never re-inject post-cut) — background
  // completions land between turns, so the per-turn filter below never sees
  // them. Boundary rule (boundaryOwnerSeqs): a result rides the first call
  // that starts after it; it then stays in that call's slice forever.
  const asyncRows = activeEvents.filter(
    (event): event is Extract<AnyAgentEvent, { type: "task.async_result" }> =>
      event.type === "task.async_result",
  );
  const callStartSeqs = activeEvents
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

  const steerTexts = new Map<number, string>();
  const slices = new Map<number, CallSlice>();
  const callOrder: number[] = [];
  /** Session-wide turn registry (#228): every turn.input row, in seq order. */
  const turnInputs: { turnId: string; seq: number; inputId: string; text: string }[] = [];
  /** Session-wide call grouping: turnId → its model.call_started seqs. */
  const callsByTurn = new Map<string, number[]>();
  const executionToCall = new Map<string, number>();

  for (const event of activeEvents) {
    switch (event.type) {
      // Thread-scoped journal families that never appear inside a turn slice
      // (JobRegistry entries, notebook revisions, interaction rows — the
      // ask's model-visible surface is its tool.result) fall through untouched.
      case "experimental_context_notes":
      // #288: binding rows are thread-scoped state, not turn content.
      case "thread.rebound":
      case "interaction.interrupted":
      case "turn.phase":
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
      case "task.subagent_parked":
      case "task.subagent_revived":
      case "task.subagent_aborted":
      // #276 J5 activity backflow: the child-activity face (ux unfold), not
      // model-visible session material.
      case "task.subagent_event":
      case "task.subagent_flush":
        break;
      case "task.async_result":
        // Consumed above from the full log; the turn filter skips it here.
        break;
      case "turn.steer": {
        steerTexts.set(event.seq, event.data.content.map((part) => part.text).join("\n"));
        break;
      }
      case "turn.input": {
        // Session-wide registry: prior turns fold below; exactly the caller's
        // row becomes the request input. (The old exactly-one filter was the
        // #228 defect: a second turn's request lost the whole first turn.)
        turnInputs.push({
          turnId: event.data.turnId,
          seq: event.seq,
          inputId: event.data.inputId,
          text: event.data.content.map((part) => part.text).join("\n"),
        });
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
        const byTurn = callsByTurn.get(event.data.turnId);
        if (byTurn === undefined) callsByTurn.set(event.data.turnId, [event.seq]);
        else byTurn.push(event.seq);
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
      // Thread lifecycle + state events are context-invisible (ruling ③).
      case "thread.created":
      case "todo_phases":
      case "model.call_failed":
      case "model.call_retry":
      case "model.call_sealed":
      case "model.delta":
      case "model.thinking":
      case "model.usage_receipt":
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

  const inputTurn = turnInputs.find((turn) => turn.turnId === turnId);
  if (inputTurn === undefined) {
    throw new ProjectionError(`turn ${turnId}: no turn.input in the log`);
  }
  if (inputTurn.text === "") {
    throw new ProjectionError(`turn ${turnId}: turn.input has empty text`);
  }
  const input = inputTurn.text;

  const current = slices.get(modelCallId);
  if (current === undefined) {
    throw new ProjectionError(`turn ${turnId}: no model.call_started for call ${modelCallId}`);
  }

  // "Prior" is temporal: only calls whose boundary precedes the current
  // call's belong in this request. Replaying an earlier call's request from
  // a longer final log must reconstruct the request as it was THEN — later
  // calls are the future and never enter it. (callOrder is session-wide;
  // priorCalls stays the current turn's earlier calls.)
  const currentTurnCallIds = callsByTurn.get(turnId) ?? [];
  const currentIndex = currentTurnCallIds.indexOf(modelCallId);
  if (currentIndex === -1) {
    throw new ProjectionError(`call ${modelCallId} missing from call order`);
  }
  const priorCallIds = currentTurnCallIds.slice(0, currentIndex);
  const priorCalls: PriorModelCall[] = [];
  for (const callId of priorCallIds) {
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

  // Prior turns (#228): every earlier turn's input + completed call history,
  // oldest first. Under an armed rewind cut, pre-boundary turns stay excluded
  // — the branch summary replaces the hidden span (#147). Later turns (a
  // longer final log replaying an earlier call) are the future and never
  // enter.
  const priorTurns: PriorTurnHistory[] = [];
  for (const turn of turnInputs) {
    if (turn.turnId === turnId || turn.seq >= inputTurn.seq) continue;
    if (cut !== undefined && turn.seq <= cut.hideThroughSeq) continue;
    if (turn.text === "") {
      throw new ProjectionError(`turn ${turn.turnId}: turn.input has empty text`);
    }
    const calls: PriorModelCall[] = [];
    for (const callId of callsByTurn.get(turn.turnId) ?? []) {
      const slice = slices.get(callId);
      if (slice === undefined) {
        throw new ProjectionError(`turn ${turn.turnId}: call ${callId} missing from slices`);
      }
      if (!slice.completed) {
        // Pre-first-byte failed attempt on the retry path: zero wire content
        // (no deltas, no tool calls) — the retry replaces it in history.
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
      calls.push({
        modelCallId: callId,
        steers: slice.steers,
        text: slice.text,
        toolCalls: slice.toolCalls,
        toolResults,
        asyncResults: priorAsync,
      });
    }
    priorTurns.push({ input: turn.text, calls });
  }

  return {
    threadId: firstRow.threadId,
    turnId,
    modelCallId,
    input,
    steers: current.steers,
    priorCalls,
    // Session history (#228): prior turns ride every post-turn request.
    ...(priorTurns.length > 0 ? { priorTurns } : {}),
    // The current call's boundary rows ride the trailing user message (wire
    // appends them after the steers); prior calls carry theirs permanently.
    asyncResults: asyncResultsByCall.get(modelCallId) ?? [],
    // T17 reminder ladder: the reminder marker bound to THIS turn's inputId
    // (task.yield_reminder.inputId === turn.input.inputId) forces `yield` as
    // the tool choice for every model call of that turn. Only the 3rd-tier
    // marker carries forced=true (the verdict that appended it — every
    // reminder turn has a marker, so the join alone cannot tier them).
    ...(activeEvents.some(
      (event) =>
        event.type === "task.yield_reminder" &&
        event.data.forced &&
        event.data.inputId === inputTurn.inputId,
    )
      ? { toolChoice: { name: "yield" } }
      : {}),
    // The armed rewind cut rides every post-cut request of the turn (omp:
    // the report is the branch summary the next provider turn sees).
    ...(cut === undefined
      ? {}
      : {
          branchCut: {
            checkpointResultSeq: cut.checkpointResultSeq,
            rewindResultSeq: cut.rewindResultSeq,
            summary: cut.summary,
          },
        }),
  };
}
