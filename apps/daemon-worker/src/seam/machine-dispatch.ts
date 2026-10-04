/**
 * Machine-execution seam (#30/#34 boundary).
 *
 * The orchestrator's machine-route dispatch targets the daemon-service DO
 * (POCService). That package is mid-flight and not on origin — cross-lane
 * incident rule #0 forbids importing it — so the seam is declared locally and
 * injected. Signature locked to the POCService surface:
 * `dispatch(executionId, threadId, command, timeout)`.
 *
 * Delivery is at-least-once; `accepted` means the execution journal owns the
 * run and results flow back asynchronously through `settleCommand` (the
 * journal's attempt lease bounds the wait). Outcome kinds rhyme with
 * packages/agent-do's DaemonServiceClient dispatch vocabulary so the fleet
 * keeps one mental model.
 */

import type { AdapterCommand, AdapterCommandResultValue } from "../provider-adapter.js";

export interface MachineCommandDispatchRequest {
  /**
   * `${threadId}:${seq}` per the fleet executionId convention (unified
   * turn state §0): the threadId prefix makes any holder self-route updates.
   */
  executionId: string;
  threadId: string;
  command: AdapterCommand;
  /** Execution timeout policy — the service enforces via kill on expiry. */
  timeoutMs: number;
}

export type MachineCommandDispatchOutcome =
  /** Journal had no completed record: spawned or re-attached to a live run. */
  | { kind: "accepted" }
  /** Journal already holds the terminal result — zero client work. */
  | { kind: "completed_cached"; result: AdapterCommandResultValue }
  /** No live client session: explicit, persisted, never a hang. */
  | { kind: "host_offline" };

export interface MachineCommandDispatcher {
  dispatch(request: MachineCommandDispatchRequest): Promise<MachineCommandDispatchOutcome>;
}

/**
 * Derive the self-routable executionId for a journaled machine command:
 * `${threadId}:${cursor}` — cursor is the per-host command journal sequence,
 * stable across retries of the same command.
 */
export function executionIdFor(threadId: string, cursor: number): string {
  return `${threadId}:${cursor}`;
}
