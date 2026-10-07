import type { Env } from "../env.js";
import type { PendingInteractionRow, PromptContent } from "@cap/protocol";
import type { RelaySelection } from "@cap/agent-do";
import type {
  AdapterCommand,
  AdapterCommandOutcome,
  ProviderExecutionContext,
} from "@cap/daemon-worker";
import { resolveHarness } from "@cap/provider-app";
import { BB_DATA_DIR_LABEL } from "../shared/bb-display.js";

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
    /**
     * #288: the resolved binding's machine — freezes into
     * `thread.created.machineId` on the direct path. The composed path takes
     * the harness hostBinding instead (#31 identity discipline: the journal
     * host IS the composition machine; multi-host execution routing is #14).
     */
    machineId?: string;
    /**
     * #351: the create-time explicit selection (server-validated against the
     * catalog; journaled on thread.created and resolved through the
     * providerId-keyed relay registry at dispatch).
     */
    execution?: RelaySelection;
  }): Promise<{ threadId: string; duplicated: boolean }>;
  /**
   * #288 explicit rebind: appends `thread.rebound` (the trajectory half; the
   * threads row update is the caller's). Direct path only — the composed
   * single-host execution cannot follow a moved binding yet, so it fails
   * loudly instead of desyncing trajectory and execution.
   */
  rebindThread(args: { machineId: string; environmentId?: string }): Promise<{
    machineId: string;
    duplicated: boolean;
  }>;
  sendMessage(args: {
    clientRequestId: string;
    /** #317: the full journal prompt-content union rides the seam verbatim. */
    content: PromptContent[];
    mode: "auto" | "start" | "steer";
    /**
     * #351: a send-time selection ride — the route classified it `live`
     * (classifyThreadSelectionChange) before dispatching; the DO applies it
     * to the thread state BEFORE the turn rows so the new turn's pin and any
     * replay fold the same selection.
     */
    execution?: RelaySelection;
  }): Promise<{ turnId: string; steer: boolean; duplicated: boolean }>;
  getEvents(args: {
    sinceSeq: number;
    limit?: number;
    project?: "raw" | "ux";
  }): Promise<{ events: UxThreadEvent[]; latestSeq: number }>;
  /** Journal-folded pending interactions (#225); the interactions routes' source. */
  listInteractions(): Promise<{ interactions: PendingInteractionRow[] }>;
  /** Ruling backflow (M1.5 T4); the resolve route's write face. */
  resolveInteraction(args: {
    interactionId: string;
    resolution: unknown;
  }): Promise<{ accepted: boolean; duplicated: boolean }>;
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
  if (env.ORCHESTRATOR !== undefined && env.MANAGER !== undefined) {
    return orchestratorBackedRpc(env, threadId);
  }
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId));
  return stub as unknown as AgentDoRpc;
}

/**
 * Direct per-thread DO turn cancel (#226 stop route). The DO journal is the
 * sole truth for turn state (manager-do.ts consistency model: the registry's
 * activeTurnId is an advisory command-boundary mirror), so the control plane
 * cancels where the turn lives — the same direct-stub pattern as the events
 * reader inside orchestratorBackedRpc. Deliberately not the orchestrator's
 * thread/stop face: that one poisons the provider-session registry for an
 * interrupted turn (external-CLI recovery parity), and the composed edge-agent
 * path has no recovery consumer, so a routed stop would brick the thread's
 * next turn over a session the DO journal already folds clean.
 */
export function agentDoCancelTurn(
  env: Env,
  threadId: string,
  turnId: string,
): Promise<{ accepted: boolean }> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as Pick<
    AgentDoRpc,
    "cancelTurn"
  >;
  return stub.cancelTurn({ turnId });
}

/**
 * Direct per-thread DO compact (#309). Same direct-stub posture as
 * {@link agentDoCancelTurn}: the compact turn (summarization call + the
 * `thread/compacted` checkpoint) is journal state on the DO that owns the
 * transcript, so the control plane compacts where the context lives — the
 * composed orchestrator face has no compact command and must not grow one
 * for a pure journal operation.
 */
export function agentDoCompactThread(
  env: Env,
  threadId: string,
): Promise<{ turnId: string; duplicated: boolean }> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as {
    compactThread(args: { clientRequestId?: string }): Promise<{
      turnId: string;
      duplicated: boolean;
    }>;
  };
  return stub.compactThread({});
}

// ---------------------------------------------------------------------------
// Orchestrator-backed composition (#31): writes route
// server → daemon-worker (command journal, provider route) → provider-app
// (edge-agent adapter → manager registry → agent DO). Reads stay direct on
// the agent DO — bb's control plane reads the event log locally too.
// ---------------------------------------------------------------------------

