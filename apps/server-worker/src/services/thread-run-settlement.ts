import type { UxThreadEvent } from "../seam/agent-do.js";
import {
  evaluateThreadLifecycleEvent,
  type ThreadLifecycleEvent,
} from "../contract/domain/thread-lifecycle.js";
import { getThreadRow, updateThreadRecord } from "../db/control-plane.js";
import type { ThreadDbRow } from "../db/rows.js";
import type { Env } from "../env.js";

/**
 * Terminal-turn settlement (#52).
 *
 * The send route flips the coarse M0 execution status to `active` on
 * dispatch (routes/threads.ts), but nothing ever consumed the agent DO's
 * terminal `turn/completed` events, so the row never left `active`. The SPA
 * then derives a permanent busy state — the Working... surface never clears
 * (the census (#45 P0-3) shot it on completed and sealed-error threads
 * alike; with the #194 resolver it additionally mounted the
 * waiting-for-host banner, removed by #148).
 *
 * bb closes the same loop with the thread lifecycle FSM
 * (contract/domain/thread-lifecycle.ts): `run.succeeded` → idle,
 * `run.failed` → error. This module derives the lifecycle event from the
 * UX event log already fetched for timeline projection — the turnRequest
 * field on timeline rows is bb's request-admission state
 * (`pending|accepted|rejected`, pinned by the SPA zod schema) and is
 * deliberately NOT a turn-execution terminal.
 */

/**
 * Pure derivation of the run-settlement lifecycle event from a thread's UX
 * event log. Returns `null` while the latest turn is still in flight (a
 * `turn/started` after the last terminal event), when the log has no
 * terminal event, or when the log has no turns at all — in those cases the
 * status must stay untouched.
 */
export function deriveSettledTurnEvent(
  events: readonly UxThreadEvent[],
): ThreadLifecycleEvent | null {
  let lastStartedSeq = -1;
  let lastTerminal: { seq: number; status: string } | null = null;
  for (const event of events) {
    if (event.type === "turn/started") {
      lastStartedSeq = event.seq;
      continue;
    }
    if (event.type !== "turn/completed") {
      continue;
    }
    const data = event.data;
    if (data !== null && typeof data === "object" && "status" in data) {
      const status = data.status;
      if (
        typeof status === "string" &&
        (status === "completed" || status === "failed" || status === "interrupted")
      ) {
        lastTerminal = { seq: event.seq, status };
      }
    }
  }
  if (lastTerminal === null || lastTerminal.seq < lastStartedSeq) {
    return null;
  }
  // `interrupted` (turn cancelled) settles like a succeeded run: the coarse
  // M0 row has no dedicated cancelled cell, and idle is the correct
  // follow-up surface (bb maps stop.settled → idle the same way).
  return lastTerminal.status === "failed" ? { type: "run.failed" } : { type: "run.succeeded" };
}

export interface ThreadTurnSettlement {
  row: ThreadDbRow;
  event: ThreadLifecycleEvent;
}

/**
 * Settle the thread's execution status from terminal turn events. Reads the
 * freshest row before evaluating (the send route writes `active` on
 * dispatch) and leaves everything untouched when the FSM reports a no-op —
 * including the already-settled case, so repeated timeline fetches are
 * idempotent.
 */
export async function settleThreadTurnStatus(
  env: Env,
  row: ThreadDbRow,
  events: readonly UxThreadEvent[],
): Promise<ThreadTurnSettlement | null> {
  const event = deriveSettledTurnEvent(events);
  if (event === null) {
    return null;
  }
  const current = await getThreadRow(env, row.id);
  if (current === null) {
    return null;
  }
  const evaluation = evaluateThreadLifecycleEvent({ event, thread: current });
  if ("noop" in evaluation || evaluation.to === current.status) {
    return null;
  }
  const updated = await updateThreadRecord(env, current.id, { status: evaluation.to });
  if (updated === null) {
    return null;
  }
  return { row: updated.row, event };
}
