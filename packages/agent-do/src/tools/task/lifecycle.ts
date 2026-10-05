import type { AnyAgentEvent } from "../../fsm-events.js";
import { ownerVisible } from "../job-registry.js";
import type { SpawnPlanRecord } from "./types.js";

/**
 * M1.5 T19 subagent lifecycle (proposal §3 T19) — the four-state registry
 * fold over the journal. omp anchors: pi-tui agent-hub-types.ts:7 (the state
 * literal), agent-registry.ts:68-70/:161-170/:190-193 (session nullability,
 * registration CAS, tombstone resistance), agent-lifecycle.ts:1-21 (TTL
 * park), task semantics §4.2/§5 (omp-task-semantics.md).
 *
 * The fold is replay-pure: every transition derives from journal rows, so an
 * evicted DO refolds the identical registry (T18 replay-consistency shape).
 * Both journals project with the same function:
 *   - the PARENT journal carries `task.spawn_planned` / `task.spawn_settled`
 *     / kill tombstones for its children;
 *   - the CHILD journal carries `task.subagent_identity` / `task.yield_completed`
 *     plus its own park/revive/tombstone rows (the child owns its lifecycle —
 *     park is a local DO state write per the ticket DO budget).
 *
 * omp → DO mapping of "release session, keep ref + sessionFile": the session
 * file IS the journal (childThreadId's log); park flips the record to
 * `parked` with `sessionReleased: true` while the ref (agentId) and the
 * journal stay intact — `history://` remains readable parked (T17 face).
 */

/** omp agent-hub-types.ts:7 verbatim. */
export type SubagentLifecycleState = "running" | "idle" | "parked" | "aborted";

/**
 * omp abort classification (task semantics §4.2 table): budget/wall-clock
 * soft stops vs true kills. `budget` is the ONLY revivable abort.
 */
export type AbortReason = "budget" | "call_signal" | "wall_clock" | "kill" | "internal";

/** The reasons the abort RPC accepts — budget never arrives over the wire
 * (our T18 budget stop settles partial findings instead; the reason exists
 * so the fold rule and the asymmetry test can carry the omp semantics). */
export type HardAbortReason = Exclude<AbortReason, "budget">;

/**
 * omp executor.ts:2144-2147 asymmetry verbatim: "a soft stop that never
 * escalated still identifies as a budget abort so the lifecycle can park the
 * agent as resumable" — the fold maps a budget-abort row to `idle`, not the
 * tombstone; every other reason is terminal.
 */
export function abortRevivable(reason: AbortReason): boolean {
  return reason === "budget";
}

export interface LifecycleRecord {
  agentId: string;
  spawnId: string;
  /** The child DO address; null on the child's self-view (identity row). */
  childThreadId: string | null;
  state: SubagentLifecycleState;
  /**
   * The journal ref (sessionFile): survives park untouched — only the LIVE
   * session releases. null only before any row names a thread.
   */
  sessionFile: string | null;
  sessionReleased: boolean;
  /**
   * When the record went idle (completion-row timestamp, refreshed by
   * post-completion activity) — the TTL park deadline origin. null while
   * running/parked/aborted.
   */
  idleSince: number | null;
  abortReason: AbortReason | null;
  lastSeq: number;
}

export interface LifecycleView {
  record(agentId: string): LifecycleRecord | undefined;
  records(): LifecycleRecord[];
}

/**
 * The single-pass fold. Malformed rows are skipped like every other journal
 * projection; ordering is seq order (I1). Tombstone resistance (omp
 * agent-registry.ts:190-193): once `aborted`, later lifecycle rows for the
 * agent are confirm-only — they never flip the state.
 */