/** Structural view of the HostOrchestratorDO journal RPC the bridge uses. */
export interface OrchestratorJournalRpc {
  ensureHost(args: {
    hostId: string;
  }): Promise<{ kind: "bound"; hostId: string } | { kind: "host_mismatch"; boundHostId: string }>;
  enqueueCommand(args: {
    type: string;
    command: AdapterCommand;
    threadId?: string;
  }): Promise<{ commandId: string; cursor: number }>;
  dispatchCommand(args: {
    commandId: string;
    route?: "provider" | "machine";
  }): Promise<
    | { kind: "settled"; outcome: AdapterCommandOutcome; attemptId: string }
    | { kind: "stale_settlement"; attemptId: string }
    | { kind: "accepted_async"; attemptId: string }
    | { kind: "not_dispatchable"; state: string }
    | { kind: "unknown_command" }
  >;
}

/** Structural view of the ManagerDo registry read the bridge uses. */
export interface ManagerRegistryRpc {
  providerSessionFor(threadId: string): Promise<{
    providerThreadId: string;
    activeTurnId: string | null;
    poisoned: boolean;
  } | null>;
}

/**
 * bb fills claudeCodeMockCliTraffic from app settings before dispatch
 * (execution-options.ts:180); the M0 fill is the disabled default (same fill
 * the daemon-worker fake uses).
 */
function bridgeContext(env: Env): ProviderExecutionContext {
  return {
    ...resolveHarness(env).execution,
    claudeCodeMockCliTraffic: { enabled: false, endpoint: "https://api.anthropic.com" },
  };
}

function bridgeFailure(
  where: string,
  outcome: Extract<AdapterCommandOutcome, { ok: false }>,
): never {
  throw new Error(`${where} failed: ${outcome.errorCode}: ${outcome.errorMessage}`);
}

/**
 * The composed provider lane's journal DO name (#31, #377). bb's
 * host_daemon_commands journal is per-host; the composed port funnels every
 * provider-route command through ONE journal DO whose name is deployment
 * routing, not a host claim — the command carries its own machineId (the
 * thread's frozen binding). Hardcoded: a var here could only ever re-create
 * the synthetic "local" identity #377 removes.
 */
const ORCHESTRATOR_JOURNAL_DO_NAME = "journal";

