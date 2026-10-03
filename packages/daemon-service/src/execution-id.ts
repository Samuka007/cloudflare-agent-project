/**
 * executionId derivation (unified-turn-state §0: `${threadId}:${callSeq}`).
 *
 * The canonical generators live in packages/agent-do (the agent DO mints
 * executionIds when `tool.call` is journaled). This package only needs the
 * reverse projection — threadId from an executionId — for self-routing
 * (§4.1: any node holding an executionId knows the owning thread), and it
 * cannot import that helper without inverting the seam dependency direction
 * (agent-do → daemon-service at the RPC boundary). Duplicated deliberately;
 * flagged in the package README for later promotion into packages/protocol.
 */

export function threadIdFromExecutionId(executionId: string): string {
  const sep = executionId.indexOf(":");
  if (sep <= 0) {
    throw new Error(`malformed executionId: ${executionId}`);
  }
  return executionId.slice(0, sep);
}
