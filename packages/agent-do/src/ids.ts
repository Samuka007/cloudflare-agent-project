/**
 * Identifier derivation for the agent DO.
 *
 * `executionId` is the end-to-end idempotency key (unified-turn-state.md §0):
 * `${threadId}:${callSeq}` where `callSeq` is the seq of the originating
 * `tool.call` event. It is derived from the log, never minted — eviction,
 * replay and re-dispatch all reconstruct the identical value without
 * coordination, and the `threadId` prefix self-routes any recovery message
 * back to the owning DO.
 */

export function executionIdFor(threadId: string, callSeq: number): string {
  return `${threadId}:${callSeq}`;
}

/** Inverse of {@link executionIdFor} (threadIds never contain `:`). */
export function threadIdFromExecutionId(executionId: string): string {
  const idx = executionId.lastIndexOf(":");
  if (idx <= 0) throw new Error(`malformed executionId: ${executionId}`);
  return executionId.slice(0, idx);
}

export function callSeqFromExecutionId(executionId: string): number {
  const idx = executionId.lastIndexOf(":");
  if (idx <= 0) throw new Error(`malformed executionId: ${executionId}`);
  const seq = Number(executionId.slice(idx + 1));
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error(`malformed executionId: ${executionId}`);
  }
  return seq;
}
