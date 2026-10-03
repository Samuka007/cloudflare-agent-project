import type { ToolResultPayload } from "@cap/agent-do";
import { threadIdFromExecutionId } from "./execution-id.js";

/**
 * The execution journal (unified-turn-state §1.2, model two): an append-only
 * op log on DO SQLite is the ONLY persisted state; everything else — derived
 * execution records, the session view — is its replay product (§0 rule 2).
 * Live writes and replay share one fold function, so I19 (replay
 * determinism) holds by construction.
 *
 * Journal write precedes every side effect: forward-to-client,
 * callback-to-agent, ack, tombstone (§0 rule 1, applied locally).
 */

export type ExecutionState = "RUNNING" | "COMPLETED" | "UNKNOWN" | "TOMBSTONE";

/**
 * One journal operation. The `kind` is the audit unit; every state mutation
 * the service ever performs appears here exactly once (re-delivered frames
 * are deduped BEFORE journaling — duplicates are not facts).
 */
export type JournalOp =
  | {
      kind: "session_opened";
      at: number;
      hostId: string;
      sessionId: string;
      bootId: string;
      /** Boot of the session this open replaces — the §8.5 tree baseline. */
      previousBootId: string | null;
      protocolVersion: number;
    }
  | { kind: "session_replaced"; at: number; hostId: string; oldSessionId: string }
  | { kind: "stale_session_rejected"; at: number; hostId: string; sessionId: string }
  | {
      kind: "dispatch";
      at: number;
      executionId: string;
      threadId: string;
      bootId: string;
      machineId: string;
      command: string;
      cwd: string;
      timeoutMs: number;
    }
  | { kind: "spawn_forwarded"; at: number; executionId: string; requestId: string }
  | { kind: "spawn_ack"; at: number; executionId: string; pid: number; pidStartedAt: number }
  | { kind: "spawn_failed"; at: number; executionId: string; error: string }
  | { kind: "output"; at: number; executionId: string; offset: number; text: string }
  | { kind: "output_dup_dropped"; at: number; executionId: string; offset: number }
  | { kind: "output_gap"; at: number; executionId: string; from: number; to: number }
  | { kind: "output_ack"; at: number; executionId: string; ackedOffset: number }
  | { kind: "exited"; at: number; executionId: string; status: ToolResultPayload["status"]; exitCode: number | null; finalOffset: number }
  | { kind: "cancel_requested"; at: number; executionId: string }
  | { kind: "kill_forwarded"; at: number; executionId: string; requestId: string }
  | { kind: "kill_receipt"; at: number; executionId: string; verified: boolean }
  | { kind: "orphan_suspect"; at: number; executionId: string }
  | { kind: "orphan_suspect_cleared"; at: number; executionId: string }
  | { kind: "outcome_unknown"; at: number; executionId: string }
  | { kind: "reconcile_action"; at: number; executionId: string; hostId: string; action: ReconcileAction }
  | { kind: "ack"; at: number; executionId: string; resultSeq: number }
  | { kind: "tombstone"; at: number; executionId: string };

export type ReconcileAction =
  | "resume"
  | "backfill"
  | "kill_list"
  | "outcome_unknown_direct"
  | "clean";

// ---------------------------------------------------------------------------
// Derived state (replay product).
// ---------------------------------------------------------------------------

export interface ExecutionRecord {
  executionId: string;
  threadId: string;
  machineId: string;
  command: string;
  /** Sandbox-relative working directory (client clamps into the root). */
  cwd: string;
  timeoutMs: number;
  bootId: string | null;
  state: ExecutionState;
  pid: number | null;
  pidStartedAt: number | null;
  spawnAcked: boolean;
  /** Contiguous journaled byte frontier for the merged output stream. */
  lastOffset: number;
  /** Highest gap end explicitly marked — implicit-gap detection uses it. */
  gapTo: number;
  /** Highest offset acked to the client (monotonic, ≤ lastOffset — I25). */
  ackedOffset: number;
  /** Accumulated output text (bytes ≤ gaps are missing → truncated). */
  outputText: string;
  outputTruncated: boolean;
  cancelRequested: boolean;
  timeoutKillForwarded: boolean;
  orphanSuspect: boolean;
  result: ToolResultPayload | null;
  createdAt: number;
}

