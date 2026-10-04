import type { AnyAgentEvent } from "../fsm-events.js";
import type { EdgeToolResult } from "./edge.js";
import {
  projectInbox,
  projectJobs,
  peerWaitLadderRungMs,
  WAIT_WINDOW_EXPIRED_PREFIX,
  type JobRecord,
  type JobRegistry,
  type PeerInbox,
} from "./job-registry.js";

/**
 * Edge `wait` (M1.5 T2, omp tools/wait.ts port): an argument-less blocking
 * wait over jobs this agent started and peer messages addressed to it —
 * "Work it did not start never sustains a wait: a peer owes no message"
 * (omp wait.ts:43-48). omp verbatim structure:
 * 1. queued messages are checked first (wait.ts:74-75);
 * 2. settled-but-undelivered owned jobs return without another wait
 *    (wait.ts:87-90) — the consumption semantics make double waits
 *    non-redelivering (retry-matrix §2.4);
 * 3. no wakable work → "Nothing to wait for" immediately (wait.ts:92-96);
 * 4. otherwise the call blocks in a wake race (Promise.race, wait.ts:136-144):
 *    owned-job settle / inbound message / safety cap / call abort, with the
 *    message-only ladder window replacing the cap when only running peers
 *    could wake it (docs/tools/wait.md:17);
 * 5. photo-finish: a dequeued message wins and the job remains deliverable;
 *    a job win leaves the message pending (wait.ts:156-159).
 *
 * The wake legs are level-triggered: after any wake the journal is re-queried
 * (single-writer DO, appends land before waiters fire), so per-leg identity
 * collapses into one wake channel and no update can be lost.
 */

/** omp wait.ts:25 — 30-minute safety cap (no caller-selectable timeout). */
export const WAIT_MAX_MS = 30 * 60_000;

/** omp wait.ts:92-96 verbatim error text. */
export const NOTHING_TO_WAIT_FOR =
  "Nothing to wait for: no background job or service you started is running. Other agents' results and messages arrive on their own.";

/** omp wait.ts:181 verbatim cap text. */
export const WAIT_LIMIT_REACHED =
  "Wait limit reached; background work may still be running. Read proc:// for status.";

export type WaitWakeKind = "job" | "message" | "cap" | "window" | "cancelled";

export interface WaitWake {
  kind: WaitWakeKind;
}

/**
 * DO-bound context for one wait execution. Storage/timer policy stays in the
 * DO (journal accessors + alarm tables + wake map); this module is pure
 * decision logic over journal projections.
 */
export interface WaitToolContext {
  executionId: string;
  threadId: string;
  /** tool.call seq of this wait execution (ladder projection anchor). */
  callSeq: number;
  /** This DO's agent identity (omp session.getAgentId); undefined = unowned. */
  ownerId: string | undefined;
  events(): Promise<readonly AnyAgentEvent[]>;
  registry: JobRegistry;
  inbox: PeerInbox;
  /** Peer ids that could message this agent (T19 binds the registry; T2 []). */
  runningPeers(): readonly string[];
  /** Registers the in-memory message-only window deadline (alarm-dispatched).
   * The 30-minute cap needs no registration — computeDueWork derives it from
   * the journal. */
  registerWindowDeadline(deadlineAt: number): void;
  /** Resolves on the next wake: owned-job settle, inbound message, cap/window
   * alarm, or call cancellation. */
  wake(): Promise<WaitWake>;
  config: {
    waitMaxMs: number;
    peerWaitLadderMs: readonly number[];
    peerLadderResetGapMs: number;
  };
  now(): number;
}

