import { DurableObject } from "cloudflare:workers";
import { Cause, Effect, Exit } from "effect";
import {
  threadEventsAppendedMessage,
  pendingInteractionChangedMessage,
  realtimeClientMessageSchema,
  type PendingInteractionPayload,
  type PendingInteractionResolution,
  type RealtimeSubscriptionTarget,
} from "@cap/protocol";
import { EventLog } from "./event-log.js";
import {
  applyEvent,
  computeDueWork,
  emptyReplayState,
  executionTerminal,
  replayEvents,
  turnTerminal,
  type ExecutionRuntime,
  type ReplayState,
} from "./turn-state.js";
import type { AgentEventDataByType, AgentEventRecord, AgentEventType } from "./fsm-events.js";
import { parseAgentEvent, type AnyAgentEvent } from "./fsm-events.js";
import { executionIdFor, threadIdFromExecutionId } from "./ids.js";
import {
  DEFAULT_WATCHDOG_CONFIG,
  WATCHDOG_CONFIG_KV_KEY,
  decodeWatchdogConfig,
  mergeWatchdogConfig,
  parseWatchdogConfigPatch,
  type WatchdogConfig,
} from "./config.js";
import type {
  DaemonServiceClient,
  DispatchOutcome,
  ExecutionUpdate,
  ToolResultPayload,
} from "./daemon.js";
import { ModelProviderError, type ModelRequest, type ModelStreamChunk } from "./provider.js";
import { projectToUxEvents } from "./ux-projection.js";
import { getAgentRuntime } from "./injection.js";
import { modelRequestFromEvents } from "./translate.js";
import { toolRegistryRow, type ToolRegistryRow } from "./tools/registry.js";
import { latestContextNotes, runEdgeTool, type EdgeToolContext } from "./tools/edge.js";
import {
  projectInbox,
  type JobRegistration,
  type JobRegistry,
  type JobSettlement,
  type PeerInbox,
} from "./tools/job-registry.js";
import { WAIT_LIMIT_REACHED, type WaitToolContext, type WaitWake } from "./tools/wait.js";
import {
  settleSpawn,
  NO_YIELD_WARNING,
  type RunSubagentRequest,
  type SubagentSpawnHost,
  type TaskToolContext,
} from "./tools/task/executor.js";
import {
  canSpawnAtDepth,
  lastYieldResult,
  projectSpawnPlans,
  settlementForSpawn,
} from "./tools/task/types.js";
import { childAssignment } from "./tools/task/plan.js";
import { renderYieldOutput } from "./tools/yield.js";
import {
  interactionForExecution,
  timeoutAutoSelect,
  renderAskOutput,
  validateAskResolution,
  type AskToolContext,
  type AskWake,
} from "./tools/ask.js";
import { checkpointRewindState, todoJournalState } from "./tools/session-tree.js";

/**
 * Per-thread bare Durable Object (no Agents SDK — docs/research/cf-agents-sdk.md):
 * the sole authority for the turn FSM and the append-only event log.
 *
 * Iron rules (unified-turn-state.md §0), all enforced here:
 * 1. persist, then side-effect — every append lands in SQLite (synchronous,
 *    inside the platform confirmation barrier) before any WS push, provider
 *    call, dispatch, kill or ack leaves the DO;
 * 2. replay is truth — `this.state` is always the fold of the log via
 *    `applyEvent`; cold start re-derives everything, memory holds no
 *    non-derivable truth;
 * 3. one recovery verb — re-dispatch / re-ask with the same `executionId`;
 *    dedup happens at the service journal and here;
 * 4. uncertainty fails loudly — outcome-unknown is a persisted terminal
 *    state; the recovery machinery never silently re-runs a tool.
 */

export interface AgentDoBindings {
  /** Optional JSON patch over the default watchdog config (env var). */
  AGENT_DO_WATCHDOG?: string;
  /**
   * Daemon-service DO namespace (production: ticket #30's DO; tests: the
   * reference fake). When present it wins over the in-process registry —
   * stubs resolved inside the DO carry the correct I/O context.
   */
  DAEMON_SERVICE?: DurableObjectNamespace;
  /** R2 bucket for oversize payloads; required only when payloads exceed
   * `r2BypassBytes`. */
  BLOBS?: R2Bucket;
  /**
   * This DO's own namespace, bound only in the composed deployment: the
   * daemon-service DO's `forwardToAgent` targets it by threadId (§3.6 ack
   * path). Unbound in the pure-fake test rig.
   */
  AGENT_DO?: DurableObjectNamespace;
}

export class AgentRpcError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid" | "wrong_thread" | "no_runtime",
    message: string,
  ) {
    super(message);
    this.name = "AgentRpcError";
  }
}

/**
 * Structural RPC view of a sibling AgentDO reached through the AGENT_DO
 * namespace binding (M1.5 T16): the spawn host on the child side, the
 * completion target on the parent side. Hand-written — the typed-stub
 * mapping collapses unless every member stays RPC-serializable.
 */
interface SubagentDoStub {
  createThread(request: CreateThreadRequest): Promise<CreateThreadResult>;
  runSubagent(request: RunSubagentRequest): Promise<{ turnId: string; duplicated: boolean }>;
  completeSubagent(request: {
    spawnId: string;
    agentId: string;
    status: "ok" | "error";
    output: string;
  }): Promise<{ duplicated: boolean }>;
}

export interface CreateThreadRequest {
  threadId: string;
  title: string;
  machineId?: string;
}

export interface CreateThreadResult {
  threadId: string;
  duplicated: boolean;
}

export interface SendMessageRequest {
  /** Client-generated idempotency key (protocol `clientRequestId`). */
  clientRequestId: string;
  content: { type: "text"; text: string }[];
  mode: "auto" | "start" | "steer";
}

export interface SendMessageResult {
  turnId: string;
  /** True when the input was recorded as a steer on the active turn. */
  steer: boolean;
  /** True when this exact clientRequestId was already persisted (I2). */
  duplicated: boolean;
}

export interface GetEventsRequest {
  sinceSeq?: number;
  limit?: number;
  project?: "raw" | "ux";
}

export interface GetEventsResult {
  /**
   * Raw agent events. `project: "ux"` collapses these to protocol
   * ThreadEventEnvelopes — structurally envelope-compatible, so callers read
   * the same seq/type/data fields. The type must stay RPC-serializable (no
   * `unknown` members) or the typed-stub mapping collapses to `never`.
   */
  events: AnyAgentEvent[];
  latestSeq: number;
}

export interface CancelTurnRequest {
  turnId: string;
}

export interface CancelTurnResult {
  accepted: boolean;
}

export interface ExecutionUpdateResult {
  duplicate: boolean;
  acked: boolean;
}

type ModelCallOutcome =
  | {
      kind: "completed";
      modelCallId: number;
      text: string;
      toolCalls: { name: string; arguments: Record<string, unknown> }[];
    }
  | { kind: "sealed"; modelCallId: number }
  | { kind: "cancelled"; modelCallId: number }
  | { kind: "failed_pre_first_byte"; modelCallId: number; attempt: number }
  | { kind: "failed"; modelCallId: number };

/** Typed error channel for a provider pull failure. */
class ProviderPullFailure {
  constructor(readonly error: unknown) {}
}

