import type { ToolResultErrorCode } from "@cap/protocol";

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
  /**
   * Workspace binding leg (#290 C1): which registered workspace the frame's
   * tool calls resolve against on the target machine; structural mirror of
   * daemon-service WorkspaceRef. Unset until the binding feed lands
   * (inventory #282 §2.A) — the daemon then falls back to its sandbox.
   */
  workspace?: { id: string; path: string };
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

export type ToolResultStatus = "ok" | "error" | "timeout" | "cancelled" | "outcome_unknown";

export interface ToolResultPayload {
  status: ToolResultStatus;
  exitCode: number | null;
  output: string;
  outputTruncated?: boolean;
  /**
   * #454: structured refusal code when the tool never executed (execution
   * suspension #73) — the contract owner is @cap/protocol tool-results;
   * every not-executed generation point (pre-dispatch rejections, the
   * dispatch host_offline placeholder) carries it, and the model face
   * renders the code in its marker. Never set for results of a real run.
   */
  errorCode?: ToolResultErrorCode;
  /**
   * B1 (#321): image artifacts this tool produced, by host-disk path. Each
   * lands its own `imageView` journal row (parentToolCallId = the call
   * executionId) before the closing tool.result; the wire twin is
   * daemon-service toolResultPayloadSchema.images.
   */
  images?: { path: string }[];
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
  queryUnacked(threadId: string): Promise<{ executionId: string; result: ToolResultPayload }[]>;
  /**
   * T20 #110 task-isolation op (synchronous host-op RPC): prepare or release
   * an isolated workspace for a child spawn. Unlike `dispatch` the result
   * resolves THIS call — there is no agent-side execution state and no
   * onExecutionUpdate round trip (the service DO owns a dedicated waiter).
   */
  isolationOp(request: {
    machineId: string;
    threadId: string;
    op: "prepare" | "release";
    arguments: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<IsolationOpOutcome>;
  /**
   * B2 (#322): synchronous thread-file write RPC — land one edge-produced
   * image on the host disk under the thread's storage root. Unlike
   * `dispatch` the result resolves THIS call (one DO request, no agent-side
   * execution state); the ok path feeds the imageView journal fold.
   */
  hostThreadFileWrite(request: {
    machineId: string;
    threadId: string;
    filename: string;
    contentBase64: string;
    timeoutMs: number;
  }): Promise<HostThreadFileWriteOutcome>;
  /** B1 read face over the same stub — B2's `input[].path` resolution. */
  hostThreadFileRead(request: {
    machineId: string;
    path: string;
    timeoutMs: number;
  }): Promise<HostThreadFileReadOutcome>;
}

/** Mirror of DaemonServiceDO's IsolationOpOutcome (structural seam). */
export type IsolationOpOutcome =
  | { kind: "ok"; result: ToolResultPayload }
  | { kind: "error"; error: string }
  | { kind: "host_offline" };

/** Mirror of DaemonServiceDO's HostThreadFileWriteOutcome (structural seam):
 * the B2 (#322) thread-file write — the write twin of the B1 host-file read
 * face. `error` carries the daemon dispatch code verbatim
 * (invalid_path/file_too_large/…). */
export type HostThreadFileWriteOutcome =
  | { kind: "ok"; path: string }
  | { kind: "error"; errorCode: string; errorMessage: string }
  | { kind: "host_offline" }
  | { kind: "timeout" };

/** Mirror of DaemonServiceDO's HostThreadFileReadOutcome (structural seam):
 * the B1 host-file read face, consumed B2-side to resolve generate_image
 * `input[].path` legs. Only the base64 encoding is meaningful for images. */
export type HostThreadFileReadOutcome =
  | { kind: "ok"; content: string; contentEncoding: "base64" | "utf8"; mimeType?: string }
  | { kind: "error"; errorCode: string; errorMessage: string }
  | { kind: "host_offline" }
  | { kind: "timeout" };
