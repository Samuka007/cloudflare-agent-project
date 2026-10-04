import type { AnyAgentEvent } from "../fsm-events.js";
import { executionIdFor } from "../ids.js";

/**
 * M1.5 T2 JobRegistry — the FROZEN surface for the wave-4 task cluster
 * (proposal §3 T2: "JobRegistry（登记 ownerId/job 句柄/结算投递）在本票以接口+
 * 合成 job 形式冻结——task/eval 后台路径后续只消费不重设计").
 *
 * State model (practice 4/11): every fact is a journal entry (DO storage —
 * `job.registered` / `job.settled` / `job.delivered` / `peer.message` /
 * `peer.message_consumed`, fsm-events.ts); the records below are pure
 * projections replayed from the log, so job state survives eviction+replay
 * with zero non-derivable memory. Authoritative timers are DO alarms —
 * the 30-minute cap lives in computeDueWork (turn-state.ts), never in
 * setTimeout. Cross-DO traffic is limited to wake sources: a peer message
 * or steering notice arrives through AgentDO.deliverPeerMessage, which
 * appends before any waiter wakes.
 */

export type JobKind = "job" | "service";

export type JobSettlementStatus = "ok" | "error" | "cancelled";

/**
 * Canonical output prefix marking a wait that ended by message-only window —
 * the recognition anchor the ladder projection (peerWaitLadderRungMs) folds;
 * tools/wait.ts builds outputs with the same prefix.
 */
export const WAIT_WINDOW_EXPIRED_PREFIX = "Wait window elapsed";

export interface JobRegistration {
  jobId: string;
  /** Owning agent id (omp AsyncJob ownerId); null = unowned. */
  ownerId: string | null;
  kind: JobKind;
  label: string;
}

export interface JobSettlement {
  status: JobSettlementStatus;
  output: string;
}

export type JobStatus = "running" | "settled" | "delivered";

export interface JobRecord {
  jobId: string;
  ownerId: string | null;
  kind: JobKind;
  label: string;
  status: JobStatus;
  registeredSeq: number;
  settlement: JobSettlement | null;
  settledSeq: number | null;
  deliveredSeq: number | null;
}

export interface PeerMessageRecord {
  messageId: string;
  /** Recipient agent id within this DO. */
  ownerId: string;
  from: string;
  text: string;
  seq: number;
  consumedByExecutionId: string | null;
}

// ---------------------------------------------------------------------------
// Mutator faces — AgentDO binds them to appendEvent (persist-then-side-effect
// iron rule 1: the journal row lands before any waiter wakes). T16+ spawn /
// eval background paths call these; they never touch storage directly.
// ---------------------------------------------------------------------------

export interface JobRegistry {
  register(input: JobRegistration): Promise<void>;
  settle(jobId: string, settlement: JobSettlement): Promise<void>;
  /** Settlement delivery bookkeeping: the result was consumed by a wait or
   * injected as async-result, so no second delivery follows (retry-matrix
   * §2.4 wait row: 消费语义使双 wait 不重复投递). */
  markDelivered(jobId: string, byExecutionId: string): Promise<void>;
}