export class AgentDO extends DurableObject<AgentDoBindings> {
  private readonly log: EventLog;
  private cfg: WatchdogConfig;
  private state: ReplayState = emptyReplayState();
  private threadId: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly activeDrivers = new Map<string, AbortController>();
  private readonly execWaiters = new Map<
    string,
    { turnId: string; wake: (forced: boolean) => void }[]
  >();
  /**
   * Blocked edge executors (M1.5 T2: `wait`), keyed by executionId. The wake
   * channel is one-shot per wait loop iteration: settle/deliver wake
   * broadcast, cap/window come from the alarm, cancelled from the kill path.
   * Journal appends always land before the wake fires, so the executor's
   * re-query sees the change that woke it.
   */
  private readonly edgeWaiters = new Map<string, { resolve: (wake: WaitWake) => void }>();
  /**
   * Blocked ask executors (M1.5 T4), keyed by executionId. Wakes: the
   * resolveInteraction ruling backflow, the turn kill path (interrupt), or
   * the alarm-carried ask-timeout expiry. Journal appends always land before
   * the wake fires, so the executor's re-query sees the change that woke it.
   */
  private readonly askWaiters = new Map<string, { resolve: (wake: AskWake) => void }>();
  /** In-memory message-only ladder windows (executionId → deadlineAt); the
   * 30-minute cap lives in computeDueWork's journal-derived table instead. */
  private readonly waitWindows = new Map<string, number>();
  /**
   * In-flight task executors (M1.5 T16), keyed by executionId — the same
   * dedup the wait tool gets from edgeWaiters: dispatch and watchdog races
   * must not fork a second spawn for one executionId. Recovery (sequential
   * re-dispatch after eviction) re-adopts through the journal instead
   * (planForExecution).
   */
  private readonly taskRuns = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: AgentDoBindings) {
    super(ctx, env);
    this.cfg = decodeWatchdogConfig(env.AGENT_DO_WATCHDOG, DEFAULT_WATCHDOG_CONFIG);
    this.log = new EventLog(ctx.storage, env.BLOBS, this.cfg.r2BypassBytes);
    this.state = this.loadState();
    if (this.state.threadId !== null) this.threadId = this.state.threadId;
  }

  // -------------------------------------------------------------------------
  // Public RPC surface (consumed by apps/server-worker and ticket #30's DO)
  // -------------------------------------------------------------------------

  async createThread(request: CreateThreadRequest): Promise<CreateThreadResult> {
    await this.ready();
    if (this.threadId !== null) {
      if (this.threadId !== request.threadId) {
        throw new AgentRpcError(
          "wrong_thread",
          `DO owns thread ${this.threadId}, got ${request.threadId}`,
        );
      }
      return { threadId: request.threadId, duplicated: true };
    }
    this.threadId = request.threadId;
    await this.appendEvent("thread.created", {
      title: request.title,
      machineId: request.machineId ?? "local",
    });
    this.armWatchdog();
    return { threadId: request.threadId, duplicated: false };
  }

  /** Input-first-persist (ruling on #23): the event lands before anything runs. */
  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    await this.ready();
    this.requireThread();
    const existing = this.state.inputIds.get(request.clientRequestId);
    if (existing !== undefined) {
      return { turnId: existing.turnId, steer: existing.kind === "steer", duplicated: true };
    }
    const active = this.activeTurn();
    const wantSteer = request.mode === "steer" || (request.mode === "auto" && active !== undefined);
    if (wantSteer) {
      if (active === undefined) {
        throw new AgentRpcError("invalid", "steer requested with no active turn");
      }
      if (turnTerminal(active)) {
        throw new AgentRpcError(
          "invalid",
          `steer on terminal turn ${active.turnId} (${active.status}) — send a new input instead`,
        );
      }
      const record = await this.appendEvent("turn.steer", {
        turnId: active.turnId,
        inputId: request.clientRequestId,
        content: request.content,
      });
      return { turnId: record.data.turnId, steer: true, duplicated: false };
    }
    if (active !== undefined) {
      throw new AgentRpcError(
        "conflict",
        `turn ${active.turnId} is active (${active.status}); use mode "auto" or "steer"`,
      );
    }
    const turnId = `turn_${crypto.randomUUID()}`;
    const record = await this.appendEvent("turn.input", {
      turnId,
      inputId: request.clientRequestId,
      content: request.content,
    });
    this.armWatchdog();
    this.ctx.waitUntil(this.driveTurn(record.data.turnId));
    return { turnId, steer: false, duplicated: false };
  }

  async getEvents(request: GetEventsRequest): Promise<GetEventsResult> {
    await this.ready();
    const threadId = this.requireThread();
    const sinceSeq = request.sinceSeq ?? 0;
    const limit = request.limit ?? 10_000;
    const { events, latestSeq } = await this.log.read(threadId, sinceSeq, limit);
    if (request.project === "ux") {
      return { events: projectToUxEvents(events) as unknown as AnyAgentEvent[], latestSeq };
    }
    return { events, latestSeq };
  }

  async cancelTurn(request: CancelTurnRequest): Promise<CancelTurnResult> {
    await this.ready();
    this.requireThread();
    const turn = this.state.turns.get(request.turnId);
    if (turn === undefined) throw new AgentRpcError("not_found", `unknown turn ${request.turnId}`);
    if (turnTerminal(turn)) return { accepted: false };
    await this.appendEvent("turn.cancel_requested", { turnId: request.turnId });
    this.activeDrivers.get(request.turnId)?.abort();
    await this.killNonTerminalExecutions(request.turnId);
    return { accepted: true };
  }

  /**
   * Peer-message wake source (M1.5 T2, proposal §3: "no cross-DO RPC except
   * wake sources"). Journal-first: the `peer.message` row lands before any
   * blocked wait wakes, so a message survives eviction+replay and a replayed
   * wait re-projects it. Idempotent by messageId (I2 pattern).
   */
  async deliverPeerMessage(request: {
    /** Client-supplied idempotency key; default UUID when omitted. */
    messageId?: string;
    ownerId: string;
    from: string;
    text: string;
  }): Promise<{ messageId: string; duplicated: boolean }> {
    await this.ready();
    this.requireThread();
    const messageId = request.messageId ?? crypto.randomUUID();
    const existing = projectInbox((await this.readAllEvents()).events).message(messageId);
    if (existing !== undefined) return { messageId, duplicated: true };
    await this.appendEvent("peer.message", {
      messageId,
      ownerId: request.ownerId,
      from: request.from,
      text: request.text,
    });
    this.wakeAllEdgeWaiters({ kind: "message" });
    return { messageId, duplicated: false };
  }

  /**
   * JobRegistry mutators (M1.5 T2 frozen surface — T16/T18 spawn paths
   * register background work here, child-completion paths settle it). The
   * settle broadcast wakes every blocked wait; each re-queries its own
   * owner-filtered projection, so foreign jobs never sustain a wait.
   */
  async registerJob(input: JobRegistration): Promise<void> {
    await this.ready();
    this.requireThread();
    await this.appendEvent("job.registered", {
      jobId: input.jobId,
      ownerId: input.ownerId,
      kind: input.kind,
      label: input.label,
    });
  }

  async settleJob(jobId: string, settlement: JobSettlement): Promise<void> {
    await this.ready();
    this.requireThread();
    await this.appendEvent("job.settled", {
      jobId,
      status: settlement.status,
      output: settlement.output,
    });
    this.wakeAllEdgeWaiters({ kind: "job" });
  }

  // ---------------------------------------------------------------------------
  // Subagent drive + completion (M1.5 T16) — the child-facing entry the
  // parent's task executor calls, and the child→parent wake source. Both are
  // journal-first: identity/settlement rows land before any turn drive or
  // waiter wake (iron rule 1).
  // ---------------------------------------------------------------------------

  /**
   * Child bring-up (called on the CHILD DO through the AGENT_DO binding):
   * persist the subagent identity, then reuse sendMessage's input-first-persist
   * + I2 dedup by keying the turn input on `spawnId`. A re-invocation (recovery
   * re-dispatch of the parent's executor after eviction) finds the identity row
   * and answers `duplicated` without re-driving anything — cross-DO spawn
   * dedup (T16 acceptance).
   */
  async runSubagent(request: RunSubagentRequest): Promise<{ turnId: string; duplicated: boolean }> {
    await this.ready();
    this.requireThread();
    const identity = this.state.subagentIdentity;
    if (identity !== null) {
      if (identity.spawnId !== request.spawnId) {
        throw new AgentRpcError(
          "conflict",
          `DO already owns subagent ${identity.spawnId}; got ${request.spawnId}`,
        );
      }
      const firstTurn = this.state.turns.values().next().value;
      if (firstTurn === undefined) {
        throw new AgentRpcError("not_found", "subagent identity exists but no turn was driven");
      }
      return { turnId: firstTurn.turnId, duplicated: true };
    }
    await this.appendEvent("task.subagent_identity", {
      spawnId: request.spawnId,
      agentId: request.agentId,
      parentThreadId: request.parentThreadId,
      // bb dual-axis shape (bb-fleet-shape §1/§8): the T16 spawn path writes
      // the hierarchy axis only; the fork axis stays null until the fork
      // paths land (T17+).
      sourceThreadId: null,
      originKind: null,
      depth: request.depth,
    });
    return this.sendMessage({
      clientRequestId: request.spawnId,
      content: [{ type: "text", text: childAssignment(request.task) }],
      mode: "start",
    });
  }

  /**
   * Child-completion wake source (called on the PARENT DO by the child's
   * terminal hook): journal-first `task.spawn_settled` (idempotent by
   * spawnId — duplicates append nothing, cross-DO message dedup), then the
   * T2 settle for background jobs (which wakes owner-filtered waits), then
   * the `task.async_result` backflow row the parent's next run projects,
   * and finally the blocking executor's wake.
   */
  async completeSubagent(request: {
    spawnId: string;
    agentId: string;
    status: "ok" | "error";
    output: string;
  }): Promise<{ duplicated: boolean }> {
    await this.ready();
    this.requireThread();
    const { events } = await this.readAllEvents();
    const plan = projectSpawnPlans(events).find((record) => record.spawnId === request.spawnId);
    if (plan === undefined) {
      throw new AgentRpcError("not_found", `no spawn plan for ${request.spawnId}`);
    }
    if (settlementForSpawn(events, request.spawnId) !== undefined) {
      return { duplicated: true };
    }
    // Journal-first settlement (delivery text arrives summary-capped from the
    // child's rendering path — settleSpawn on the parent caps it defensively).
    await settleSpawn(this.taskSpawnSink(), {
      spawnId: plan.spawnId,
      jobId: plan.jobId,
      agentId: plan.agentId,
      childThreadId: plan.childThreadId,
      status: request.status,
      output: request.output,
    });
    if (plan.mode === "background" && plan.jobId !== null) {
      // Backflow marker for the parent's next run boundary; settleSpawn's
      // registry.settle already woke blocked waits, so ordering here is
      // journal-visible before the next turn's projection reads it.
      await this.appendEvent("task.async_result", {
        spawnId: plan.spawnId,
        agentId: plan.agentId,
        jobId: plan.jobId,
        status: request.status,
        output: request.output,
      });
    }
    this.wakeEdgeWaiter(plan.executionId, { kind: "job" });
    return { duplicated: false };
  }

  /** Journal mutator face for the task settlement path (settleSpawn input). */
  private taskSpawnSink(): {
    recordSpawnSettlement: TaskToolContext["recordSpawnSettlement"];
    registry: Pick<JobRegistry, "register" | "settle">;
    config: TaskToolContext["config"];
  } {
    return {
      recordSpawnSettlement: async (settlement) => {
        await this.appendEvent("task.spawn_settled", settlement);
      },
      registry: {
        register: (input: JobRegistration) => this.registerJob(input),
        settle: (jobId: string, settlement: JobSettlement) => this.settleJob(jobId, settlement),
      },
      config: this.taskConfig(),
    };
  }

  private taskConfig(): TaskToolContext["config"] {
    return {
      maxRecursionDepth: this.cfg.taskMaxRecursionDepth,
      asyncEnabled: this.cfg.taskAsyncEnabled,
      maxOutputBytes: this.cfg.taskMaxOutputBytes,
      maxOutputLines: this.cfg.taskMaxOutputLines,
      inlineSummaryCapChars: this.cfg.taskInlineSummaryCapChars,
    };
  }

  /**
   * Ruling backflow (M1.5 T4; the SPA's resolve action, bb `interactive.resolve`
   * command shape): the resolution is validated against the registered
   * questions BEFORE the journal row, so only valid rulings exist in the log
   * and an executor re-ask after eviction renders the same answer. Invalid or
   * late backflow never disturbs the pending row; a duplicate ruling is
   * absorbed (resolutions are at-most-once, I6 pattern).
   */
  async resolveInteraction(request: {
    interactionId: string;
    resolution: PendingInteractionResolution;
  }): Promise<{ accepted: boolean; duplicated: boolean }> {
    await this.ready();
    this.requireThread();
    const interaction = this.state.interactions.get(request.interactionId);
    if (interaction === undefined) {
      throw new AgentRpcError("not_found", `unknown interaction ${request.interactionId}`);
    }
    if (interaction.status === "resolved") return { accepted: false, duplicated: true };
    if (interaction.status === "interrupted") {
      throw new AgentRpcError("invalid", `interaction ${request.interactionId} was interrupted`);
    }
    const { events } = await this.readAllEvents();
    const projection = interactionForExecution(events, interaction.executionId);
    if (projection === undefined) {
      throw new AgentRpcError(
        "not_found",
        `interaction ${request.interactionId} has no registered questions`,
      );
    }
    const validated = validateAskResolution(projection.payload, request.resolution);
    if (!validated.ok) {
      throw new AgentRpcError("invalid", validated.reason);
    }
    try {
      await this.appendEvent("interaction.resolved", {
        interactionId: request.interactionId,
        resolution: request.resolution,
      });
    } catch (error) {
      // Lost the journal race against a concurrent resolve: at-most-once row
      // wins, the loser reports duplicate instead of surfacing an FSM error.
      if (this.state.interactions.get(request.interactionId)?.status === "resolved") {
        return { accepted: false, duplicated: true };
      }
      throw error;
    }
    const resolution = request.resolution;
    this.wakeAskWaiter(interaction.executionId, { kind: "resolved", resolution });
    return { accepted: true, duplicated: false };
  }

  /**
   * Callback for ticket #30's daemon service DO (self-routed by the
   * executionId threadId prefix). Duplicates are absorbed here — the log
   * only ever receives well-formed, first-instance events (I6/I7).
   */
  async onExecutionUpdate(update: ExecutionUpdate): Promise<ExecutionUpdateResult> {
    await this.ready();
    this.requireThread();
    const executionId = update.executionId;
    if (threadIdFromExecutionId(executionId) !== this.threadId) {
      throw new AgentRpcError("wrong_thread", `executionId ${executionId} not routed here`);
    }
    const execution = this.state.executions.get(executionId);
    if (execution === undefined) {
      // Late update for an execution whose turn already failed via watchdog
      // leaves no execution row? Rows persist; undefined means forged id.
      throw new AgentRpcError("not_found", `unknown executionId ${executionId}`);
    }
    if (update.kind === "started") {
      if (executionTerminal(execution) || execution.execStarted) {
        return { duplicate: true, acked: false };
      }
      await this.appendEvent("tool.exec_started", {
        turnId: execution.turnId,
        executionId,
        pid: update.pid,
        pidStartedAt: update.pidStartedAt,
      });
      return { duplicate: false, acked: false };
    }
    if (update.kind === "output") {
      if (executionTerminal(execution) || update.offset < execution.lastOutputOffset) {
        return { duplicate: true, acked: false };
      }
      await this.appendEvent("tool.output", {
        turnId: execution.turnId,
        executionId,
        offset: update.offset,
        chunk: update.chunk,
      });
      return { duplicate: false, acked: false };
    }
    if (executionTerminal(execution)) {
      // Duplicate result delivery: zero log delta; re-ack so the service can
      // tombstone (I6 second clause, I21).
      const resultSeq = execution.resultSeq ?? 0;
      await this.daemon().ackExecution(executionId, resultSeq);
      return { duplicate: true, acked: true };
    }
    await this.ingestResult(execution, update.result);
    return { duplicate: false, acked: true };
  }

  // -------------------------------------------------------------------------
  // WebSocket (hibernation) — internal push surface for I3; the public /ws
  // fan-out is owned by apps/server-worker's hub, which may also just relay.
  // -------------------------------------------------------------------------

  override fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
      return new Response("agent-do: not found", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready();
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof message === "string" ? message : new TextDecoder().decode(message),
      );
    } catch {
      ws.send(JSON.stringify({ type: "unsubscribed", target: { kind: "thread-list" } }));
      return;
    }
    const clientMessage = realtimeClientMessageSchema.safeParse(parsed);
    if (!clientMessage.success) return;
    const target: RealtimeSubscriptionTarget = clientMessage.data.target;
    if (
      target.kind === "thread-detail" &&
      this.threadId !== null &&
      target.threadId !== this.threadId
    ) {
      throw new AgentRpcError(
        "wrong_thread",
        `subscription targets foreign thread ${target.threadId}`,
      );
    }
    ws.send(JSON.stringify({ type: clientMessage.data.type, target }));
  }

  override webSocketClose(_ws: WebSocket, _code: number, _reason: string, _clean: boolean): void {
    // Hibernation: the platform tears the socket down; no subscription state
    // is bound to the socket object, so there is nothing to release here.
  }

  // -------------------------------------------------------------------------
  // Alarm watchdog (§2.5): single alarm, deadline table recomputed from state
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    try {
      await this.ready();
      const now = Date.now();
      // Message-only ladder windows fire first (in-memory table; practice 4:
      // the DO alarm is the authoritative timer, never setTimeout).
      for (const [executionId, deadlineAt] of this.waitWindows) {
        if (now < deadlineAt) continue;
        this.waitWindows.delete(executionId);
        this.wakeEdgeWaiter(executionId, { kind: "window" });
      }
      const due = computeDueWork(this.state, this.cfg, now);
      for (const modelCallId of due.sealedModelCallIds) {
        await this.sealModelCall(modelCallId);
      }
      // Wait caps resolve BEFORE re-asks and turn expiry: the cap result is
      // the terminal promise for the blocked execution (computeDueWork
      // extended the turn watchdog to the same deadline).
      for (const executionId of due.waitCapExecutionIds) {
        await this.resolveWaitCap(executionId);
      }
      // Ask expiry (M1.5 T4) resolves BEFORE re-asks and turn expiry: the
      // auto-selected ruling is the terminal promise for the blocked ask
      // (computeDueWork extended the turn watchdog to the same deadline).
      for (const executionId of due.interactionExpiryExecutionIds) {
        await this.resolveInteractionExpiry(executionId);
      }
      for (const executionId of due.reaskExecutionIds) {
        const execution = this.state.executions.get(executionId);
        if (execution === undefined || executionTerminal(execution)) continue;
        await this.dispatchExecution(execution.turnId, executionId);
      }
      for (const turnId of due.turnWatchdogExpiredTurnIds) {
        await this.expireTurnWatchdog(turnId);
      }
      this.armWatchdog();
    } catch (error) {
      // Alarms retry at most 6 times platform-side, then vanish forever —
      // self-continue instead (docs/research/do-turn-lifecycle-safety.md §3).
      console.error("agent-do alarm handler failed; re-arming", error);
      await this.ctx.storage.setAlarm(Date.now() + 1_000).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Recovery (cold start) — the only place the log is read back wholesale
  // -------------------------------------------------------------------------

  private loadState(): ReplayState {
    const rows = this.ctx.storage.sql
      .exec<{
        seq: number;
        id: string;
        thread_id: string;
        type: string;
        data: string;
        created_at: number;
      }>("SELECT seq, id, thread_id, type, data, created_at FROM events ORDER BY seq")
      .toArray();
    const events = rows.map((row) =>
      parseAgentEvent({
        id: row.id,
        threadId: row.thread_id,
        seq: row.seq,
        type: row.type,
        data: JSON.parse(row.data),
        createdAt: row.created_at,
      }),
    );
    const state = replayEvents(events);
    this.knownEventCount = state.eventCount;
    return state;
  }

  private knownEventCount = 0;

  private async ready(): Promise<void> {
    this.readyPromise ??= this.recover();
    return this.readyPromise;
  }

  /**
   * Recovery verbs on cold start (§3.0 matrix), in order:
   * A — seal running model calls (never re-call; at-most-once billing);
   * I — resume cancellation kills; E — re-dispatch non-terminal executions
   * with the same executionId (service journal dedups); then re-fork turn
   * drivers so partially completed turns converge.
   */
  private async recover(): Promise<void> {
    if (this.threadId === null) return;
    const persistedCfgRaw = this.ctx.storage.kv.get<string>(WATCHDOG_CONFIG_KV_KEY);
    this.cfg = decodeWatchdogConfig(
      persistedCfgRaw ?? this.env.AGENT_DO_WATCHDOG,
      DEFAULT_WATCHDOG_CONFIG,
    );
    // 1. Ruling A: seal model calls with no terminal event.
    for (const call of [...this.state.modelCalls.values()]) {
      if (call.status === "running") await this.sealModelCall(call.modelCallId);
    }
    // 2. Ruling I: cancellation promises convergence — re-arm kills.
    for (const turn of this.state.turns.values()) {
      if (turn.status === "cancelling") await this.killNonTerminalExecutions(turn.turnId);
    }
    // 3. Ruling E: re-ask every non-terminal execution (deduped downstream).
    for (const execution of [...this.state.executions.values()]) {
      if (executionTerminal(execution)) continue;
      if (execution.attempts >= this.cfg.maxDispatchAttempts) continue;
      if (execution.tool === "wait" || execution.tool === "ask") {
        // Blocking edge executors park on their wake channels — awaiting them
        // here would deadlock recovery itself (every RPC gates on ready()).
        // Start detached: a lost run stays non-terminal and the next
        // recovery re-asks again (same at-least-once dispatch as ever).
        void this.dispatchExecution(execution.turnId, execution.executionId).catch(
          (error: unknown) => {
            console.error(`recovery dispatch of ${execution.executionId} failed`, error);
          },
        );
        continue;
      }
      await this.dispatchExecution(execution.turnId, execution.executionId);
    }
    // 4. Ruling F closure: results journaled by the service but not acked
    // (crash between append and ack) are re-delivered; the dedup here
    // re-acks terminals and ingests unknowns — never a second spawn (I21).
    try {
      const unacked = await this.daemon().queryUnacked(this.threadId);
      for (const entry of unacked) {
        const execution = this.state.executions.get(entry.executionId);
        if (execution === undefined) continue;
        if (executionTerminal(execution)) {
          if (execution.resultSeq !== null) {
            await this.daemon().ackExecution(entry.executionId, execution.resultSeq);
          }
          continue;
        }
        await this.ingestResult(execution, entry.result);
      }
    } catch {
      // Service unreachable during recovery: watchdog re-asks later.
    }
    // 5. Resume drivers for turns that are still live.
    for (const turn of this.state.turns.values()) {
      if (turnTerminal(turn)) continue;
      if (this.activeDrivers.has(turn.turnId)) continue;
      this.ctx.waitUntil(this.driveTurn(turn.turnId));
    }
    this.armWatchdog();
  }

  // -------------------------------------------------------------------------
  // Event append — the single write path; side effects only ever follow
  // -------------------------------------------------------------------------

  private async appendEvent<TType extends AgentEventType>(
    type: TType,
    data: AgentEventDataByType[TType],
    createdAt: number = Date.now(),
  ): Promise<AgentEventRecord<TType>> {
    if (this.threadId === null) throw new AgentRpcError("not_found", "thread not created");
    const record = await this.log.append<TType>(this.threadId, type, data, createdAt);
    // Shape was schema-validated inside the log; widen to the union.
    const validated: AnyAgentEvent = record as unknown as AnyAgentEvent;
    applyEvent(this.state, validated);
    this.knownEventCount += 1;
    this.pushToSubscribers();
    if (validated.type === "interaction.registered") {
      this.pushInteractionToSubscribers(validated.data.interactionId, "pending");
    } else if (validated.type === "interaction.resolved") {
      this.pushInteractionToSubscribers(validated.data.interactionId, "resolved");
    } else if (validated.type === "interaction.interrupted") {
      this.pushInteractionToSubscribers(validated.data.interactionId, "interrupted");
    }
    return record;
  }

  /** I3: push strictly after persist; the platform barrier guarantees the
   * flush happened before this frame can leave the DO. */
  private pushToSubscribers(): void {
    if (this.threadId === null) return;
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const frame = JSON.stringify(
      threadEventsAppendedMessage({ threadId: this.threadId, latestSeq: this.state.latestSeq }),
    );
    for (const socket of sockets) {
      try {
        socket.send(frame);
      } catch {
        // hibernation API drops dead sockets automatically; never fail an
        // append because a subscriber went away
      }
    }
  }

  /**
   * Interaction lifecycle push (M1.5 T4): the `changed` frame carries the
   * pending-interaction kind + the state patch (bb patchThreadListPending
   * InteractionState shape). The question body itself is NOT socket payload —
   * the SPA refetches it through the existing journal read (no new DO read
   * path, proposal §3 T4).
   */
  private pushInteractionToSubscribers(
    interactionId: string,
    status: "pending" | "resolved" | "interrupted",
  ): void {
    if (this.threadId === null) return;
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const frame = JSON.stringify(
      pendingInteractionChangedMessage({
        threadId: this.threadId,
        latestSeq: this.state.latestSeq,
        interactionId,
        status,
      }),
    );
    for (const socket of sockets) {
      try {
        socket.send(frame);
      } catch {
        // hibernation API drops dead sockets automatically
      }
    }
  }

  // -------------------------------------------------------------------------
  // Turn driver (Effect): stream consumption, retries, parallel dispatch
  // -------------------------------------------------------------------------

  private async driveTurn(turnId: string): Promise<void> {
    const abort = new AbortController();
    this.activeDrivers.set(turnId, abort);
    try {
      const exit = await Effect.runPromiseExit(this.turnProgram(turnId, abort.signal));
      if (Exit.isFailure(exit)) {
        const rendered = Cause.pretty(exit.cause);
        if (!rendered.includes("FSM violation")) {
          console.error(`turn driver for ${turnId} failed`, rendered);
        }
      }
    } finally {
      this.activeDrivers.delete(turnId);
      // M1.5 T16: a subagent DO reports its terminal outcome to the parent
      // whatever it is (yield result, missing-yield failure, model error,
      // cancellation) — omp "finished and failed subagents both stay
      // interrogable" backflow (task semantics §5). Idempotent end-to-end:
      // the parent dedups by spawnId, and a revived child re-runs the hook.
      if (this.state.subagentIdentity !== null) {
        await this.completeSpawnToParent();
      }
    }
  }

  /** One `while` iteration = one model call + zero-or-more tool executions. */
  private turnProgram(turnId: string, signal: AbortSignal): Effect.Effect<void, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen bodies are generator functions (cannot be arrows) and need a stable capture of the DO instance
    const self = this;
    return Effect.gen(function* () {
      for (;;) {
        const turn = self.state.turns.get(turnId);
        if (turn === undefined || turnTerminal(turn)) return;
        if (turn.status === "cancelling") {
          yield* Effect.promise(() => self.finalizeCancel(turnId));
          return;
        }
        // Resumed-driver continuation (cold start, §3.0): executions handed
        // out before eviction are drained first — a model call is only
        // issued from a clean tools/idle boundary, never over live ones.
        const pendingExecutionIds = turn.executionIds.filter((executionId) => {
          const execution = self.state.executions.get(executionId);
          return execution === undefined || !executionTerminal(execution);
        });
        if (pendingExecutionIds.length > 0) {
          const waitOutcome: "done" | "cancelled" | "turn_failed" = yield* Effect.promise(() =>
            self.waitForExecutions(turnId, pendingExecutionIds, signal),
          );
          if (waitOutcome === "cancelled") {
            yield* Effect.promise(() => self.finalizeCancel(turnId));
            return;
          }
          if (waitOutcome === "turn_failed") return;
          continue;
        }
        const pendingSteers = turn.steerSeqs.filter((seq) => !turn.consumedSteerSeqs.includes(seq));
        const started = yield* Effect.promise(() =>
          self.appendEvent("model.call_started", {
            turnId,
            consumedSteerSeqs: pendingSteers,
          }),
        );
        const outcome: ModelCallOutcome = yield* self.consumeModelCall(turnId, started.seq, signal);
        if (outcome.kind === "cancelled") {
          yield* Effect.promise(() => self.finalizeCancel(turnId));
          return;
        }
        if (outcome.kind === "sealed") {
          yield* Effect.promise(() =>
            self.appendEvent("turn.failed", {
              turnId,
              reason: "interrupted_mid_stream",
              sealed: true,
            }),
          );
          return;
        }
        if (outcome.kind === "failed_pre_first_byte") {
          if (outcome.attempt <= self.cfg.maxPreFirstByteRetries) {
            yield* Effect.promise(() =>
              self.appendEvent("model.call_retry", {
                turnId,
                failedModelCallId: outcome.modelCallId,
                attempt: outcome.attempt,
              }),
            );
            yield* Effect.sleep(self.cfg.retryBackoffBaseMs * 2 ** (outcome.attempt - 1));
            continue;
          }
          yield* Effect.promise(() =>
            self.appendEvent("turn.failed", { turnId, reason: "model_error" }),
          );
          return;
        }
        if (outcome.kind === "failed") {
          yield* Effect.promise(() =>
            self.appendEvent("turn.failed", { turnId, reason: "model_error" }),
          );
          return;
        }
        // completed: persist the call result, then materialize tool calls
        yield* Effect.promise(() =>
          self.appendEvent("model.call_completed", {
            turnId,
            modelCallId: outcome.modelCallId,
            text: outcome.text,
            toolCalls: outcome.toolCalls,
          }),
        );
        if (outcome.toolCalls.length === 0) {
          yield* Effect.promise(() => self.appendEvent("turn.completed", { turnId }));
          return;
        }
        const executionIds: string[] = [];
        for (const toolCall of outcome.toolCalls) {
          const record = yield* Effect.promise(() =>
            self.appendEvent("tool.call", {
              turnId,
              modelCallId: outcome.modelCallId,
              tool: toolCall.name,
              arguments: toolCall.arguments,
              timeoutMs: self.cfg.execTimeoutMs,
            }),
          );
          executionIds.push(executionIdFor(self.requireThread(), record.seq));
        }
        yield* Effect.forEach(
          executionIds,
          (executionId) => Effect.promise(() => self.dispatchExecution(turnId, executionId)),
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
        const waitOutcome: "done" | "cancelled" | "turn_failed" = yield* Effect.promise(() =>
          self.waitForExecutions(turnId, executionIds, signal),
        );
        if (waitOutcome === "cancelled") {
          yield* Effect.promise(() => self.finalizeCancel(turnId));
          return;
        }
        if (waitOutcome === "turn_failed") return;
      }
    });
  }

  /**
   * Consume one provider call with the platform-cap timeout (§4.2): first
   * byte → seal, never re-call; pre-first-byte retryable → bounded retry;
   * cancellation aborts the stream and merges into `model.call_failed{aborted}`.
   */
  private consumeModelCall(
    turnId: string,
    modelCallId: number,
    signal: AbortSignal,
  ): Effect.Effect<ModelCallOutcome> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- same generator-capture rationale as turnProgram
    const self = this;
    return Effect.gen(function* () {
      const callAbort = new AbortController();
      const combined = AbortSignal.any([signal, callAbort.signal]);
      let sawFirstByte = false;
      let text = "";
      let pendingDelta = "";
      let pendingDeltaBytes = 0;
      let lastFlushAt = Date.now();
      const flushDelta = (): Effect.Effect<void> =>
        Effect.promise(async () => {
          if (pendingDelta === "") return;
          const chunk = pendingDelta;
          pendingDelta = "";
          pendingDeltaBytes = 0;
          text += chunk;
          await self.appendEvent("model.delta", {
            turnId,
            modelCallId,
            text: chunk,
          });
        });
      const guarded: Effect.Effect<ModelCallOutcome, ProviderPullFailure> = Effect.gen(
        function* () {
          const provider = getAgentRuntime(self.requireThread()).provider;
          const request = yield* Effect.promise(() => self.buildModelRequest(turnId, modelCallId));
          const iterator = provider
            .streamTurn(request, {
              signal: combined,
            })
            [Symbol.asyncIterator]();
          const pull: Effect.Effect<
            IteratorResult<ModelStreamChunk>,
            ProviderPullFailure
          > = Effect.callback((resume) => {
            void iterator.next().then(
              (result) => {
                resume(Effect.succeed(result));
              },
              (error: unknown) => {
                resume(Effect.fail(new ProviderPullFailure(error)));
              },
            );
          });
          for (;;) {
            const next = yield* pull;
            if (next.done === true) break;
            const chunk = next.value;
            if (chunk.kind === "text-delta") {
              if (!sawFirstByte) {
                sawFirstByte = true;
                lastFlushAt = Date.now();
              }
              pendingDelta += chunk.text;
              pendingDeltaBytes += new TextEncoder().encode(chunk.text).byteLength;
              const now = Date.now();
              if (
                pendingDeltaBytes >= self.cfg.deltaFlushBytes ||
                now - lastFlushAt >= self.cfg.deltaFlushMs
              ) {
                lastFlushAt = now;
                yield* flushDelta();
              }
              continue;
            }
            yield* flushDelta();
            return {
              kind: "completed" as const,
              modelCallId,
              text,
              toolCalls: chunk.toolCalls,
            };
          }
          yield* flushDelta();
          return { kind: "completed" as const, modelCallId, text, toolCalls: [] };
        },
      );
      const outcome = yield* Effect.catchIf(
        Effect.timeout(guarded, self.cfg.modelCallCapMs),
        (_error): _error is ProviderPullFailure | Cause.TimeoutError => true,
        (error) =>
          Effect.promise(() =>
            self.outcomeFromFailure(
              error,
              modelCallId,
              sawFirstByte,
              text,
              signal,
              combined,
              callAbort,
            ),
          ),
      );
      return outcome;
    });
  }

  /**
   * Failure → terminal-event mapping (§4.2). Every modelCallId gets exactly
   * one terminal event: seal for post-first-byte breaks (never re-called),
   * call_failed for cancellation and pre-first-byte errors — the retry path
   * appends its own `model.call_retry` and a fresh `model.call_started`.
   */
  private async outcomeFromFailure(
    error: unknown,
    modelCallId: number,
    sawFirstByte: boolean,
    text: string,
    signal: AbortSignal,
    combined: AbortSignal,
    callAbort: AbortController,
  ): Promise<ModelCallOutcome> {
    const call = this.state.modelCalls.get(modelCallId);
    if (call === undefined) return { kind: "sealed", modelCallId };
    const turnId = call.turnId;
    const isCap =
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "TimeoutError";
    if (isCap && !signal.aborted) {
      callAbort.abort();
      await this.appendEvent("model.call_sealed", {
        turnId,
        modelCallId,
        prefixChars: new TextEncoder().encode(text).byteLength,
      });
      return { kind: "sealed", modelCallId };
    }
    const pullFailure = error instanceof ProviderPullFailure ? error.error : error;
    const failure = this.classifyProviderFailure(pullFailure, sawFirstByte);
    if (signal.aborted) {
      await this.appendEvent("model.call_failed", {
        turnId,
        modelCallId,
        error: "cancelled",
        retryable: false,
        aborted: true,
      });
      return { kind: "cancelled", modelCallId };
    }
    if (isCap) {
      callAbort.abort();
      await this.appendEvent("model.call_sealed", {
        turnId,
        modelCallId,
        prefixChars: new TextEncoder().encode(text).byteLength,
      });
      return { kind: "sealed", modelCallId };
    }
    if (failure.afterFirstByte) {
      // Stream broke after first byte: seal — never re-call (§4.2.2).
      await this.appendEvent("model.call_sealed", {
        turnId,
        modelCallId,
        prefixChars: new TextEncoder().encode(text).byteLength,
      });
      return { kind: "sealed", modelCallId };
    }
    await this.appendEvent("model.call_failed", {
      turnId,
      modelCallId,
      error: failure.message,
      retryable: failure.retryable,
    });
    if (failure.retryable) {
      // Retry index = failed attempts so far (the just-failed call included);
      // the driver compares against maxPreFirstByteRetries.
      const failedAttempts = [...this.state.modelCalls.values()].filter(
        (call) => call.turnId === turnId && call.status === "failed",
      ).length;
      return { kind: "failed_pre_first_byte", modelCallId, attempt: failedAttempts };
    }
    return { kind: "failed", modelCallId };
  }

  private classifyProviderFailure(
    error: unknown,
    sawFirstByte: boolean,
  ): { message: string; retryable: boolean; afterFirstByte: boolean } {
    if (error instanceof ModelProviderError) {
      return {
        message: error.message,
        retryable: error.retryable && !sawFirstByte,
        afterFirstByte: error.afterFirstByte || sawFirstByte,
      };
    }
    return {
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      afterFirstByte: sawFirstByte,
    };
  }

  private async buildModelRequest(turnId: string, modelCallId: number): Promise<ModelRequest> {
    const turn = this.state.turns.get(turnId);
    if (turn === undefined) throw new AgentRpcError("not_found", `unknown turn ${turnId}`);
    // Full rebuild from the log per call (omp §1.5) — the structural
    // replay-consistency guarantee; the projection is shared with the
    // replay tests (src/translate.ts).
    const { events } = await this.readAllEvents();
    const request = modelRequestFromEvents(events, turnId, modelCallId);
    // M1.5 T16 surface policy: a subagent DO (journaled identity) renders the
    // subagent toolset — hidden `yield` included — with `task` stripped past
    // the recursion cap (omp canSpawnAtDepth gate). Main keeps MAIN_WIRE_TOOLS.
    const identity = this.state.subagentIdentity;
    if (identity === null) return request;
    return {
      ...request,
      toolSurface: "subagent",
      spawnPolicyBlocked: !canSpawnAtDepth(this.cfg.taskMaxRecursionDepth, identity.depth),
    };
  }

  private async readAllEvents(): Promise<{ events: AnyAgentEvent[] }> {
    if (this.threadId === null) return { events: [] };
    return this.log.read(this.threadId, 0, this.log.maxSeq(this.threadId));
  }
  private eventData(seq: number): AnyAgentEvent | null {
    if (this.threadId === null) return null;
    // `.one()` is typed non-optional but the platform yields nothing for an
    // empty result set; index the array read so the empty case stays typed.
    const row = this.ctx.storage.sql
      .exec<{ data: string }>(
        "SELECT data FROM events WHERE thread_id = ? AND seq = ?",
        this.threadId,
        seq,
      )
      .toArray()[0];
    if (row === undefined) return null;
    return parseAgentEvent({
      id: "",
      threadId: this.threadId,
      seq,
      type: this.eventTypeOf(seq),
      data: JSON.parse(row.data),
      createdAt: 0,
    });
  }

  private eventTypeOf(seq: number): string {
    // Same `.one()` empty-result caveat as `eventData`.
    const row = this.ctx.storage.sql
      .exec<{ type: string }>(
        "SELECT type FROM events WHERE thread_id = ? AND seq = ?",
        this.threadId,
        seq,
      )
      .toArray()[0];
    return row?.type ?? "";
  }

  // -------------------------------------------------------------------------
  // Tool dispatch + result ingest
  // -------------------------------------------------------------------------

  private daemon(): DaemonServiceClient {
    const namespace = this.env.DAEMON_SERVICE;
    if (namespace !== undefined && this.threadId !== null) {
      // Binding-shaped stub; the interface is the seam contract (#30). The
      // service DO is per-machine (§1.2, model two): named by the thread's
      // machineId — the same name the daemon client opens its session under.
      // (#30 wrangler: "env.DAEMON_SERVICE.idFromName(machineId)").
      return namespace.get(
        namespace.idFromName(this.state.machineId ?? "local"),
      ) as unknown as DaemonServiceClient;
    }
    const registered = getAgentRuntime(this.requireThread()).daemon;
    if (registered === undefined) {
      throw new AgentRpcError(
        "no_runtime",
        `no daemon service binding or registered daemon for thread ${this.threadId}`,
      );
    }
    return registered;
  }

  /** I4: the `tool.call` row is already durable before this can run. */
  private async dispatchExecution(turnId: string, executionId: string): Promise<void> {
    const execution = this.state.executions.get(executionId);
    if (execution === undefined || executionTerminal(execution)) return;
    const threadId = this.requireThread();
    const callData = this.eventData(execution.callSeq);
    const toolName = callData?.type === "tool.call" ? callData.data.tool : "unknown";
    const row = toolRegistryRow(toolName);
    if (row?.class === "edge") {
      // Edge routing (control-plane §1.2): registry row's do-local backend
      // executes here — journal appends are DO storage writes, never daemon RPC.
      if (callData?.type === "tool.call") {
        await this.executeEdgeLocal(execution, row, callData.data.arguments);
      }
      return;
    }
    let outcome: DispatchOutcome;
    try {
      outcome = await this.daemon().dispatch({
        threadId,
        turnId,
        executionId,
        machineId: this.state.machineId ?? "local",
        tool: toolName,
        arguments: callData?.type === "tool.call" ? callData.data.arguments : {},
        timeoutMs: execution.timeoutMs,
      });
    } catch (error) {
      // Transport-level failure: the execution stays non-terminal and the
      // watchdog re-asks with the same executionId — never a false terminal.
      console.error(`dispatch of ${executionId} failed; watchdog will re-ask`, error);
      return;
    }
    await this.appendEvent("tool.dispatch", {
      turnId,
      executionId,
      attempt: execution.attempts + 1,
      requestId: crypto.randomUUID(),
      outcome: outcome.kind,
    });
    if (outcome.kind === "completed_cached") {
      await this.ingestResult(execution, outcome.result);
      return;
    }
    if (outcome.kind === "host_offline") {
      await this.ingestResult(execution, {
        status: "error",
        exitCode: null,
        output: "host_offline",
      });
    }
  }

  /**
   * Edge-class execution: same iron rules as the daemon path, zero daemon
   * involvement. executionId dedup guards re-asks (dispatch is at-least-once;
   * a terminal execution re-asked after eviction answers from the journal —
   * never a second execution); the result persists as `tool.result` before
   * any waiter wakes; there is no service-side result to ack.
   */
  private async executeEdgeLocal(
    execution: ExecutionRuntime,
    row: ToolRegistryRow,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (executionTerminal(execution)) return;
    if (row.name === "wait" && this.edgeWaiters.has(execution.executionId)) {
      // A duplicate dispatch of a still-blocking wait (recovery + watchdog
      // races) must not fork a second blocked executor; the registered one
      // owns the result.
      return;
    }
    if (row.name === "task" && this.taskRuns.has(execution.executionId)) {
      // Same rule for the task executor (M1.5 T16): one in-flight spawn per
      // executionId; the registered run owns the result. Recovery after
      // eviction re-enters here sequentially and re-adopts via the journal.
      return;
    }
    if (row.name === "ask" && this.askWaiters.has(execution.executionId)) {
      // A duplicate dispatch of a still-blocking ask (recovery + watchdog
      // races) must not fork a second blocked executor; the registered one
      // owns the result — and a journal re-ask would re-register nothing
      // either way (bb created|existing is projection-derived).
      return;
    }
    if (row.name === "wait") {
      // Blocking marker, same vocabulary as the host path: the wait is about
      // to park on its wake legs; journal-first keeps observers (and tests)
      // able to sync on the blocked state.
      await this.appendEvent("tool.exec_started", {
        turnId: execution.turnId,
        executionId: execution.executionId,
      });
      // The journal-derived 30-minute cap deadline (computeDueWork) exists
      // only from this point — (re)arm the alarm to carry it.
      this.armWatchdog();
    }
    const threadId = this.requireThread();
    const baseContext: Omit<EdgeToolContext, "wait" | "task"> = {
      executionId: execution.executionId,
      threadId,
      appendNotebookRevision: async (text) => {
        await this.appendEvent("experimental_context_notes", { version: 1, text });
      },
      notebook: async () => {
        const { events } = await this.readAllEvents();
        const notes = latestContextNotes(events);
        return notes === undefined ? undefined : { text: notes.text };
      },
      todoState: async () => {
        const { events } = await this.readAllEvents();
        return todoJournalState(events, execution.executionId);
      },
      appendTodoPhases: async (op, phases) => {
        await this.appendEvent("todo_phases", {
          version: 1,
          executionId: execution.executionId,
          op,
          phases,
        });
      },
      checkpointRewindState: async () => {
        const { events } = await this.readAllEvents();
        return checkpointRewindState(events, threadId);
      },
    };
    if (row.name === "task") {
      // The in-flight promise is recorded BEFORE it can race (dispatch +
      // watchdog); the finally-clear mirrors the wait edgeWaiters discipline.
      const run = runEdgeTool(row, args, { ...baseContext, task: this.taskToolContext(execution) })
        .then((result) =>
          this.ingestResult(
            execution,
            { status: result.status, exitCode: null, output: result.output },
            { ack: false },
          ),
        )
        .finally(() => {
          this.taskRuns.delete(execution.executionId);
        });
      this.taskRuns.set(execution.executionId, run);
      await run;
      return;
    }
    const result = await runEdgeTool(row, args, {
      ...baseContext,
      ...(row.name === "wait" ? { wait: this.waitToolContext(execution) } : {}),
      ...(row.name === "ask" ? { ask: this.askToolContext(execution) } : {}),
    }).finally(() => {
      this.edgeWaiters.delete(execution.executionId);
      this.askWaiters.delete(execution.executionId);
      this.waitWindows.delete(execution.executionId);
    });
    await this.ingestResult(
      execution,
      { status: result.status, exitCode: null, output: result.output },
      { ack: false },
    );
  }

  /** DO-bound `ask` context (tools/ask.ts AskToolContext): journal
   * accessors + registration/interrupt mutators + wake/expiry plumbing. */
  private askToolContext(execution: ExecutionRuntime): AskToolContext {
    const threadId = this.requireThread();
    return {
      executionId: execution.executionId,
      threadId,
      turnId: execution.turnId,
      owningTurnStatus: () => this.state.turns.get(execution.turnId)?.status,
      interactionForExecution: async () =>
        interactionForExecution((await this.readAllEvents()).events, execution.executionId),
      registerInteraction: async (input: {
        interactionId: string;
        payload: PendingInteractionPayload;
        expiresAt: number | null;
      }) => {
        await this.appendEvent("interaction.registered", {
          interactionId: input.interactionId,
          turnId: execution.turnId,
          executionId: execution.executionId,
          providerId: "omp",
          // The DO thread IS the provider thread; the execution IS the
          // provider request (bb scopes both per bridge — M1.5 has one DO).
          providerThreadId: threadId,
          providerRequestId: execution.executionId,
          expiresAt: input.expiresAt,
          payload: input.payload,
        });
        // The expiry deadline (ask.timeout arm) exists only from this point —
        // (re)arm the alarm to carry it (practice 4: authoritative timers are
        // alarms, never setTimeout; same shape as wait's cap arming).
        this.armWatchdog();
      },
      interruptInteraction: async (statusReason: string) => {
        const { events } = await this.readAllEvents();
        const pending = interactionForExecution(events, execution.executionId);
        if (pending?.status !== "pending") return;
        await this.appendEvent("interaction.interrupted", {
          interactionId: pending.interactionId,
          statusReason,
        });
      },
      wake: () => {
        const { promise, resolve } = Promise.withResolvers<AskWake>();
        this.askWaiters.set(execution.executionId, { resolve });
        // Photo-finish re-check (journal-before-wake makes this sound): a
        // ruling/interrupt that landed between the executor's projection
        // query and this registration is visible to the re-query and wakes
        // immediately — a wake fired before registration is never lost.
        void (async () => {
          const { events } = await this.readAllEvents();
          const settled = interactionForExecution(events, execution.executionId);
          if (settled === undefined || this.askWaiters.get(execution.executionId) === undefined)
            return;
          if (settled.status === "resolved" && settled.resolution !== undefined) {
            this.wakeAskWaiter(execution.executionId, {
              kind: "resolved",
              resolution: settled.resolution,
            });
          } else if (settled.status === "interrupted") {
            this.wakeAskWaiter(execution.executionId, { kind: "cancelled" });
          }
        })();
        return promise;
      },
      askTimeoutMs: this.cfg.askTimeoutMs,
      now: () => Date.now(),
    };
  }

  /** Persist the terminal result, then (and only then) ack the service (I21). */
  private async ingestResult(
    execution: ExecutionRuntime,
    result: ToolResultPayload,
    options: { ack: boolean } = { ack: true },
  ): Promise<void> {
    if (executionTerminal(execution)) return;
    const record = await this.appendEvent("tool.result", {
      turnId: execution.turnId,
      executionId: execution.executionId,
      status: result.status,
      exitCode: result.exitCode,
      output: result.output,
      outputTruncated: result.outputTruncated,
    });
    if (!options.ack) {
      this.waitWindows.delete(execution.executionId);
      // A terminal result from another path (watchdog seal, cancel) supersedes
      // a still-blocked executor: wake it so its promise resolves; its own
      // late result is absorbed by the terminal guard above.
      this.wakeEdgeWaiter(execution.executionId, { kind: "cancelled" });
      this.wakeAskWaiter(execution.executionId, { kind: "cancelled" });
      this.wakeExecWaiters(execution.executionId, false);
      return;
    }
    try {
      await this.daemon().ackExecution(execution.executionId, record.seq);
    } catch {
      // Ack loss is survivable: the service keeps the result until a later
      // re-ack (duplicate delivery re-acks — I21 recovery path).
    }
    this.waitWindows.delete(execution.executionId);
    this.wakeEdgeWaiter(execution.executionId, { kind: "cancelled" });
    this.wakeAskWaiter(execution.executionId, { kind: "cancelled" });
    this.wakeExecWaiters(execution.executionId, false);
  }

  private waitForExecutions(
    turnId: string,
    executionIds: string[],
    signal: AbortSignal,
  ): Promise<"done" | "cancelled" | "turn_failed"> {
    const { promise, resolve } = Promise.withResolvers<"done" | "cancelled" | "turn_failed">();
    let settled = false;
    const finish = (outcome: "done" | "cancelled" | "turn_failed") => {
      if (settled) return;
      settled = true;
      for (const executionId of executionIds) {
        const waiters = this.execWaiters.get(executionId);
        if (waiters === undefined) continue;
        const filtered = waiters.filter((w) => w.turnId !== turnId);
        if (filtered.length === 0) this.execWaiters.delete(executionId);
        else this.execWaiters.set(executionId, filtered);
      }
      resolve(outcome);
    };
    const check = (): void => {
      const turn = this.state.turns.get(turnId);
      if (turn === undefined || turn.status === "failed" || turn.status === "completed") {
        finish("turn_failed");
        return;
      }
      const pending = executionIds.filter((id) => {
        const execution = this.state.executions.get(id);
        return execution === undefined || !executionTerminal(execution);
      });
      if (pending.length === 0) finish("done");
    };
    const waiters = executionIds.map((_executionId) => ({
      turnId,
      wake: (_forced: boolean) => {
        check();
      },
    }));
    for (let i = 0; i < executionIds.length; i++) {
      const executionId = executionIds[i];
      const waiter = waiters[i];
      if (executionId === undefined || waiter === undefined) continue;
      const existing = this.execWaiters.get(executionId) ?? [];
      existing.push(waiter);
      this.execWaiters.set(executionId, existing);
    }
    const onAbort = () => {
      check();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    check();
    return promise;
  }

  private wakeExecWaiters(executionId: string, forced: boolean): void {
    const waiters = this.execWaiters.get(executionId);
    if (waiters === undefined) return;
    for (const waiter of [...waiters]) waiter.wake(forced);
  }

  private wakeAllWaiters(forced: boolean): void {
    for (const executionId of [...this.execWaiters.keys()]) {
      this.wakeExecWaiters(executionId, forced);
    }
  }

  private async killNonTerminalExecutions(turnId: string): Promise<void> {
    const turn = this.state.turns.get(turnId);
    if (turn === undefined) return;
    for (const executionId of turn.executionIds) {
      const execution = this.state.executions.get(executionId);
      if (execution === undefined || executionTerminal(execution)) continue;
      if (toolRegistryRow(execution.tool)?.class === "edge") {
        // Edge executors never reached the daemon; the blocked wait (the only
        // blocking edge tool) resolves cancelled in-DO and journals its own
        // terminal result through the executor path.
        this.wakeEdgeWaiter(executionId, { kind: "cancelled" });
        if (execution.tool === "ask") {
          if (!this.askWaiters.has(executionId)) {
            // Evicted executor: journal the interrupt here (bb interrupted row)
            // so the recovery re-dispatch converges on a dying turn instead of
            // re-blocking; a live executor journals it itself on the wake.
            const { events } = await this.readAllEvents();
            const pending = interactionForExecution(events, executionId);
            if (pending?.status === "pending") {
              await this.appendEvent("interaction.interrupted", {
                interactionId: pending.interactionId,
                statusReason: "turn cancelled while ask was pending",
              });
            }
          }
          this.wakeAskWaiter(executionId, { kind: "cancelled" });
        }
        continue;
      }
      try {
        await this.daemon().kill(executionId);
      } catch {
        // Ruling I: kill is at-least-once; recovery re-sends after eviction.
      }
    }
  }

  private async finalizeCancel(turnId: string): Promise<void> {
    const turn = this.state.turns.get(turnId);
    if (turn?.status !== "cancelling") return;
    await this.killNonTerminalExecutions(turnId);
    for (;;) {
      const pending = turn.executionIds.filter((id) => {
        const execution = this.state.executions.get(id);
        return execution === undefined || !executionTerminal(execution);
      });
      if (pending.length === 0) break;
      const { promise, resolve } = Promise.withResolvers<undefined>();
      const timer = setTimeout(() => {
        for (const id of pending) {
          const waiters = this.execWaiters.get(id);
          if (waiters === undefined) continue;
          for (const waiter of [...waiters]) {
            if (waiter.turnId !== turnId) continue;
            waiter.wake(false);
          }
        }
        resolve(undefined);
      }, 250);
      const check = () => {
        const stillPending = pending.filter((id) => {
          const execution = this.state.executions.get(id);
          return execution === undefined || !executionTerminal(execution);
        });
        if (stillPending.length === 0) {
          clearTimeout(timer);
          resolve(undefined);
        }
      };
      for (const id of pending) {
        const existing = this.execWaiters.get(id) ?? [];
        existing.push({
          turnId,
          wake: () => {
            check();
          },
        });
        this.execWaiters.set(id, existing);
      }
      await promise;
    }
    await this.appendEvent("turn.cancelled", { turnId });
  }

  // -------------------------------------------------------------------------
  // Watchdog actions
  // -------------------------------------------------------------------------

  private async sealModelCall(modelCallId: number): Promise<void> {
    const call = this.state.modelCalls.get(modelCallId);
    if (call?.status !== "running") return;
    const turn = this.state.turns.get(call.turnId);
    await this.appendEvent("model.call_sealed", {
      turnId: call.turnId,
      modelCallId,
      prefixChars: call.deltaChars,
    });
    if (turn?.status === "cancelling") {
      // Cancellation promises convergence to CANCELLED even past the cap.
      await this.finalizeCancel(call.turnId);
      return;
    }
    await this.appendEvent("turn.failed", {
      turnId: call.turnId,
      reason: "interrupted_mid_stream",
      sealed: true,
    });
    this.activeDrivers.get(call.turnId)?.abort();
    this.wakeAllWaiters(true);
  }

  private async expireTurnWatchdog(turnId: string): Promise<void> {
    const turn = this.state.turns.get(turnId);
    if (turn === undefined || turnTerminal(turn)) return;
    for (const executionId of turn.executionIds) {
      const execution = this.state.executions.get(executionId);
      if (execution === undefined || executionTerminal(execution)) continue;
      this.waitWindows.delete(executionId);
      this.wakeEdgeWaiter(executionId, { kind: "cancelled" });
      this.wakeAskWaiter(executionId, { kind: "cancelled" });
      await this.appendEvent("tool.result", {
        turnId,
        executionId,
        status: "outcome_unknown",
        exitCode: null,
        output: "",
      });
    }
    await this.appendEvent("turn.failed", { turnId, reason: "turn_watchdog_expired" });
    this.activeDrivers.get(turnId)?.abort();
    this.wakeAllWaiters(true);
  }

  private armWatchdog(): void {
    if (this.threadId === null) return;
    let next = computeDueWork(this.state, this.cfg, Date.now()).nextDeadlineAt;
    for (const deadlineAt of this.waitWindows.values()) {
      if (next === null || deadlineAt < next) next = deadlineAt;
    }
    if (next !== null) {
      void this.ctx.storage.setAlarm(next);
    } else {
      void this.ctx.storage.deleteAlarm().catch(() => undefined);
    }
  }

  /**
   * Wait safety cap (M1.5 T2): a live waiter consumes the cap through the
   * executor (omp "Wait limit reached" snapshot); a waiter lost to eviction
   * gets the cap text journaled directly — the same single write path, and
   * re-asking the terminal executionId afterwards answers from the journal.
   */
  private async resolveWaitCap(executionId: string): Promise<void> {
    const execution = this.state.executions.get(executionId);
    if (execution === undefined || executionTerminal(execution)) return;
    if (this.edgeWaiters.has(executionId)) {
      this.wakeEdgeWaiter(executionId, { kind: "cap" });
      return;
    }
    await this.appendEvent("tool.result", {
      turnId: execution.turnId,
      executionId,
      status: "ok",
      exitCode: null,
      output: WAIT_LIMIT_REACHED,
    });
    this.wakeExecWaiters(executionId, false);
  }

  /**
   * Ask-timeout arm (M1.5 T4, omp ask.timeout): a live waiter consumes the
   * expiry through the executor (auto-selected ruling rendered omp-verbatim);
   * a waiter lost to eviction gets the ruling journaled directly — the same
   * single write path, and the re-asked executionId afterwards answers from
   * the journal.
   */
  private async resolveInteractionExpiry(executionId: string): Promise<void> {
    const execution = this.state.executions.get(executionId);
    if (execution === undefined || executionTerminal(execution)) return;
    if (this.askWaiters.has(executionId)) {
      this.wakeAskWaiter(executionId, { kind: "expiry" });
      return;
    }
    const { events } = await this.readAllEvents();
    const pending = interactionForExecution(events, executionId);
    if (pending === undefined) return;
    const answers: Record<string, { selected: string[]; freeText?: string }> = {};
    for (const question of pending.payload.questions) {
      answers[question.id] = timeoutAutoSelect(question);
    }
    await this.appendEvent("tool.result", {
      turnId: execution.turnId,
      executionId,
      status: "ok",
      exitCode: null,
      output: renderAskOutput(pending.payload, answers, true),
    });
    this.wakeExecWaiters(executionId, false);
  }

  private wakeEdgeWaiter(executionId: string, wake: WaitWake): void {
    const waiter = this.edgeWaiters.get(executionId);
    if (waiter === undefined) return;
    this.edgeWaiters.delete(executionId);
    waiter.resolve(wake);
  }

  private wakeAskWaiter(executionId: string, wake: AskWake): void {
    const waiter = this.askWaiters.get(executionId);
    if (waiter === undefined) return;
    this.askWaiters.delete(executionId);
    waiter.resolve(wake);
  }

  /** Settle/deliver wakes broadcast: every blocked wait re-queries its own
   * owner-filtered projection (level-triggered; spurious wakes are safe). */
  private wakeAllEdgeWaiters(wake: WaitWake): void {
    for (const executionId of [...this.edgeWaiters.keys()]) {
      this.wakeEdgeWaiter(executionId, wake);
    }
  }

  /** DO-bound `wait` context (tools/wait.ts WaitToolContext): journal
   * accessors + mutator faces + alarm/wake plumbing; the decision logic
   * stays in the pure executor. */
  private waitToolContext(execution: ExecutionRuntime): WaitToolContext {
    const threadId = this.requireThread();
    const registry: JobRegistry = {
      register: (input: JobRegistration) => this.registerJob(input),
      settle: (jobId: string, settlement: JobSettlement) => this.settleJob(jobId, settlement),
      markDelivered: async (jobId: string, byExecutionId: string) => {
        await this.appendEvent("job.delivered", { jobId, byExecutionId });
      },
    };
    const inbox: PeerInbox = {
      deliver: async (message) => this.deliverPeerMessage(message),
      consume: async (messageId: string, byExecutionId: string) => {
        await this.appendEvent("peer.message_consumed", { messageId, byExecutionId });
      },
    };
    return {
      executionId: execution.executionId,
      threadId,
      callSeq: execution.callSeq,
      // The DO's agent identity is its thread (omp session.getAgentId
      // equivalent at M1.5; T16 subagents run their own DOs).
      ownerId: threadId,
      events: async () => (await this.readAllEvents()).events,
      registry,
      inbox,
      // T19 binds the agent registry; M1.5 has no peer registry yet.
      runningPeers: () => [],
      registerWindowDeadline: (deadlineAt: number) => {
        this.waitWindows.set(execution.executionId, deadlineAt);
        this.armWatchdog();
      },
      wake: () => {
        const { promise, resolve } = Promise.withResolvers<WaitWake>();
        this.edgeWaiters.set(execution.executionId, { resolve });
        return promise;
      },
      config: {
        waitMaxMs: this.cfg.waitMaxMs,
        peerWaitLadderMs: this.cfg.peerWaitLadderMs,
        peerLadderResetGapMs: this.cfg.peerLadderResetGapMs,
      },
      now: () => Date.now(),
    };
  }

  /**
   * DO-bound `task` context (tools/task/executor.ts TaskToolContext — the
   * wait.ts WaitToolContext precedent): journal accessors + spawn host +
   * wake plumbing; decision logic stays in the executor. The subagent host
   * rides the AGENT_DO namespace binding; unbound deployments fail the spawn
   * loudly (T16 scope is same-host only, cross-machine is explicit out).
   */
  private taskToolContext(execution: ExecutionRuntime): TaskToolContext {
    const threadId = this.requireThread();
    const identity = this.state.subagentIdentity;
    const namespace = this.env.AGENT_DO;
    let subagentHost: SubagentSpawnHost | undefined;
    if (namespace !== undefined) {
      // Structural stub view — keeps the seam RPC-serializable without a
      // generated typed-stub (the daemon() precedent below).
      const stubFor = (childThreadId: string): SubagentDoStub =>
        namespace.get(namespace.idFromName(childThreadId)) as unknown as SubagentDoStub;
      subagentHost = {
        createThread: async (request) => stubFor(request.threadId).createThread(request),
        runSubagent: async (request) => stubFor(request.spawnId).runSubagent(request),
      };
    }
    return {
      executionId: execution.executionId,
      turnId: execution.turnId,
      threadId,
      machineId: this.state.machineId ?? "local",
      // The spawning thread's own depth: Main is 0, a subagent reads its
      // journaled identity (replay-derived — recover() refolds it).
      depth: identity === null ? 0 : identity.depth,
      parentAgentId: identity === null ? undefined : identity.agentId,
      events: async () => (await this.readAllEvents()).events,
      recordSpawnPlan: async (plan) => {
        await this.appendEvent("task.spawn_planned", {
          executionId: plan.executionId,
          spawnId: plan.spawnId,
          agentId: plan.agentId,
          agent: plan.agent,
          childThreadId: plan.childThreadId,
          parentThreadId: plan.parentThreadId,
          machineId: plan.machineId,
          mode: plan.mode,
          jobId: plan.jobId,
          task: plan.task,
          solutionSpace: plan.solutionSpace,
          ...(plan.model === undefined ? {} : { model: plan.model }),
          ...((plan.outputSchema === undefined
            ? {}
            : { outputSchemaJson: JSON.stringify(plan.outputSchema) }) as {
            outputSchemaJson?: string;
          }),
          depth: plan.depth,
        });
      },
      recordSpawnSettlement: async (settlement) => {
        await this.appendEvent("task.spawn_settled", settlement);
      },
      registry: {
        register: (input: JobRegistration) => this.registerJob(input),
        settle: (jobId: string, settlement: JobSettlement) => this.settleJob(jobId, settlement),
      },
      subagentHost,
      wake: () => {
        const { promise, resolve } = Promise.withResolvers<WaitWake>();
        this.edgeWaiters.set(execution.executionId, { resolve });
        return promise.then((wake) => wake.kind);
      },
      config: this.taskConfig(),
    };
  }

  /**
   * Child→parent terminal backflow (M1.5 T16): project the last terminal
   * yield — the minimal gate; none, or a non-ok yield execution, settles the
   * spawn failed (omp SYSTEM WARNING, task.md:186 minus the T17 ladder
   * clause) — then deliver through the AGENT_DO binding to the parent's
   * completeSubagent wake source. Delivery failures log, never throw: the
   * parent's recovery re-adopt derives everything from its own journal.
   */
  private async completeSpawnToParent(): Promise<void> {
    const identity = this.state.subagentIdentity;
    if (identity === null) return;
    const namespace = this.env.AGENT_DO;
    if (namespace === undefined) {
      console.error(`subagent ${identity.agentId}: no AGENT_DO binding; completion not delivered`);
      return;
    }
    const { events } = await this.readAllEvents();
    const yielded = lastYieldResult(events);
    let status: "ok" | "error";
    let output: string;
    if (yielded === undefined || (yielded.data === undefined && yielded.error === undefined)) {
      status = "error";
      output = NO_YIELD_WARNING;
    } else if (yielded.resultStatus !== "ok") {
      status = "error";
      output = `yield did not complete (status ${yielded.resultStatus})`;
    } else {
      const rendered = renderYieldOutput(yielded);
      status = rendered.status;
      output = rendered.output;
    }
    const parent = namespace.get(
      namespace.idFromName(identity.parentThreadId),
    ) as unknown as SubagentDoStub;
    try {
      await parent.completeSubagent({
        spawnId: identity.spawnId,
        agentId: identity.agentId,
        status,
        output,
      });
    } catch (error) {
      console.error(`subagent ${identity.agentId}: completion delivery failed`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------

  private requireThread(): string {
    if (this.threadId === null) {
      throw new AgentRpcError("not_found", "thread not created on this DO");
    }
    return this.threadId;
  }

  private activeTurn() {
    if (this.state.activeTurnId === null) return undefined;
    return this.state.turns.get(this.state.activeTurnId);
  }

  /** Test/config seam: persist a watchdog config patch. */
  async configureWatchdog(
    patch: Record<string, number>,
  ): Promise<{ config: Record<string, number> }> {
    await this.ready();
    const merged = mergeWatchdogConfig(this.cfg, parseWatchdogConfigPatch(patch));
    this.cfg = merged;
    this.ctx.storage.kv.put(WATCHDOG_CONFIG_KV_KEY, JSON.stringify(patch));
    this.armWatchdog();
    return { config: merged as unknown as Record<string, number> };
  }
}