export interface SessionRecord {
  hostId: string;
  sessionId: string;
  /** Boot of the replaced session; null on the machine's first session. */
  previousBootId: string | null;
  bootId: string;
  protocolVersion: number;
  /** Generation of the last ACCEPTED announce (I23). */
  generation: number;
  lastFingerprint: string | null;
  /** True between WS attach and reconcile completion (§8.2, I30). */
  syncing: boolean;
  /**
   * Memory-only lease deadline; rebuilt as now+LEASE on DO restart (honest
   * degradation: a restart with no attached WS converges to the orphan path).
   */
  leaseExpiresAt: number;
}

export interface ServiceStateData {
  readonly executions: Map<string, ExecutionRecord>;
  session: SessionRecord | null;
}

export function emptyServiceState(): ServiceStateData {
  return { executions: new Map(), session: null };
}

function recordOf(state: ServiceStateData, op: JournalOp & { executionId: string }): ExecutionRecord {
  let record = state.executions.get(op.executionId);
  if (record === undefined) {
    record = {
      executionId: op.executionId,
      threadId: threadIdFromExecutionId(op.executionId),
      machineId: "",
      command: "",
      cwd: ".",
      timeoutMs: 0,
      bootId: null,
      state: "RUNNING",
      pid: null,
      pidStartedAt: null,
      spawnAcked: false,
      lastOffset: 0,
      gapTo: 0,
      ackedOffset: 0,
      outputText: "",
      outputTruncated: false,
      cancelRequested: false,
      timeoutKillForwarded: false,
      orphanSuspect: false,
      result: null,
      createdAt: op.at,
    };
    state.executions.set(op.executionId, record);
  }
  return record;
}

/**
 * The single fold. Live writes call this immediately after the INSERT (same
 * transaction boundary); cold start calls it over the whole log in op_seq
 * order. It mutates ONLY from op data — never from live-frame data — which is
 * what makes live state and replayed state provably identical.
 */
export function foldOp(state: ServiceStateData, op: JournalOp): void {
  switch (op.kind) {
    case "session_opened": {
      state.session = {
        hostId: op.hostId,
        sessionId: op.sessionId,
        previousBootId: op.previousBootId,
        bootId: op.bootId,
        protocolVersion: op.protocolVersion,
        generation: 0,
        lastFingerprint: null,
        syncing: true,
        leaseExpiresAt: 0,
      };
      return;
    }
    case "session_replaced":
      return;
    case "stale_session_rejected":
      return;
    case "dispatch": {
      const record = recordOf(state, op);
      record.machineId = op.machineId;
      record.bootId = op.bootId;
      record.command = op.command;
      record.cwd = op.cwd;
      record.timeoutMs = op.timeoutMs;
      return;
    }
    case "spawn_forwarded":
      return;
    case "spawn_ack": {
      const record = recordOf(state, op);
      record.pid = op.pid;
      record.pidStartedAt = op.pidStartedAt;
      record.spawnAcked = true;
      return;
    }
    case "spawn_failed":
      return;
    case "output": {
      const record = recordOf(state, op);
      record.lastOffset = op.offset + op.text.length;
      record.outputText += op.text;
      return;
    }
    case "output_dup_dropped":
      return;
    case "output_gap": {
      const record = recordOf(state, op);
      record.outputTruncated = true;
      record.gapTo = Math.max(record.gapTo, op.to);
      return;
    }
    case "output_ack": {
      const record = recordOf(state, op);
      record.ackedOffset = Math.max(record.ackedOffset, op.ackedOffset);
      return;
    }
    case "exited": {
      const record = recordOf(state, op);
      record.state = "COMPLETED";
      record.result = {
        status: op.status,
        exitCode: op.exitCode,
        output: record.outputText,
        ...(record.outputTruncated ? { outputTruncated: true } : {}),
      };
      return;
    }
    case "cancel_requested": {
      recordOf(state, op).cancelRequested = true;
      return;
    }
    case "kill_forwarded":
      return;
    case "kill_receipt":
      return;
    case "orphan_suspect": {
      recordOf(state, op).orphanSuspect = true;
      return;
    }
    case "orphan_suspect_cleared": {
      recordOf(state, op).orphanSuspect = false;
      return;
    }
    case "outcome_unknown": {
      const record = recordOf(state, op);
      record.state = "UNKNOWN";
      record.result = { status: "outcome_unknown", exitCode: null, output: record.outputText };
      return;
    }
    case "reconcile_action":
      return;
    case "ack":
      return;
    case "tombstone": {
      const record = recordOf(state, op);
      record.state = "TOMBSTONE";
      // Result large field dropped at tombstone (§5.2.4); the journal ops
      // still replay the output text if ever needed for audit.
      record.result = null;
      return;
    }
  }
}