function orchestratorBackedRpc(env: Env, threadId: string): AgentDoRpc {
  const orchestratorNs = env.ORCHESTRATOR;
  const managerNs = env.MANAGER;
  if (orchestratorNs === undefined || managerNs === undefined) {
    throw new Error("composition requires the ORCHESTRATOR and MANAGER bindings");
  }
  const orchestrator = orchestratorNs.get(
    orchestratorNs.idFromName(ORCHESTRATOR_JOURNAL_DO_NAME),
  ) as unknown as OrchestratorJournalRpc;
  const manager = managerNs.get(managerNs.idFromName("manager")) as unknown as ManagerRegistryRpc;
  // Reads stay direct: the event log projection lives on the per-thread DO.
  const reader = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as Pick<
    AgentDoRpc,
    "getEvents" | "listInteractions" | "resolveInteraction" | "rebindThread"
  >;

  async function dispatch(command: AdapterCommand): Promise<AdapterCommandOutcome> {
    const ensured = await orchestrator.ensureHost({ hostId: ORCHESTRATOR_JOURNAL_DO_NAME });
    if (ensured.kind === "host_mismatch") {
      throw new Error(
        `orchestrator host mismatch: bound ${ensured.boundHostId}, got ${ORCHESTRATOR_JOURNAL_DO_NAME}`,
      );
    }
    const { commandId } = await orchestrator.enqueueCommand({
      type: command.type,
      command,
      threadId,
    });
    const outcome = await orchestrator.dispatchCommand({ commandId, route: "provider" });
    if (outcome.kind !== "settled") {
      const state = outcome.kind === "not_dispatchable" ? ` (${outcome.state})` : "";
      throw new Error(`orchestrator dispatch ${outcome.kind}${state}`);
    }
    return outcome.outcome;
  }

  return {
    async createThread(args) {
      const command: AdapterCommand = {
        type: "thread/start",
        threadId,
        // bb stamps config.dataDir here; on the port it is a display label
        // (the Worker has no fs) — #504.
        cwd: BB_DATA_DIR_LABEL,
        ...(args.machineId !== undefined ? { machineId: args.machineId } : {}),
        ...(args.execution !== undefined ? { execution: args.execution } : {}),
        ...(args.title ? { input: [{ type: "text", text: args.title, mentions: [] }] } : {}),
        options: bridgeContext(env),
        instructionMode: "append",
      };
      const outcome = await dispatch(command);
      if (!outcome.ok) bridgeFailure("thread/start", outcome);
      return { threadId, duplicated: false };
    },

    // The rebind append is a trajectory operation — it lands on the per-thread
    // DO exactly like resolveInteraction; composed execution keeps routing via
    // the journal host (bindings stay advisory there until #14).
    async rebindThread(rebindArgs) {
      return reader.rebindThread(rebindArgs);
    },

    async sendMessage(args) {
      const session = await manager.providerSessionFor(threadId);
      if (session === null) {
        throw new Error(`sendMessage failed: no provider session for thread ${threadId}`);
      }
      // The daemon seam's PromptInput already carries the full union (#317):
      // text is re-anchored with the mention list it loses over the RPC, the
      // image members forward verbatim for the provider application layer.
      const input: Extract<AdapterCommand, { type: "turn/start" }>["input"] = args.content.map(
        (part) =>
          part.type === "text" ? { type: "text" as const, text: part.text, mentions: [] } : part,
      );

      const steerTurn = async (): Promise<AdapterCommandOutcome | null> => {
        // bb turn/steer addresses the provider's active turn; the registry's
        // advisory mirror supplies the id. A stale mirror (turn already
        // terminal in the DO) answers not-ok — the caller falls back to start.
        if (session.activeTurnId === null) return null;
        return dispatch({
          type: "turn/steer",
          threadId,
          providerThreadId: session.providerThreadId,
          expectedTurnId: session.activeTurnId,
          input,
          clientRequestId: args.clientRequestId,
          options: bridgeContext(env),
          ...(args.execution !== undefined ? { execution: args.execution } : {}),
        });
      };

      if (args.mode === "steer") {
        const outcome = await steerTurn();
        if (outcome === null) {
          throw new Error(`sendMessage failed: steer requested with no active provider turn`);
        }
        if (!outcome.ok) bridgeFailure("turn/steer", outcome);
        const result = outcome.result as { turnId?: string };
        return { turnId: result.turnId ?? "", steer: true, duplicated: false };
      }
      if (args.mode === "auto") {
        const steered = await steerTurn();
        if (steered?.ok) {
          const result = steered.result as { turnId?: string };
          return { turnId: result.turnId ?? "", steer: true, duplicated: false };
        }
      }
      const outcome = await dispatch({
        type: "turn/start",
        threadId,
        providerThreadId: session.providerThreadId,
        input,
        clientRequestId: args.clientRequestId,
        options: bridgeContext(env),
        ...(args.execution !== undefined ? { execution: args.execution } : {}),
      });
      if (!outcome.ok) bridgeFailure("turn/start", outcome);
      const result = outcome.result as { turnId?: string; duplicated?: boolean };
      return { turnId: result.turnId ?? "", steer: false, duplicated: result.duplicated ?? false };
    },

    async getEvents(args) {
      return reader.getEvents(args);
    },

    async listInteractions() {
      // Journal fold lives on the per-thread DO; reads stay direct.
      return reader.listInteractions();
    },

    async resolveInteraction(args) {
      // The journal append + wake live on the per-thread DO (M1.5 T4).
      return reader.resolveInteraction(args);
    },

    async cancelTurn(args) {
      const session = await manager.providerSessionFor(threadId);
      // The registry mirror must agree with the caller's turn; a mismatch
      // means the turn already settled — nothing to stop.
      if (session?.activeTurnId !== args.turnId) {
        return { accepted: false };
      }
      const outcome = await dispatch({
        type: "thread/stop",
        threadId,
        providerThreadId: session.providerThreadId,
        activeTurnId: args.turnId,
      });
      if (!outcome.ok) bridgeFailure("thread/stop", outcome);
      const result = outcome.result as { interrupted?: boolean };
      return { accepted: result.interrupted ?? false };
    },

    // The daemon-service DO delivers execution updates itself (#30 forward
    // path); the control plane never originates them.
    async onExecutionUpdate(u) {
      const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as Pick<
        AgentDoRpc,
        "onExecutionUpdate"
      >;
      return stub.onExecutionUpdate(u);
    },
  };
}

/**
 * High-water sequence for a thread: 0 when the DO has no events (fresh or
 * not yet created). bb getLatestThreadSequence equivalent on the D1 events
 * table (data.ts:328) — here the log lives in the DO.
 */
export async function getLatestThreadSequence(env: Env, threadId: string): Promise<number> {
  const result = await agentDoFor(env, threadId).getEvents({
    sinceSeq: Number.MAX_SAFE_INTEGER,
    limit: 1,
  });
  return result.latestSeq;
}
