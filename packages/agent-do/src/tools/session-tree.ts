import type { AnyAgentEvent } from "../fsm-events.js";
import { executionIdFor } from "../ids.js";
import type { TodoPhase } from "./todo-state.js";

/**
 * Session-tree projections over the event journal (M1.5 T3, #93) — the DO
 * storage equivalent of omp's session-entry model for the checkpoint/rewind
 * pair and the todo list. Like `rolloverRequestedInTurn` (T1), every state
 * here is the durable tool.call/tool.result pair or a typed journal entry —
 * replay-derivable, no second authority. The model-visible consumption of
 * the rewind cut is the context assembly's (#147: translate truncates at the
 * checkpoint boundary and re-plays the report as the prefix overlay); the
 * journal itself stays append-only (omp: abandoned rows leave the active
 * branch, not the file) — the rollover/compaction family (#79) extends this
 * same cut seam.
 */

/** Journal entry type carrying one canonical todo snapshot (see fsm-events). */
export const TODO_PHASES_ENTRY_TYPE = "todo_phases";

// ---------------------------------------------------------------------------
// checkpoint / rewind state — omp agent-session.ts rehydrate/apply semantics
// ---------------------------------------------------------------------------

/** No checkpoint has terminalized on this journal, or the last one was rewound then superseded. */
export interface CheckpointRewindIdle {
  phase: "idle";
}

/**
 * Active checkpoint (omp `#checkpointState`): the latest ok checkpoint result
 * has no later ok rewind — `checkpointResultSeq` is the branchWithSummary
 * target, the DO shape of omp `checkpointEntryId` (the checkpoint tool-result
 * entry, agent-session.ts capture at checkpoint time).
 */
export interface CheckpointRewindActive {
  phase: "active";
  checkpointResultSeq: number;
}

/**
 * Completed rewind (omp `#lastCompletedRewind` + `#pendingRewindReport`): an
 * ok rewind with no later ok checkpoint (a checkpoint clears the retained
 * rewind — agent-session.ts capture step 5). `checkpointResultSeq` null is
 * the root-fallback shape (omp falls back to `branchWithSummary(null, …)` at
 * agent-session.ts:9721); executor-produced journals always resolve one.
 */
export interface CheckpointRewindCompleted {
  phase: "completed";
  checkpointResultSeq: number | null;
  rewindResultSeq: number;
  /** RewindTool-trimmed report — the branch summary payload (omp details.report). */
  report: string;
}

export type CheckpointRewindState =
  CheckpointRewindIdle | CheckpointRewindActive | CheckpointRewindCompleted;

interface TreeCallRow {
  tool: "checkpoint" | "rewind";
  /** Raw `report` argument for rewind calls (trimmed at projection). */
  report?: unknown;
}

/** executionId → checkpoint/rewind call row, in one pass (reverse lookup for result rows). */
function treeCallIndex(
  events: readonly AnyAgentEvent[],
  threadId: string,
): Map<string, TreeCallRow> {
  const calls = new Map<string, TreeCallRow>();
  for (const event of events) {
    if (event.type !== "tool.call") continue;
    if (event.data.tool !== "checkpoint" && event.data.tool !== "rewind") continue;
    calls.set(executionIdFor(threadId, event.seq), {
      tool: event.data.tool,
      report: event.data.arguments.report,
    });
  }
  return calls;
}

/**
 * Latest ok tool.result at or before `beforeSeq` whose execution belongs to a
 * `checkpoint` call — the branch point of the rewind (omp checkpointEntryId).
 */
function latestCheckpointResultSeq(
  events: readonly AnyAgentEvent[],
  calls: Map<string, TreeCallRow>,
  beforeSeq: number,
): number | null {
  for (let index = beforeSeq - 1; index >= 0; index--) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type !== "tool.result" || event.data.status !== "ok") continue;
    const call = calls.get(event.data.executionId);
    if (call?.tool === "checkpoint") return event.seq;
  }
  return null;
}

/**
 * Project the single checkpoint/rewind state from the journal. omp rehydration
 * (agent-session.ts `#rehydrateCheckpointRewindState`): a most-recent
 * successful checkpoint without a later retained rewind reconstructs the
 * active checkpoint; otherwise the retained report marks the completed pair.
 * One backward scan: whichever of (ok checkpoint, ok rewind) terminalized
 * last decides the phase.
 */