export function projectLifecycle(events: readonly AnyAgentEvent[]): LifecycleView {
  const records = new Map<string, LifecycleRecord>();
  /** The child-journal identity row's agent — `task.yield_completed` and
   * post-completion turn activity attach to it (child self-view). */
  let selfAgentId: string | null = null;

  const upsert = (
    agentId: string,
    spawnId: string,
    childThreadId: string | null,
    seq: number,
  ): LifecycleRecord => {
    const existing = records.get(agentId);
    if (existing?.state === "aborted") return existing;
    const record: LifecycleRecord = {
      agentId,
      spawnId,
      childThreadId: childThreadId ?? existing?.childThreadId ?? null,
      state: "running",
      sessionFile: childThreadId ?? existing?.sessionFile ?? null,
      sessionReleased: false,
      idleSince: null,
      abortReason: null,
      lastSeq: seq,
    };
    records.set(agentId, record);
    return record;
  };

  for (const event of events) {
    switch (event.type) {
      case "task.spawn_planned": {
        upsert(event.data.agentId, event.data.spawnId, event.data.childThreadId, event.seq);
        break;
      }
      case "task.subagent_identity": {
        selfAgentId = event.data.agentId;
        upsert(event.data.agentId, event.data.spawnId, null, event.seq);
        break;
      }
      case "task.spawn_settled": {
        const record = records.get(event.data.agentId);
        // Completion → idle + adopt (omp executor.ts:3292-3307: finished AND
        // failed subagents stay interrogable). A tombstone never flips.
        if (record?.state === "aborted") break;
        if (record !== undefined) {
          record.state = "idle";
          record.idleSince = event.createdAt;
          record.lastSeq = event.seq;
        }
        break;
      }
      case "task.yield_completed": {
        if (selfAgentId === null) break;
        const record = records.get(selfAgentId);
        if (record?.state === "aborted") break;
        if (record !== undefined) {
          record.state = "idle";
          record.idleSince = event.createdAt;
          record.lastSeq = event.seq;
        }
        break;
      }
      case "task.subagent_parked": {
        const record = records.get(event.data.agentId);
        // TTL park: only a genuinely idle record parks (Main never reaches
        // here — the DO guards the append; the fold stays defensive).
        if (record?.state !== "idle") break;
        record.state = "parked";
        record.sessionReleased = true;
        record.idleSince = null;
        record.lastSeq = event.seq;
        break;
      }
      case "task.subagent_revived": {
        const record = records.get(event.data.agentId);
        // Revival receipt (omp irc/bus.ts:139-143): parked → idle, session
        // live again from the transcript. Anywhere else it is confirm-only.
        if (record?.state !== "parked") break;
        record.state = "idle";
        record.sessionReleased = false;
        record.idleSince = null;
        record.lastSeq = event.seq;
        break;
      }
      case "task.subagent_aborted": {
        const record = records.get(event.data.agentId);
        if (record?.state === "aborted") break;
        if (record !== undefined) {
          if (abortRevivable(event.data.reason)) {
            // The one revivable abort: idle, resumable — never a tombstone.
            record.state = "idle";
            record.idleSince = event.createdAt;
            record.abortReason = event.data.reason;
          } else {
            record.state = "aborted";
            record.sessionReleased = true;
            record.idleSince = null;
            record.abortReason = event.data.reason;
          }
          record.lastSeq = event.seq;
        }
        break;
      }
      case "turn.completed":
      case "turn.cancelled": {
        // Post-completion activity refreshes the idle clock (a follow-up
        // turn after adopt restarts the TTL). Only meaningful on the child
        // self-view; parent journals carry no child turn rows.
        if (selfAgentId !== null) {
          const record = records.get(selfAgentId);
          if (record?.state === "idle") {
            record.idleSince = event.createdAt;
            record.lastSeq = event.seq;
          }
        }
        break;
      }
      case "experimental_context_notes":
      case "interaction.interrupted":
      case "interaction.registered":
      case "interaction.resolved":
      case "job.delivered":
      case "job.registered":
      case "job.settled":
      case "task.async_result":
      case "task.budget_notice":
      // #276 J5 activity backflow: not registry state.
      case "task.subagent_event":
      case "task.subagent_flush":
      case "task.yield_reminder":
      case "task.yield_warning":
      case "model.call_completed":
      case "model.call_failed":
      case "model.call_retry":
      case "model.call_sealed":
      case "model.call_started":
      case "model.delta":
      case "model.thinking":
      case "peer.message":
      case "peer.message_consumed":
      case "thread.created":
      case "todo_phases":
      case "tool.call":
      case "tool.dispatch":
      case "tool.exec_started":
      case "tool.output":
      case "tool.result":
      case "turn.cancel_requested":
      case "turn.phase":
      case "turn.failed":
      case "turn.input":
      case "turn.steer":
        break;
    }
  }

  return {
    record: (agentId) => records.get(agentId),
    records: () => [...records.values()],
  };
}

// ---------------------------------------------------------------------------
// Registration CAS — omp agent-registry.ts:161-170 registerIfAvailable: a
// registration claims an absent id or adopts the EXACT parked ref; anything
// else (running / idle / aborted / another agent's parked ref) is rejected.
// ---------------------------------------------------------------------------

export type RegistrationDecision =
  | { ok: true; mode: "claim" | "adopt" }
  | { ok: false; reason: string };

export function registerIfAvailable(
  view: LifecycleView,
  candidate: { agentId: string; spawnId: string },
): RegistrationDecision {
  const existing = view.record(candidate.agentId);
  if (existing === undefined) return { ok: true, mode: "claim" };
  if (existing.state === "parked" && existing.spawnId === candidate.spawnId) {
    return { ok: true, mode: "adopt" };
  }
  return {
    ok: false,
    reason: `agent ${candidate.agentId} is ${existing.state}; registration refused (CAS)`,
  };
}

// ---------------------------------------------------------------------------
// `write proc://<jobId>/kill` — the cancel entry 1 URI face (omp
// docs/tools/task.md:26/:158; wait.md:26). Business-cancel semantics (matrix
// §2.4): unknown job / foreign job are business errors, an already-settled
// job answers an idempotent receipt, only a running owned job kills.
// ---------------------------------------------------------------------------

/** Parse the kill URI; everything else is an unknown proc target. */
export function parseProcKillUri(uri: string): { jobId: string } | null {
  const match = /^proc:\/\/([^/?#]+)\/kill$/.exec(uri);
  const jobId = match?.[1];
  if (jobId === undefined || jobId === "") return null;
  return { jobId };
}

export type KillDecision =
  | { kind: "unknown_job"; jobId: string }
  | { kind: "forbidden"; jobId: string }
  | { kind: "already_settled"; jobId: string; settlementStatus: string }
  | { kind: "kill"; jobId: string; plan: SpawnPlanRecord | null };

/** The kill verdict for one proc://kill request (pure; DO renders/acts). */
export function decideKill(
  jobId: string,
  job:
    | { ownerId: string | null; status: string; settlement: { status: string } | null }
    | undefined,
  callerOwnerId: string | undefined,
  planForJob: (jobId: string) => SpawnPlanRecord | undefined,
): KillDecision {
  if (job === undefined) return { kind: "unknown_job", jobId };
  if (!ownerVisible(job.ownerId, callerOwnerId)) return { kind: "forbidden", jobId };
  if (job.status !== "running") {
    return {
      kind: "already_settled",
      jobId,
      settlementStatus: job.settlement?.status ?? "unknown",
    };
  }
  return { kind: "kill", jobId, plan: planForJob(jobId) ?? null };
}