export async function runWaitTool(ctx: WaitToolContext): Promise<EdgeToolResult> {
  const events = await ctx.events();
  const drained = await takeMessage(ctx, events);
  if (drained !== undefined) return drained;
  const before = projectJobs(events);
  const undelivered = before.undeliveredJobs(ctx.ownerId);
  if (undelivered.length > 0) {
    return deliverJobs(ctx, undelivered, before.runningJobs(ctx.ownerId));
  }
  const running = before.runningJobs(ctx.ownerId);
  const peers = ctx.runningPeers();
  if (running.length === 0 && peers.length === 0) {
    return { status: "error", output: NOTHING_TO_WAIT_FOR };
  }
  // Message-only wait: only running peers can wake it, so the window is the
  // ladder rung instead of the 30-minute cap (docs/tools/wait.md:17).
  let windowMs: number | null = null;
  if (running.length === 0) {
    windowMs = peerWaitLadderRungMs(
      events,
      ctx.threadId,
      ctx.callSeq,
      ctx.config.peerWaitLadderMs,
      ctx.config.peerLadderResetGapMs,
    );
    ctx.registerWindowDeadline(ctx.now() + windowMs);
  }
  for (;;) {
    const wake = await ctx.wake();
    const fresh = await ctx.events();
    // Photo-finish order (omp wait.ts:156-159): a dequeued message wins and
    // the settled job remains deliverable; a lost message cannot be recovered.
    const message = await takeMessage(ctx, fresh);
    if (message !== undefined) return message;
    const projected = projectJobs(fresh);
    const settled = projected.undeliveredJobs(ctx.ownerId);
    if (settled.length > 0) return deliverJobs(ctx, settled, projected.runningJobs(ctx.ownerId));
    if (wake.kind === "cap") return { status: "ok", output: WAIT_LIMIT_REACHED };
    if (wake.kind === "window") {
      return { status: "ok", output: windowExpiredOutput(windowMs ?? 0, peers) };
    }
    if (wake.kind === "cancelled") return { status: "cancelled", output: "" };
    // Spurious wake (queue drained by another path): re-arm and wait again.
  }
}

/** Drain one pending message; consumption lands in the journal first. */
async function takeMessage(
  ctx: WaitToolContext,
  events: readonly AnyAgentEvent[],
): Promise<EdgeToolResult | undefined> {
  const message = projectInbox(events).pendingMessages(ctx.ownerId)[0];
  if (message === undefined) return undefined;
  await ctx.inbox.consume(message.messageId, ctx.executionId);
  // omp messaging.ts formatIncoming: `[${id}] ${from}: ${body}`.
  return { status: "ok", output: `[${message.messageId}] ${message.from}: ${message.text}` };
}

/** Deliver settled jobs (omp job-control.ts buildJobResult essential shape):
 * consumption is journaled before the result leaves the DO. */
async function deliverJobs(
  ctx: WaitToolContext,
  undelivered: readonly JobRecord[],
  running: readonly JobRecord[],
): Promise<EdgeToolResult> {
  const lines: string[] = [];
  if (undelivered.length > 0) {
    lines.push(`## Completed (${undelivered.length})`, "");
    for (const job of undelivered) {
      await ctx.registry.markDelivered(job.jobId, ctx.executionId);
      const settlement = job.settlement;
      lines.push(`### ${job.jobId} [${job.kind}] — ${settlement?.status ?? "ok"}`);
      lines.push(`Label: ${job.label}`);
      if (settlement?.status !== "cancelled") {
        lines.push("Delivery: not auto-delivered; recovered by this snapshot.");
      }
      if (settlement !== null && settlement.status === "ok" && settlement.output.length > 0) {
        lines.push("```", settlement.output, "```");
      }
      if (settlement !== null && settlement.status !== "ok") {
        lines.push(`Error: ${settlement.output}`);
      }
      lines.push("");
    }
  }
  if (running.length > 0) {
    lines.push(`## Still Running (${running.length})`, "");
    for (const job of running) {
      lines.push(`- \`${job.jobId}\` [${job.kind}] — ${job.label}`);
    }
  }
  return { status: "ok", output: lines.join("\n").trimEnd() };
}

/** Window expiry names the running peers (omp docs/tools/wait.md:17). The
 * WAIT_WINDOW_EXPIRED_PREFIX is the ladder projection's recognition anchor —
 * keep the output shape stable. */
function windowExpiredOutput(windowMs: number, peers: readonly string[]): string {
  return `${WAIT_WINDOW_EXPIRED_PREFIX} (${windowMs} ms window); no message arrived. Running peers: ${
    peers.length === 0 ? "none" : peers.join(", ")
  }.`;
}
