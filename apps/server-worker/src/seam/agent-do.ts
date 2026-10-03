import type { Env } from "../env.js";

/**
 * The #26 ⇄ #29 seam. Event storage and turn state live in the per-thread
 * AgentDO (packages/agent-do, binding AGENT_DO, one DO per thread via
 * idFromName(threadId)); this control plane reads through the RPC surface
 * AgentDO committed to (see ticket #29 thread and packages/agent-do):
 *
 * - createThread({threadId, title}) → appends thread.created; idempotent
 * - sendMessage({clientRequestId, content, mode}) → input-first persist;
 *   duplicate clientRequestId returns the existing turn, no new events;
 *   steer=true means recorded as a steer on the active turn
 * - getEvents({sinceSeq, limit?, project?}) → {events, latestSeq}; the
 *   envelope is bb ThreadEventRow {id, threadId, seq, type, data, createdAt};
 *   project:"ux" returns the protocol UX union (turn/started, item/started,
 *   item/agentMessage/delta, item/completed, turn/completed, system/error)
 * - cancelTurn({turnId}) → {accepted}
 * - onExecutionUpdate(u) → daemon-service callback (#30)
 */
export interface AgentDoRpc {
  createThread(args: {
    threadId: string;
    /** Log-bootstrap title; empty string when the thread is created untitled
     * (control-plane D1 keeps `title: null` for SPA titleFallback display). */
    title: string;
  }): Promise<{ threadId: string; seq: number }>;
  sendMessage(args: {
    clientRequestId: string;
    content: Array<{ type: "text"; text: string }>;
    mode: "auto" | "start" | "steer";
  }): Promise<{ turnId: string; steer: boolean; duplicated: boolean }>;
  getEvents(args: {
    sinceSeq: number;
    limit?: number;
    project?: "raw" | "ux";
  }): Promise<{ events: UxThreadEvent[]; latestSeq: number }>;
  cancelTurn(args: { turnId: string }): Promise<{ accepted: boolean }>;
  onExecutionUpdate(u: {
    executionId: string;
    kind: "started" | "output" | "exited";
    [key: string]: unknown;
  }): Promise<{ duplicate: boolean; acked: boolean }>;
}

/** bb ThreadEventRow envelope (contract/domain/thread-events.ts buildThreadEventRow). */
export interface UxThreadEvent {
  id: string;
  threadId: string;
  seq: number;
  type: string;
  data: unknown;
  createdAt: number;
}

export function agentDoFor(env: Env, threadId: string): AgentDoRpc {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId));
  return stub as unknown as AgentDoRpc;
}

/**
 * High-water sequence for a thread: 0 when the DO has no events (fresh or
 * not yet created). bb getLatestThreadSequence equivalent on the D1 events
 * table (data.ts:328) — here the log lives in the DO.
 */
export async function getLatestThreadSequence(
  env: Env,
  threadId: string,
): Promise<number> {
  const result = await agentDoFor(env, threadId).getEvents({
    sinceSeq: Number.MAX_SAFE_INTEGER,
    limit: 1,
  });
  return result.latestSeq;
}
