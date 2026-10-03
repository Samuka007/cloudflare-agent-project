/**
 * Daemon-service seam (outbound, toward ticket #30's daemon service DO).
 *
 * The agent DO is the only writer of turn/tool events and the ack authority;
 * the daemon service DO is the claim authority (unified-turn-state.md §3.6,
 * model two). This interface is the whole wire contract the agent DO needs:
 * dispatch with `executionId`, kill by `executionId`, ack by `executionId`.
 * Results flow back through `AgentDO.onExecutionUpdate` (self-routed by the
 * `threadId` prefix of the executionId).
 *
 * Delivery guarantees (§4.1): dispatch is at-least-once and deduplicated
 * service-side by the execution journal; results are delivered
 * at-least-once and deduplicated agent-side; ack is emitted only after the
 * `tool.result` event is durably appended.
 */

export interface ToolDispatchRequest {
  threadId: string;
  turnId: string;
  executionId: string;
  machineId: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Execution timeout policy — service DO enforces via kill on expiry. */
  timeoutMs: number;
}

export type DispatchOutcome =
  /** Journal had no completed record: spawned or re-attached to a live run;
   * updates arrive via `onExecutionUpdate`. */
  | { kind: "accepted" }
  /** Journal already holds the terminal result — zero client spawn (§3.5). */
  | { kind: "completed_cached"; result: ToolResultPayload }
  /** No live client session: explicit, persisted, never a hang (§5.1). */
  | { kind: "host_offline" };

export type ToolResultStatus =
  | "ok"
  | "error"
  | "timeout"
  | "cancelled"
  | "outcome_unknown";

export interface ToolResultPayload {
  status: ToolResultStatus;
  exitCode: number | null;
  output: string;
  outputTruncated?: boolean;
}

export type ExecutionUpdate =
  | {
      kind: "started";
      executionId: string;
      pid?: number;
      pidStartedAt?: number;
    }
  | { kind: "output"; executionId: string; offset: number; chunk: string }
  | { kind: "exited"; executionId: string; result: ToolResultPayload };

export interface DaemonServiceClient {
  dispatch(request: ToolDispatchRequest): Promise<DispatchOutcome>;
  /** Idempotent business cancel (§2.4): service journal dedups by executionId. */
  kill(executionId: string): Promise<void>;
  /**
   * Ack a persisted `tool.result` (seq identifies the log row). Service keeps
   * the result until ack, then tombstones (§8.4) — so ack must only ever be
   * sent after the append, never before.
   */
  ackExecution(executionId: string, resultSeq: number): Promise<void>;
  /**
   * Recovery re-ask (§4.1 "重问", §8.4 late-redelivery): results journaled
   * COMPLETED but not yet tombstoned (no ack). The agent DO re-ingests or
   * re-acks each — this is how a lost ack closes without a second spawn.
   */
  queryUnacked(threadId: string): Promise<Array<{ executionId: string; result: ToolResultPayload }>>;
}
