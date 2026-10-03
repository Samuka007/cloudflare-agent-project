/**
 * Identifier helpers shared by every side of the contract.
 *
 * Ids are opaque strings with a type prefix so log/DB inspection stays
 * readable. `eventRowId` is the canonical (threadId, seq) projection used as
 * the event-log primary key. The `new*Id` constructors are the exported domain
 * vocabulary used in lockstep by the fake-edge store, the fake daemon and the
 * tests — inlining `newId("thr")` at each site would scatter the prefix
 * convention.
 */

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export const newThreadId = (): string => newId("thr");
export const newTurnId = (): string => newId("turn");
export const newItemId = (): string => newId("itm");
export const newEventId = (): string => newId("evt");
export const newCallId = (): string => newId("call");
export const newSessionId = (): string => newId("sess");

/** Canonical id for an event-log row. Unique per (threadId, seq). */
export function eventRowId(threadId: string, seq: number): string {
  return `${threadId}:${seq}`;
}

/**
 * First seq of every thread's event log. Sequences are contiguous, 1-based,
 * server-assigned, and never reused.
 */
export const FIRST_SEQ = 1;

/**
 * Check that `events` are contiguous ascending from FIRST_SEQ (optionally from
 * `fromSeq` when replaying a suffix). Used by store implementations and tests
 * to pin the replay contract.
 */
export function isSeqContiguous(
  events: ReadonlyArray<{ seq: number }>,
  fromSeq: number = FIRST_SEQ,
): boolean {
  if (events.length === 0) return true;
  let expected = fromSeq;
  for (const event of events) {
    if (event.seq !== expected) return false;
    expected += 1;
  }
  return true;
}