export function checkpointRewindState(
  events: readonly AnyAgentEvent[],
  threadId: string,
  /**
   * As-of anchor (#325): fold only rows with `seq < beforeSeq` — the state as
   * it stood when the row numbered `beforeSeq` appended. Exclusive bound on
   * the backward scan; +∞ (the default) folds the whole journal (the live
   * NOW fold).
   */
  beforeSeq: number = Number.POSITIVE_INFINITY,
): CheckpointRewindState {
  const calls = treeCallIndex(events, threadId);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === undefined || event.seq >= beforeSeq) continue;
    if (event.type !== "tool.result" || event.data.status !== "ok") continue;
    const call = calls.get(event.data.executionId);
    if (call === undefined) continue;
    if (call.tool === "checkpoint") {
      return { phase: "active", checkpointResultSeq: event.seq };
    }
    const raw = typeof call.report === "string" ? call.report : "";
    return {
      phase: "completed",
      checkpointResultSeq: latestCheckpointResultSeq(events, calls, event.seq),
      rewindResultSeq: event.seq,
      // RewindTool trims before storing details.report (checkpoint.ts:123).
      report: raw.trim(),
    };
  }
  return { phase: "idle" };
}

export interface ActiveBranchProjection {
  /**
   * Journal prefix kept on the active branch — through the checkpoint
   * tool.result row (omp checkpointMessageCount counts messages AFTER the
   * checkpoint result is appended; checkpointEntryId IS that result row).
   * Empty only for the root fallback.
   */
  kept: readonly AnyAgentEvent[];
  /** Rows the cut hides: the exploration span plus the rewind execution. */
  hidden: readonly AnyAgentEvent[];
  /** `branchWithSummary` summary payload (the retained rewind report). */
  summary: string;
}

/**
 * The turn-end rewind cut as a pure projection (omp `#applyRewind` →
 * `branchWithSummary(checkpointEntryId, report)`): the leaf moves to the
 * checkpoint boundary, the exploration span leaves the active branch, and
 * the report becomes the branch summary the next provider turn sees. The
 * journal itself stays append-only (omp: "abandoned entries remain in the
 * .jsonl log but leave the active branch") — the rollover tickets commit
 * this boundary; L1 asserts the kept/hidden partition here.
 */
export function activeBranchAfterRewind(
  events: readonly AnyAgentEvent[],
  threadId: string,
): ActiveBranchProjection | undefined {
  const state = checkpointRewindState(events, threadId);
  if (state.phase !== "completed") return undefined;
  const boundary = state.checkpointResultSeq;
  const kept = boundary === null ? [] : events.filter((event) => event.seq <= boundary);
  const hidden = events.filter((event) => boundary === null || event.seq > boundary);
  return { kept, hidden, summary: state.report };
}

// ---------------------------------------------------------------------------
// Assembly-facing cut (#147) — the context assembly consumes the checkpoint
// boundary (decomposition.md 上下文装配 row; omp session-context.ts:339-343:
// summary first, then kept rows, then post-cut rows)
// ---------------------------------------------------------------------------

/**
 * The rewind cut the context assembly must consume for `turnId`'s requests
 * (undefined = project the journal uncut). `hideThroughSeq` is the last row
 * the cut hides — the rewind turn's terminal row; the span between the
 * checkpoint boundary and it (exploration + rewind execution) never enters a
 * post-cut request, and `summary` replaces it as the prefix overlay.
 */
export interface RewindContextCut {
  checkpointResultSeq: number | null;
  rewindResultSeq: number;
  hideThroughSeq: number;
  summary: string;
}

/**
 * Arm the rewind cut for one turn's projection. omp applies the
 * branchWithSummary cut at the rewind turn's END: that turn's own live
 * context keeps the exploration span ("Rewind requested." returns into it),
 * so replays of its calls project uncut; the cut arms for a turn only once
 * the rewind turn has terminalized and the projected turn started after the
 * cut (its `turn.input` row seq > `hideThroughSeq`). Deterministic from the
 * journal — the same log always arms the same cuts (replay consistency).
 *
 * `modelCallId` is the as-of anchor (#325): the pair is selected from the
 * journal prefix BEFORE this call started (`checkpointRewindState(…,
 * modelCallId)`), so a replay of an earlier call from a longer final log arms
 * the pair that was completed THEN — a later pair (checkpointed, rewound, or
 * merely checkpointed after the call) neither arms nor disarms it. At call
 * time the anchor is a no-op (rows after `model.call_started` do not exist
 * yet), so live projection is unchanged.
 */
