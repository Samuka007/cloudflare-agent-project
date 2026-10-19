import type { PendingInteractionRow, PromptContent, ThreadEventEnvelope } from "@cap/protocol";
import type { RelaySelection } from "@cap/agent-config";
import type { Env } from "../env";

/**
 * The control-plane ⇄ pi-durable agent seam. Every thread's journal and turn
 * state live in the per-thread `AGENT_DO` (one DO per thread via
 * `idFromName(threadId)`); this module is the only RPC surface the control
 * plane programs against.
 */
export interface AgentDoRpc {
  createThread(args: {
    threadId: string;
    title: string;
    machineId?: string;
    execution?: RelaySelection;
  }): Promise<{ threadId: string; duplicated: boolean }>;
  rebindThread(args: { machineId: string; environmentId?: string }): Promise<{
    machineId: string;
    duplicated: boolean;
  }>;
  sendMessage(args: {
    clientRequestId: string;
    content: PromptContent[];
    mode: "auto" | "start" | "steer";
    execution?: RelaySelection;
  }): Promise<{ turnId: string; steer: boolean; duplicated: boolean }>;
  getEvents(args: {
    sinceSeq: number;
    limit?: number;
    project?: "raw" | "ux";
    window?: { beforeSeq?: number };
  }): Promise<{
    events: UxThreadEvent[];
    latestSeq: number;
    window?: {
      windowStartSeq: number;
      floorSeq: number;
      dataBytes: number;
      hasOlderRows: boolean;
    };
  }>;
  listInteractions(): Promise<{ interactions: PendingInteractionRow[] }>;
  resolveInteraction(args: {
    interactionId: string;
    resolution: unknown;
  }): Promise<{ accepted: boolean; duplicated: boolean }>;
  cancelTurn(args: { turnId: string }): Promise<{ accepted: boolean }>;
  compactThread(args: {
    clientRequestId?: string;
    mode?: "soft" | "remote" | "snap";
    remote?: { providerId: string; model: string };
  }): Promise<{ turnId: string; duplicated: boolean }>;
  onExecutionUpdate(u: {
    executionId: string;
    kind: "started" | "output" | "exited";
    [key: string]: unknown;
  }): Promise<{ duplicate: boolean; acked: boolean }>;
}

/**
 * bb ThreadEventRow envelope. `data` stays unknown at this seam: the journal
 * is typed per event by consumers, and the durable projection is deliberately
 * schema-lenient at the boundary.
 */
export type UxThreadEvent = Omit<ThreadEventEnvelope, "data"> & { data: unknown };

export function agentDoFor(env: Env, threadId: string): AgentDoRpc {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId));
  return stub as unknown as AgentDoRpc;
}

/** Direct per-thread cancel; the durable DO aborts the active run. */
export function agentDoCancelTurn(
  env: Env,
  threadId: string,
  turnId: string,
): Promise<{ accepted: boolean }> {
  return agentDoFor(env, threadId).cancelTurn({ turnId });
}

/** Direct per-thread compact; the durable DO owns the Transcript. */
export function agentDoCompactThread(
  env: Env,
  threadId: string,
  request: {
    mode?: "soft" | "remote" | "snap";
    remote?: { providerId: string; model: string };
  } = {},
): Promise<{ turnId: string; duplicated: boolean }> {
  return agentDoFor(env, threadId).compactThread(request);
}

/** High-water sequence; 0 when the thread's journal is empty. */
export async function getLatestThreadSequence(env: Env, threadId: string): Promise<number> {
  const result = await agentDoFor(env, threadId).getEvents({
    sinceSeq: Number.MAX_SAFE_INTEGER,
    limit: 1,
  });
  return result.latestSeq;
}