export interface PeerInbox {
  deliver(message: {
    /** Client-supplied idempotency key; duplicate ids append nothing (I2). */
    messageId: string;
    ownerId: string;
    from: string;
    text: string;
  }): Promise<{ messageId: string; duplicated: boolean }>;
  consume(messageId: string, byExecutionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Owner filter — omp job-control.ts visibleJobs verbatim: an unowned caller
// sees only unowned jobs; ownership is strict equality otherwise ("Work it
// did not start never sustains a wait", omp wait.ts:43-48).
// ---------------------------------------------------------------------------

export function ownerVisible(
  recordOwnerId: string | null,
  callerOwnerId: string | undefined,
): boolean {
  if (callerOwnerId === undefined) return recordOwnerId === null;
  return recordOwnerId === callerOwnerId;
}

// ---------------------------------------------------------------------------
// Pure projections — fold the journal; malformed/dangling entries are skipped,
// never fatal (latestContextNotes precedent).
// ---------------------------------------------------------------------------

export interface JobView {
  job(jobId: string): JobRecord | undefined;
  runningJobs(ownerId: string | undefined): JobRecord[];
  /** Settled but not yet delivered — exactly what a wait returns first. */
  undeliveredJobs(ownerId: string | undefined): JobRecord[];
}

export function projectJobs(events: readonly AnyAgentEvent[]): JobView {
  const jobs = new Map<string, JobRecord>();
  for (const event of events) {
    if (event.type === "job.registered") {
      jobs.set(event.data.jobId, {
        jobId: event.data.jobId,
        ownerId: event.data.ownerId,
        kind: event.data.kind,
        label: event.data.label,
        status: "running",
        registeredSeq: event.seq,
        settlement: null,
        settledSeq: null,
        deliveredSeq: null,
      });
    } else if (event.type === "job.settled") {
      const job = jobs.get(event.data.jobId);
      if (job?.status !== "running") continue;
      job.status = "settled";
      job.settlement = { status: event.data.status, output: event.data.output };
      job.settledSeq = event.seq;
    } else if (event.type === "job.delivered") {
      const job = jobs.get(event.data.jobId);
      if (job === undefined || job.status === "running") continue;
      job.status = "delivered";
      job.deliveredSeq = event.seq;
    }
  }
  const visible = (ownerId: string | undefined) =>
    [...jobs.values()].filter((job) => ownerVisible(job.ownerId, ownerId));
  return {
    job: (jobId) => jobs.get(jobId),
    runningJobs: (ownerId) => visible(ownerId).filter((job) => job.status === "running"),
    undeliveredJobs: (ownerId) => visible(ownerId).filter((job) => job.status === "settled"),
  };
}

export interface InboxView {
  message(messageId: string): PeerMessageRecord | undefined;
  /** Delivered but unconsumed, oldest first (omp drainPendingInbox order). */
  pendingMessages(ownerId: string | undefined): PeerMessageRecord[];
}

export function projectInbox(events: readonly AnyAgentEvent[]): InboxView {
  const messages = new Map<string, PeerMessageRecord>();
  for (const event of events) {
    if (event.type === "peer.message") {
      if (messages.has(event.data.messageId)) continue;
      messages.set(event.data.messageId, {
        ...event.data,
        seq: event.seq,
        consumedByExecutionId: null,
      });
    } else if (event.type === "peer.message_consumed") {
      const message = messages.get(event.data.messageId);
      if (message === undefined) continue;
      message.consumedByExecutionId = event.data.byExecutionId;
    }
  }
  return {
    message: (messageId) => messages.get(messageId),
    pendingMessages: (ownerId) =>
      [...messages.values()].filter(
        (message) =>
          message.consumedByExecutionId === null &&
          (ownerId === undefined || message.ownerId === ownerId),
      ),
  };
}

// ---------------------------------------------------------------------------
// Message-only wait ladder (omp docs/tools/wait.md:17): when only running
// peers can wake the wait, consecutive message-only windows step 5 / 10 / 30 /
// 60 / 300 seconds; a gap of at least 60 seconds (peerLadderResetGapMs) resets
// the rung, and so does a prior wait that ended any other way. Pure over the
// journal — recomputed after eviction+replay, no hidden state.
// ---------------------------------------------------------------------------

export function peerWaitLadderRungMs(
  events: readonly AnyAgentEvent[],
  threadId: string,
  callSeq: number,
  ladderMs: readonly number[],
  resetGapMs: number,
): number {
  const waitCallSeqs = events
    .filter(
      (event) => event.type === "tool.call" && event.data.tool === "wait" && event.seq < callSeq,
    )
    .map((event) => event.seq);
  // This call's journal row (seq is 1-based) anchors the gap measurement.
  const thisCall = events[callSeq - 1];
  let consecutive = 0;
  for (let index = waitCallSeqs.length - 1; index >= 0; index--) {
    const seq = waitCallSeqs[index];
    if (seq === undefined) break;
    const executionId = executionIdFor(threadId, seq);
    const result = events.find(
      (event) => event.type === "tool.result" && event.data.executionId === executionId,
    );
    if (result?.type !== "tool.result") break;
    if (typeof result.data.output !== "string") break;
    if (!result.data.output.startsWith(WAIT_WINDOW_EXPIRED_PREFIX)) break;
    const gapMs = thisCall === undefined ? 0 : thisCall.createdAt - result.createdAt;
    if (gapMs >= resetGapMs) break;
    consecutive += 1;
  }
  return ladderMs[Math.min(consecutive, ladderMs.length - 1)] ?? ladderMs[0] ?? 0;
}