export function rewindContextCut(
  events: readonly AnyAgentEvent[],
  threadId: string,
  turnId: string,
  modelCallId: number,
): RewindContextCut | undefined {
  const state = checkpointRewindState(events, threadId, modelCallId);
  if (state.phase !== "completed") return undefined;
  const rewindResult = events.find(
    (event): event is Extract<AnyAgentEvent, { type: "tool.result" }> =>
      event.type === "tool.result" && event.seq === state.rewindResultSeq,
  );
  if (rewindResult === undefined) return undefined;
  const rewindTurnId = rewindResult.data.turnId;
  const terminalSeq = events.find(
    (event) =>
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.cancelled") &&
      event.data.turnId === rewindTurnId,
  )?.seq;
  if (terminalSeq === undefined) return undefined;
  const turnInput = events.find(
    (event) => event.type === "turn.input" && event.data.turnId === turnId,
  );
  if (turnInput === undefined || turnInput.seq <= terminalSeq) return undefined;
  return {
    checkpointResultSeq: state.checkpointResultSeq,
    rewindResultSeq: state.rewindResultSeq,
    hideThroughSeq: terminalSeq,
    summary: state.report,
  };
}

/**
 * The compact cut (#309) armed for one turn's projection (undefined = no
 * thread/compacted checkpoint precedes this turn). The marker appends after
 * the compact turn's summarization call completes, so the arm rule is a pure
 * seq comparison: the marker applies to turns whose `turn.input` seq is
 * strictly greater than the marker's — the compact turn's own calls project
 * uncut (the summarizer must read the full span), every later turn sees the
 * cut (`rows ≤ hideThroughSeq` leave the active context; the compact turn
 * itself and later rows stay, the summary riding as the compact turn's own
 * history — omp session-context.ts:339-343 "summary first" satisfied by the
 * compact turn being the first kept row). Deterministic from the journal —
 * the same log always arms the same cut (#116). No as-of modelCallId anchor
 * is needed (#325 discipline): the marker lands strictly between turns, so
 * no call ever replays across an armed/decision boundary.
 */
export interface ThreadCompactedCut {
  hideThroughSeq: number;
}

export function threadCompactedCut(
  events: readonly AnyAgentEvent[],
  turnId: string,
): ThreadCompactedCut | undefined {
  const turnInput = events.find(
    (event) => event.type === "turn.input" && event.data.turnId === turnId,
  );
  if (turnInput === undefined) return undefined;
  let marker: Extract<AnyAgentEvent, { type: "thread/compacted" }> | undefined;
  for (const event of events) {
    if (event.type === "thread/compacted" && event.seq < turnInput.seq) marker = event;
  }
  if (marker === undefined) return undefined;
  return { hideThroughSeq: marker.data.hideThroughSeq };
}

// ---------------------------------------------------------------------------
// todo journal — omp getLatestTodoPhasesFromEntries / details.phases recovery
// ---------------------------------------------------------------------------

export interface TodoJournalState {
  /** Latest canonical snapshot, ignoring this execution's own entries ([] when none). */
  previous: TodoPhase[];
  /**
   * Snapshot this execution already committed — present only when the crash
   * window between the journal append and the tool.result append swallowed
   * the result row (execution non-terminal, executor re-asked). The re-run
   * completes from this snapshot instead of re-applying a non-idempotent op.
   */
  interrupted: TodoPhase[] | undefined;
}

/**
 * Fold the latest canonical todo snapshot from the journal (omp
 * `getLatestTodoPhasesFromEntries` over tool-result details, projected to the
 * DO's typed `todo_phases` entries — only successful mutations write one, so
 * every entry is canonical; omp skips view/error details, which never land
 * here by construction).
 */
export function todoJournalState(
  events: readonly AnyAgentEvent[],
  executionId: string,
): TodoJournalState {
  let interrupted: TodoPhase[] | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== TODO_PHASES_ENTRY_TYPE) continue;
    if (event.data.executionId === executionId) {
      interrupted = event.data.phases;
      continue;
    }
    return { previous: event.data.phases, interrupted };
  }
  return { previous: [], interrupted };
}

/** Latest canonical todo snapshot regardless of execution (tests/UX consumers). */
export function latestTodoPhases(events: readonly AnyAgentEvent[]): TodoPhase[] {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === TODO_PHASES_ENTRY_TYPE) return event.data.phases;
  }
  return [];
}
