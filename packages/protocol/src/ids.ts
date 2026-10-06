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

/**
 * bb `packages/db/src/ids.ts` (commit 8473d8c33) byte-compatible host id:
 * nanoid custom alphabet + length, WebCrypto instead of nanoid to stay
 * Workers-native (server-worker shared/ids.ts port, shared here because the
 * daemon-service enroll face mints the id too — #377: an env-key enroll
 * without an explicit claim names a FRESH host instead of the deployment
 * identity, so two machines can never collapse onto one row again).
 */
const GENERATED_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const GENERATED_ID_SUFFIX_LENGTH = 10;

export function createHostId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(GENERATED_ID_SUFFIX_LENGTH));
  let suffix = "";
  for (const byte of bytes) {
    suffix += GENERATED_ID_ALPHABET.charAt(byte % GENERATED_ID_ALPHABET.length);
  }
  return `host_${suffix}`;
}

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
  events: readonly { seq: number }[],
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
