import { DurableObject } from "cloudflare:workers";
import { Cause, Effect, Exit } from "effect";
import {
  CLOUD_PLACEHOLDER_HOST_ID,
  threadEventsAppendedMessage,
  threadDeltaMessage,
  threadPhaseChangedMessage,
  pendingInteractionChangedMessage,
  realtimeClientMessageSchema,
  type PromptContent,
  type PendingInteractionPayload,
  type PendingInteractionResolution,
  type PendingInteractionRow,
  type RealtimeThreadDelta,
  type RealtimeSubscriptionTarget,
} from "@cap/protocol";
import { EventLog } from "./event-log.js";
import {
  COMPACT_DIRECTIVE_TEXT,
  DEFAULT_KEEP_RECENT_TOKENS,
  estimateVisibleTailTokens,
  isContextOverflowFailure,
  lastUsageTotal,
  planCompactCut,
  planRetryCut,
  projectedContextTokens,
  shouldCompact,
  type CompactCutPlan,
  type CompactionTriggerSettings,
} from "./compaction.js";
import {
  applyEvent,
  computeDueWork,
  emptyReplayState,
  executionTerminal,
  FsmViolationError,
  replayEvents,
  turnTerminal,
  type ExecutionRuntime,
  type ReplayState,
} from "./turn-state.js";
import type { AgentEventDataByType, AgentEventRecord, AgentEventType } from "./fsm-events.js";
import {
  parseAgentEvent,
  subagentActivityUnitSchema,
  type AnyAgentEvent,
  type SubagentActivityUnit,
} from "./fsm-events.js";
import { executionIdFor, threadIdFromExecutionId } from "./ids.js";
import {
  DEFAULT_WATCHDOG_CONFIG,
  WATCHDOG_CONFIG_KV_KEY,
  decodeExperimentalToolConfig,
  decodeWatchdogConfig,
  mergeWatchdogConfig,
  parseWatchdogConfigPatch,
  type ExperimentalToolConfig,
  type WatchdogConfig,
} from "./config.js";
import type {
  DaemonServiceClient,
  DispatchOutcome,
  ExecutionUpdate,
  IsolationOpOutcome,
  ToolResultPayload,
} from "./daemon.js";
import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamChunk,
  type ModelUsageReceipt,
} from "./provider.js";
import { projectToUxEvents } from "./ux-projection.js";
import { getAgentRuntime } from "./injection.js";
import { modelRequestFromEvents } from "./translate.js";
import type { RelaySelection } from "./provider-catalog.js";
import { normalizeRelaySelection, relaySelectionEquals } from "./turn-state.js";
import { toolRegistryRow, type ToolRegistryRow } from "./tools/registry.js";
import { resolveHostPathOverride, type HostPathResolution } from "./tools/host-path.js";
import { scheduleBatch, type BatchScheduleItem } from "./tools/batch-scheduler.js";
import { latestContextNotes, runEdgeTool, type EdgeToolContext } from "./tools/edge.js";
import {
  projectJobs,
  projectInbox,
  type JobRegistration,
  type JobRegistry,
  type JobSettlement,
  type PeerInbox,
} from "./tools/job-registry.js";
import { WAIT_LIMIT_REACHED, type WaitToolContext, type WaitWake } from "./tools/wait.js";
import {
  settleSpawn,
  isolationRetainedNote,
  type RunSubagentRequest,
  type SubagentSpawnHost,
  type TaskToolContext,
} from "./tools/task/executor.js";
import {
  canSpawnAtDepth,
  projectSpawnPlans,
  settlementForSpawn,
  type SpawnPlanRecord,
} from "./tools/task/types.js";
import {
  childAssignment,
  walkJsonPath,
  parseAgentUri,
  truncateDeliveryOutput,
} from "./tools/task/plan.js";
import { lastActivityFlushThroughSeq, projectActivityFlush } from "./tools/task/activity-flush.js";
import {
  interactionForExecution,
  projectInteractionRows,
  timeoutAutoSelect,
  renderAskOutput,
  validateAskResolution,
  type AskToolContext,
  type AskWake,
} from "./tools/ask.js";
import {
  childRunVerdict,
  NO_YIELD_WARNING,
  projectChildRun,
  renderYieldDelivery,
  renderAgentHistory,
  renderJournalJsonl,
  budgetNoticeText,
  budgetHardLimit,
  type ChildRunState,
  type ChildBudgetPolicy,
} from "./tools/task/child-run.js";
import { SpawnSemaphore } from "./tools/task/semaphore.js";
import {
  decideKill,
  parseProcKillUri,
  projectLifecycle,
  registerIfAvailable,
  type LifecycleRecord,
  type SubagentLifecycleState,
} from "./tools/task/lifecycle.js";
import { checkpointRewindState, todoJournalState } from "./tools/session-tree.js";
import {
  DEFAULT_WEB_SEARCH_CONFIG,
  decodeWebSearchConfig,
  type WebSearchConfig,
  type WebSearchToolContext,
} from "./tools/web-search.js";
import {
  HOST_FILE_RPC_TIMEOUT_MS,
  type GenerateImageConfig,
  type GenerateImageToolContext,
} from "./tools/generate-image.js";
import {
  decodeMcpServersConfig,
  limitMcpOutput,
  projectMcpToolOutput,
  McpToolSurface,
  type McpToolRoute,
} from "./tools/mcp.js";

/** #328 C3: recovery settlement waiters ride the execWaiters table under a
 * turnId that can never collide with a real turn (turn ids are ULIDs or
 * `compact-*`). */
const SETTLEMENT_WAITER_MARK = "#settlement-waiter";

/** Delivery caps apply to artifact reads too (omp task/types.ts:29-32). */
function capArtifactText(
  text: string,
  caps: { maxOutputBytes: number; maxOutputLines: number },
): AgentArtifactResult {
  const { text: capped, truncated } = truncateDeliveryOutput(text, caps);
  return { output: capped, truncated };
}

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
   * #150 experimental tool gates (#102 patch-over-defaults pattern, omp
   * defaults all false): externalThinking gates `think` (paired with
   * forceReasoningOff), contextNotes gates context_notes/new_context,
   * checkpoint gates checkpoint/rewind.
   */
  AGENT_DO_EXTERNAL_THINKING?: string;
  AGENT_DO_CONTEXT_NOTES?: string;
  AGENT_DO_CHECKPOINT?: string;
  /**
   * Optional JSON patch over the default web_search provider config (env
   * var, M1.5 T12). Decoded once at construction; a patch naming a
   * browser-backed engine (google/ecosia/mojeek) fails the DO loudly —
   * rejection, never silent fallback (tools/web-search.ts policy).
   */
  AGENT_DO_WEB_SEARCH?: string;
  /**
   * Optional JSON array of MCP servers (matrix C2, #327) — Streamable HTTP
   * endpoints the DO connects to in-process (edge do-local class, the same
   * fetch-only posture as web_search; stdio stays a daemon-side evaluation).
   * Decoded once at construction (tools/mcp.ts); absent/empty = no MCP
   * surface and the wire is byte-identical to the pre-C2 shape.
   */
  AGENT_DO_MCP_SERVERS?: string;
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
  /**
   * #197 D2: the public fan-out hub (NotificationHubDO, same composed
   * worker). Optional — unbound deployments (rig/unit tests) notify nothing
   * (same guard shape as DAEMON_SERVICE → host_offline). The journal stays
   * the only truth either way: frames are accelerators, never authority.
   */
  HUB?: DurableObjectNamespace;
  /**
   * #238: control-plane D1 (the composed deployment binds the worker's
   * `DB`). Optional — unbound deployments (rig/unit tests, the standalone
   * agent-DO worker) skip control-plane settlement; the journal stays the
   * execution authority and GET /threads/:id/timeline keeps its lazy
   * settlement backstop.
   */
  DB?: D1Database;
  /**
   * #362: master key for the D1 provider-config credential column
   * (provider_configs.api_key_enc, AES-GCM). The composed worker's runtime
   * refresh reads it when decrypting the overlay; unset = rows with stored
   * keys stay mock (the loader warns). Pure pass-through — the agent DO
   * never logs or projects the value.
   */
  PROVIDER_CONFIG_MASTER_KEY?: string;
}

/**
 * The hub RPC surface the agent DO pushes through (#197 D2, spec §5.2).
 * Structural on purpose — the composed deployment resolves it against the
 * NotificationHubDO stub; the recording hub in tests matches the shape.
 */
export interface HubNotifyStub {
  notifyThread(
    threadId: string,
    changes: string[],
    metadata?: {
      latestSeq?: number;
      eventTypes?: string[];
      hasPendingInteraction?: boolean;
      phase?: {
        turnId: string;
        phase: "stream_started" | "first_token" | "terminal" | "settled" | "host_lost";
        modelCallId?: number;
        reason?: string;
      };
    },
  ): Promise<{ delivered: number }>;
  notifyThreadDelta(frame: RealtimeThreadDelta): Promise<{ delivered: number }>;
}

/** One `agent://<id>[/<json path>]` / `history://<id>` resolution request. */
export interface AgentArtifactRequest {
  agentId: string;
  kind: "output" | "json" | "history";
  /** JSON path segments after `agent://<id>/` (kind json). */
  path?: string[];
}

export interface AgentArtifactResult {
  output: string;
  truncated: boolean;
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
  /** #276 J5 activity backflow: journal the child's summary units (dedup). */
  reportSubagentActivity(request: {
    spawnId: string;
    agentId: string;
    units: SubagentActivityUnit[];
  }): Promise<{ appended: number; duplicated: number }>;
  /** T17 agent:// hop: serve this DO's own artifacts or forward deeper. */
  readAgentArtifact(request: AgentArtifactRequest): Promise<AgentArtifactResult>;
  /** T17 agent:// write face: land a peer message on this DO's thread. T19:
   * a parked recipient revives first (receipt `revived`), an idle one adopts
   * the message as a follow-up turn. */
  deliverPeerMessage(request: {
    ownerId: string;
    from: string;
    text: string;
    messageId?: string;
  }): Promise<{ messageId: string; duplicated: boolean; revived: boolean }>;
  /** T19 kill half (cancel entry 1): land the child-journal tombstone and
   * cancel the live turn so the session releases. Idempotent. */
  abortSubagent(request: {
    spawnId: string;
    agentId: string;
    reason: "kill" | "call_signal" | "wall_clock" | "internal";
  }): Promise<{ state: SubagentLifecycleState; alreadyAborted: boolean }>;
}

export interface CreateThreadRequest {
  threadId: string;
  title: string;
  machineId?: string;
  /**
   * #351: the create-time explicit execution selection — journaled on
   * thread.created and resolved against the providerId-keyed relay registry
   * at dispatch. Validation is the server bridge's contract; the DO journals
   * verbatim and fails loudly at dispatch if the catalog drifted.
   */
  execution?: RelaySelection;
}

export interface CreateThreadResult {
  threadId: string;
  duplicated: boolean;
}

export interface SendMessageRequest {
  /** Client-generated idempotency key (protocol `clientRequestId`). */
  clientRequestId: string;
  /** #317: the full journal prompt-content union (text/image/localImage/localFile). */
  content: PromptContent[];
  mode: "auto" | "start" | "steer";
  /**
   * #351: a send-time selection ride — the server classified it `live`
   * (classifyExecutionSettingsChange) before dispatching. Applied BEFORE the
   * turn rows (thread.execution_updated) so the new turn's pin and any
   * replay re-fold the same selection. A steer still applies the thread
   * state change; the active turn keeps its own pin (live rides the NEXT
   * turn).
   */
  execution?: RelaySelection;
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
      /** #308 provider usage receipt/estimate; absent when none was reported. */
      usage?: ModelUsageReceipt;
    }
  | { kind: "sealed"; modelCallId: number }
  | { kind: "cancelled"; modelCallId: number }
  | { kind: "failed_pre_first_byte"; modelCallId: number; attempt: number }
  | {
      kind: "failed";
      modelCallId: number;
      /** #326: the provider failure text, for the overflow-verdict gate. */
      failureMessage: string;
    };

/** Typed error channel for a provider pull failure. */
class ProviderPullFailure {
  constructor(readonly error: unknown) {}
}

export class AgentDO extends DurableObject<AgentDoBindings> {
  private readonly log: EventLog;
  private cfg: WatchdogConfig;
  /** Decoded once from `AGENT_DO_WEB_SEARCH` (M1.5 T12); deployment-time
   * input — the model-facing wire schema carries no engine field. */
  private readonly webSearchConfig: WebSearchConfig;
  /**
   * #448 the panel-resolved image source: the 产图源 seat (D1 image_source)
   * resolved over the api=openai-images provider row. Non-null gates
   * generate_image ON and carries the source; null = not configured — the
   * tool is unavailable (no env fallback, #450). The deploying worker's
   * ComposedAgentDO refreshes it at the turn boundary (refreshRuntime seam),
   * so a panel edit takes effect on the next real turn with zero redeploy.
   */
  private imageSource: GenerateImageConfig | null = null;
  /** Decoded once from the #150 experimental-gate envs; deployment-time
   * input, all default OFF (omp tools/index.ts:766-772 posture). */
  private readonly experimentalGates: ExperimentalToolConfig;
  /**
   * The panel-resolved image source (the 产图源 seat) is the only gate +
   * source (#448/#450): non-null opens the generate_image wire row and the
   * source rides the seat's row; null keeps the tool off the wire.
   */
  applyImageGenerationSource(source: GenerateImageConfig | null): void {
    this.imageSource = source;
  }
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
  /** In-flight web_search transports (executionId → cancel), M1.5 T12.
   * killNonTerminalExecutions aborts the owning call's signal so an outbound
   * fetch in flight surfaces as a cancelled tool result (omp throwIfAborted
   * rethrow), not an Error text. */
  private readonly webSearchAborts = new Map<string, AbortController>();
  /** In-flight MCP tool transports (executionId → cancel), matrix C2 #327.
   * Same vocabulary as webSearchAborts: killNonTerminalExecutions aborts the
   * owning call's signal so an in-flight MCP request surfaces as a cancelled
   * tool result, not an Error text. */
  private readonly mcpAborts = new Map<string, AbortController>();
  /** In-flight generate_image transports (executionId → cancel), B2 #322.
   * Same vocabulary as webSearchAborts: killNonTerminalExecutions aborts the
   * owning call's signal so an in-flight image request surfaces as a
   * cancelled tool result, not an Error text. */
  private readonly generateImageAborts = new Map<string, AbortController>();
  /**
   * The DO's MCP face (tools/mcp.ts): discovery cache + connection pool +
   * wire-name routes. Empty server config = inert (no fetch, no surface).
   */
  private readonly mcpSurface: McpToolSurface;

  constructor(ctx: DurableObjectState, env: AgentDoBindings) {
    super(ctx, env);
    this.cfg = decodeWatchdogConfig(env.AGENT_DO_WATCHDOG, DEFAULT_WATCHDOG_CONFIG);
    this.experimentalGates = decodeExperimentalToolConfig(env);
    this.webSearchConfig = decodeWebSearchConfig(
      env.AGENT_DO_WEB_SEARCH,
      DEFAULT_WEB_SEARCH_CONFIG,
    );
    this.mcpSurface = new McpToolSurface(decodeMcpServersConfig(env.AGENT_DO_MCP_SERVERS));
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
      // #377: callers that omit the binding get the honest placeholder, not a
      // fabricated "local" machine.
      machineId: request.machineId ?? CLOUD_PLACEHOLDER_HOST_ID,
      ...(request.execution !== undefined
        ? { execution: normalizeRelaySelection(request.execution) ?? undefined }
        : {}),
    });
    this.armWatchdog();
    return { threadId: request.threadId, duplicated: false };
  }

  /**
   * #288 explicit rebind: the only write that moves a binding after creation.
   * Idempotent on the same target (a replayed owner operation appends
   * nothing); in-flight executions keep settling by executionId self-routing.
   */
  async rebindThread(request: {
    machineId: string;
    environmentId?: string;
  }): Promise<{ machineId: string; duplicated: boolean }> {
    await this.ready();
    this.requireThread();
    if (this.state.machineId === request.machineId) {
      return { machineId: request.machineId, duplicated: true };
    }
    await this.appendEvent("thread.rebound", {
      machineId: request.machineId,
      ...(request.environmentId !== undefined ? { environmentId: request.environmentId } : {}),
    });
    return { machineId: request.machineId, duplicated: false };
  }

  /** Input-first-persist (ruling on #23): the event lands before anything runs. */
  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    await this.ready();
    this.requireThread();
    const existing = this.state.inputIds.get(request.clientRequestId);
    if (existing !== undefined) {
      return { turnId: existing.turnId, steer: existing.kind === "steer", duplicated: true };
    }
    // #351: apply a send-time selection ride before the turn rows so the
    // new turn's pin (and any replay) folds the same explicit selection.
    // Unchanged rides append nothing (send idempotence covers retries, but
    // an equal triple must not manufacture journal rows either).
    let pinned: RelaySelection | null = this.state.execution;
    if (request.execution !== undefined) {
      const next = normalizeRelaySelection(request.execution);
      if (next !== null && !relaySelectionEquals(this.state.execution, next)) {
        await this.appendEvent("thread.execution_updated", next);
        pinned = next;
      }
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
      ...(pinned !== null ? { execution: pinned } : {}),
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
   * #309 manual compact — journal checkpoint-style compaction (bb upstream
   * POST /threads/:id/compact semantics, omp journal shape: the boundary is a
   * replay-derived seq cut, never a deletion, #116). The compact turn runs
   * one tool-free summarization call over the projected active-branch context
   * (the request rebuild IS the summarizer's input — previousSummary chains
   * for free, prior compact turns are journal rows like any turn), then
   * appends the content-bearing `thread/compacted` checkpoint. pi kernel
   * semantics ported per anchor in src/compaction.ts.
   *
   * Gates: Main threads only, idle only (an active turn conflicts, bb gates
   * compact on idle|error the same way), and a retention-budget check — a
   * journal that already fits `keepRecentTokens` has nothing to summarize.
   * Fire-and-forget like sendMessage: the turn drives async; the journal is
   * the only truth clients need to observe.
   */
  async compactThread(request: {
    /** Client-supplied idempotency key; default UUID when omitted. */
    clientRequestId?: string;
    /**
     * Retention budget for the cut planner (pi keepRecentTokens,
     * compaction.ts:126-130); default DEFAULT_KEEP_RECENT_TOKENS. The route
     * passes nothing — the knob exists so deployments/tests can size the
     * retained tail explicitly.
     */
    keepRecentTokens?: number;
  }): Promise<{ turnId: string; duplicated: boolean }> {
    await this.ready();
    this.requireThread();
    const inputId = request.clientRequestId ?? `compact-${crypto.randomUUID()}`;
    const existing = this.state.inputIds.get(inputId);
    if (existing !== undefined) {
      return { turnId: existing.turnId, duplicated: true };
    }
    if (this.state.subagentIdentity !== null) {
      throw new AgentRpcError(
        "invalid",
        "compact is a Main-thread action; a subagent owns no session context to compress",
      );
    }
    const active = this.activeTurn();
    if (active !== undefined) {
      throw new AgentRpcError(
        "conflict",
        `turn ${active.turnId} is active (${active.status}); compact requires an idle thread`,
      );
    }
    const { events } = await this.readAllEvents();
    if (!events.some((event) => event.type === "model.call_completed")) {
      throw new AgentRpcError(
        "invalid",
        "nothing to compact: the journal has no completed model call",
      );
    }
    const plan = planCompactCut(events, request.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS);
    if (plan === undefined) {
      throw new AgentRpcError(
        "invalid",
        "nothing to compact: the whole journal fits the retention budget",
      );
    }
    const usage = lastUsageTotal(events);
    const turnId = `turn_${crypto.randomUUID()}`;
    await this.appendEvent("turn.input", {
      turnId,
      inputId,
      content: [{ type: "text", text: COMPACT_DIRECTIVE_TEXT }],
    });
    this.armWatchdog();
    this.ctx.waitUntil(this.runCompactTurnCore(turnId, plan, usage, "manual"));
    return { turnId, duplicated: false };
  }

  /**
   * The compact turn driver (#309 manual button, #326 auto faces — one shared
   * core): one summarization call (no tools), then the checkpoint row, then
   * turn.completed. Terminal mapping mirrors turnProgram's single-call
   * segment (§4.2: seal after first byte, bounded pre-first-byte retry); the
   * cancellation face rides the shared cancelTurn → cancel_requested → abort
   * → finalizeCancel path. An answer that is empty or tool-bearing seals
   * instead of persisting — an assistant slice with neither text nor paired
   * results has no wire shape and would poison every later projection
   * (translate's pairing invariant). The return status is the #326 auto
   * caller's recovery verdict; the manual path ignores it.
   */
  private async runCompactTurnCore(
    turnId: string,
    plan: CompactCutPlan,
    usage: { usedTokens: number; contextWindow: number | null } | null,
    method: "manual" | "auto",
  ): Promise<"completed" | "failed" | "cancelled"> {
    const abort = new AbortController();
    this.activeDrivers.set(turnId, abort);
    try {
      const turnLive = (): boolean => {
        const current = this.state.turns.get(turnId);
        return current !== undefined && !turnTerminal(current);
      };
      for (;;) {
        const turn = this.state.turns.get(turnId);
        if (turn === undefined || turnTerminal(turn)) return "cancelled";
        if (turn.status === "cancelling") {
          await this.finalizeCancel(turnId);
          return "cancelled";
        }
        const started = await this.appendEvent("model.call_started", {
          turnId,
          consumedSteerSeqs: [],
        });
        const outcome = await Effect.runPromise(
          this.consumeModelCall(turnId, started.seq, abort.signal),
        ).catch(() => ({ kind: "failed" as const, failureMessage: "" }));
        if (outcome.kind === "cancelled") {
          await this.finalizeCancel(turnId);
          return "cancelled";
        }
        if (outcome.kind === "sealed") {
          if (turnLive()) {
            await this.appendEvent("turn.failed", {
              turnId,
              reason: "interrupted_mid_stream",
              sealed: true,
            });
          }
          return "failed";
        }
        if (outcome.kind === "failed_pre_first_byte") {
          if (outcome.attempt <= this.cfg.maxPreFirstByteRetries) {
            await this.appendEvent("model.call_retry", {
              turnId,
              failedModelCallId: outcome.modelCallId,
              attempt: outcome.attempt,
            });
            const backoff = Promise.withResolvers<undefined>();
            setTimeout(backoff.resolve, this.cfg.retryBackoffBaseMs * 2 ** (outcome.attempt - 1));
            await backoff.promise;
            continue;
          }
          if (turnLive()) {
            await this.appendEvent("turn.failed", { turnId, reason: "model_error" });
          }
          return "failed";
        }
        if (outcome.kind === "failed") {
          if (turnLive()) {
            await this.appendEvent("turn.failed", { turnId, reason: "model_error" });
          }
          return "failed";
        }
        // Completed — but a cancel_requested may have landed mid-stream
        // (turnProgram's loop-top ordering): cancelling settles as cancelled,
        // never as a fresh checkpoint on a dying turn.
        if (this.state.turns.get(turnId)?.status === "cancelling") {
          await this.finalizeCancel(turnId);
          return "cancelled";
        }
        if (outcome.toolCalls.length > 0 || outcome.text.trim() === "") {
          await this.appendEvent("model.call_sealed", {
            turnId,
            modelCallId: outcome.modelCallId,
            prefixChars: 0,
          });
          await this.appendEvent("turn.failed", { turnId, reason: "model_error" });
          return "failed";
        }
        await this.appendEvent("model.call_completed", {
          turnId,
          modelCallId: outcome.modelCallId,
          text: outcome.text,
          toolCalls: [],
        });
        if (outcome.usage !== undefined) {
          await this.appendEvent("model.usage_receipt", {
            turnId,
            modelCallId: outcome.modelCallId,
            usage: outcome.usage,
          });
        }
        const tokensAfter = estimateVisibleTailTokens({
          keptTurns: plan.keptTurns,
          directiveText: COMPACT_DIRECTIVE_TEXT,
          summaryText: outcome.text,
        });
        await this.appendEvent("thread/compacted", {
          turnId,
          hideThroughSeq: plan.hideThroughSeq,
          tokensBefore: usage?.usedTokens ?? null,
          tokensAfter,
          contextWindow: usage?.contextWindow ?? null,
          method,
        });
        await this.appendEvent("turn.completed", { turnId });
        return "completed";
      }
    } finally {
      this.activeDrivers.delete(turnId);
    }
  }

  /**
   * #326 proactive face — the post-turn `shouldCompact` gate (pi checks the
   * same threshold after each assistant message, compaction.ts:264-270): when
   * the projected next-call context (usage anchor + tail estimate) presses
   * against the window minus the reserve, the auto compact turn runs NOW so
   * the next turn never sees a raw overflow. Best-effort between turns: a
   * racing user turn (FSM violation on the compact turn.input) or a subagent
   * thread steps aside — the reactive overflow face remains the backstop.
   */
  private async maybeAutoCompactAfterTurn(): Promise<void> {
    if (this.threadId === null || this.state.subagentIdentity !== null) return;
    const settings: CompactionTriggerSettings = {
      enabled: this.cfg.autoCompactionEnabled,
      reserveTokens: this.cfg.autoCompactionReserveTokens,
      keepRecentTokens: this.cfg.autoCompactionKeepRecentTokens,
    };
    if (!settings.enabled) return;
    try {
      if (this.activeTurn() !== undefined) return;
      const { events } = await this.readAllEvents();
      if (!events.some((event) => event.type === "model.call_completed")) return;
      const projected = projectedContextTokens(events);
      if (!shouldCompact(projected.tokens, projected.contextWindow, settings)) return;
      const plan = planCompactCut(events, settings.keepRecentTokens);
      // Fits the retention budget → nothing to summarize; the reactive face
      // owns the (rare) provider-rejection case where the estimate lied.
      if (plan === undefined) return;
      const usage = lastUsageTotal(events);
      const turnId = `turn_${crypto.randomUUID()}`;
      await this.appendEvent("turn.input", {
        turnId,
        inputId: `compact-auto-${crypto.randomUUID()}`,
        content: [{ type: "text", text: COMPACT_DIRECTIVE_TEXT }],
      });
      this.armWatchdog();
      await this.runCompactTurnCore(turnId, plan, usage, "auto");
    } catch (error) {
      if (!(error instanceof FsmViolationError)) {
        console.error("auto compaction gate failed", error);
      }
    }
  }

  /**
   * #326 reactive recovery — after a context-overflow failure, compact over
   * the current journal and re-drive the failed input as a fresh turn. The
   * failed turn stays failed (honest journal: the attempt did fail); the
   * recovery is that the session continues without user action. The cut
   * ladder (planRetryCut) assumes the estimator underestimated — the provider
   * rejected what fit `keepRecentTokens` on paper. Returns whether the retry
   * turn was started; false leaves the raw failure standing (no cut exists,
   * the summarizer itself failed, or a racing user turn owns the thread).
   */
  private async autoCompactAndRetry(failedTurnId: string): Promise<boolean> {
    try {
      if (this.state.subagentIdentity !== null) return false;
      const { events } = await this.readAllEvents();
      const plan = planRetryCut(events, this.cfg.autoCompactionKeepRecentTokens);
      if (plan === undefined) return false;
      const failedInput = events.find(
        (event) => event.type === "turn.input" && event.data.turnId === failedTurnId,
      );
      if (failedInput?.type !== "turn.input") return false;
      const usage = lastUsageTotal(events);
      const compactTurnId = `turn_${crypto.randomUUID()}`;
      await this.appendEvent("turn.input", {
        turnId: compactTurnId,
        inputId: `compact-auto-${crypto.randomUUID()}`,
        content: [{ type: "text", text: COMPACT_DIRECTIVE_TEXT }],
      });
      this.armWatchdog();
      const outcome = await this.runCompactTurnCore(compactTurnId, plan, usage, "auto");
      if (outcome !== "completed") return false;
      // A user turn racing in past the failure owns the thread now — its own
      // requests already ride the fresh cut, which is the recovery that
      // matters; the automatic retry steps aside.
      if (this.activeTurn() !== undefined) return false;
      const retryTurnId = `turn_${crypto.randomUUID()}`;
      await this.appendEvent("turn.input", {
        turnId: retryTurnId,
        inputId: `${failedInput.data.inputId}#compact-retry`,
        content: failedInput.data.content,
      });
      this.armWatchdog();
      await this.driveTurn(retryTurnId);
      return true;
    } catch (error) {
      if (!(error instanceof FsmViolationError)) {
        console.error(`auto compact-and-retry for ${failedTurnId} failed`, error);
      }
      return false;
    }
  }

  /**
   * Cold-start resume for a queued compact turn (#309 manual, #326 auto):
   * re-derive the cut from the journal — the planner is deterministic over
   * the same rows, and the journal cannot have grown agent-side while the
   * compact turn held the thread — then finish the checkpoint. Method
   * attribution: auto turns always name themselves `compact-auto-…`; the
   * manual face (default or client-supplied id) stays `manual`.
   */
  private async resumeCompactTurn(turnId: string): Promise<void> {
    try {
      const { events } = await this.readAllEvents();
      const plan = planRetryCut(events, this.cfg.autoCompactionKeepRecentTokens);
      if (plan === undefined) {
        await this.appendEvent("turn.failed", { turnId, reason: "model_error" });
        return;
      }
      const input = events.find(
        (event) => event.type === "turn.input" && event.data.turnId === turnId,
      );
      const method =
        input?.type === "turn.input" && input.data.inputId.startsWith("compact-auto-")
          ? ("auto" as const)
          : ("manual" as const);
      this.armWatchdog();
      await this.runCompactTurnCore(turnId, plan, lastUsageTotal(events), method);
    } catch (error) {
      if (!(error instanceof FsmViolationError)) {
        console.error(`compact turn resume for ${turnId} failed`, error);
      }
    }
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
  }): Promise<{ messageId: string; duplicated: boolean; revived: boolean }> {
    await this.ready();
    this.requireThread();
    const messageId = request.messageId ?? crypto.randomUUID();
    const existing = projectInbox((await this.readAllEvents()).events).message(messageId);
    if (existing !== undefined) return { messageId, duplicated: true, revived: false };
    await this.appendEvent("peer.message", {
      messageId,
      ownerId: request.ownerId,
      from: request.from,
      text: request.text,
    });
    this.wakeAllEdgeWaiters({ kind: "message" });
    const revived = await this.reviveOrFollowUp(messageId, request.from, request.text);
    return { messageId, duplicated: false, revived };
  }

  /**
   * T19 lifecycle delivery (omp bus.ts:139-143 + agent-lifecycle.ts:341+):
   * a PARKED recipient revives — transcript rebuild (this DO's session state
   * is the journal fold, so the revived run keeps its full history), receipt
   * row, then a follow-up turn with the message. An IDLE one adopts the
   * message as a follow-up turn (omp "finished and failed subagents both
   * stay interrogable"). RUNNING/aborted recipients stay queued (T17 rule:
   * delivery never starts their turns); Main queues too. Returns whether
   * this delivery REVIVED a parked agent.
   */
  private async reviveOrFollowUp(messageId: string, from: string, text: string): Promise<boolean> {
    const identity = this.state.subagentIdentity;
    if (identity === null) return false;
    const view = projectLifecycle((await this.readAllEvents()).events);
    const record: LifecycleRecord | undefined = view.record(identity.agentId);
    if (record?.state !== "parked" && record?.state !== "idle") return false;
    // Registration CAS (omp agent-registry.ts:161-170): adopting the parked
    // ref is the revive path's claim; on the self-view the ref always
    // matches, but the CAS discipline stays explicit.
    const registration = registerIfAvailable(view, {
      agentId: identity.agentId,
      spawnId: identity.spawnId,
    });
    if (!registration.ok) return false;
    const content = [{ type: "text", text: `${from}: ${text}` }] as [
      { type: "text"; text: string },
    ];
    if (record.state === "parked") {
      await this.appendEvent("task.subagent_revived", {
        spawnId: identity.spawnId,
        agentId: identity.agentId,
        inputId: `revive-${messageId}`,
        from,
      });
    }
    try {
      // mode auto: a turn that raced in between fold and send gets the
      // message steered instead of a conflict.
      await this.sendMessage({
        clientRequestId: `followup-${messageId}`,
        content,
        mode: "auto",
      });
    } catch {
      // Terminal-active race (steer refused): start a fresh turn. The I2
      // inputId dedup makes a partially-landed first attempt a no-op.
      await this.sendMessage({
        clientRequestId: `followup-${messageId}`,
        content,
        mode: "start",
      }).catch(() => undefined);
    }
    return record.state === "parked";
  }

  /**
   * T19 cancel entry 1, child half: the kill RPC lands the CHILD-journal
   * tombstone (irreversible — the gate fold turns confirm-only) and cancels
   * the live turn so the session releases (omp: "the owned running subagent
   * is aborted and its session released"). Idempotent: an already-aborted DO
   * confirms with `alreadyAborted` and appends nothing. Journal-first: the
   * tombstone precedes the cancel row, so a replayed fold sees the abort
   * before the cancelled turn either way (first abort wins in the fold).
   */
  async abortSubagent(request: {
    spawnId: string;
    agentId: string;
    reason: "kill" | "call_signal" | "wall_clock" | "internal";
  }): Promise<{ state: SubagentLifecycleState; alreadyAborted: boolean }> {
    await this.ready();
    this.requireThread();
    const identity = this.state.subagentIdentity;
    if (identity?.spawnId !== request.spawnId || identity.agentId !== request.agentId) {
      throw new AgentRpcError(
        "not_found",
        `no subagent ${request.agentId} (${request.spawnId}) on this DO`,
      );
    }
    const record = projectLifecycle((await this.readAllEvents()).events).record(identity.agentId);
    if (record?.state === "aborted") return { state: "aborted", alreadyAborted: true };
    await this.appendEvent("task.subagent_aborted", {
      spawnId: identity.spawnId,
      agentId: identity.agentId,
      reason: request.reason,
    });
    const active = this.activeTurn();
    if (active !== undefined && !turnTerminal(active)) {
      await this.cancelTurn({ turnId: active.turnId });
    }
    return { state: "aborted", alreadyAborted: false };
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

  /**
   * T17 `agent://<id>` server hop (called through the AGENT_DO namespace,
   * one hop per resolution — practice-11 budget, no parent-side caching).
   * A DO serves its OWN artifacts from storage (journal-fold fallback for
   * pre-artifact journals); any other id forwards one hop deeper via
   * {@link resolveArtifactTarget}. Not-found throws over the RPC boundary.
   */
  async readAgentArtifact(request: AgentArtifactRequest): Promise<AgentArtifactResult> {
    await this.ready();
    this.requireThread();
    const identity = this.state.subagentIdentity;
    if (identity?.agentId !== request.agentId) {
      return this.resolveArtifactTarget(request.agentId).then((target) =>
        target.stub.readAgentArtifact(request),
      );
    }
    return this.serveOwnArtifacts(request);
  }

  /** Serve this DO's own `<agentId>.{md,jsonl,json}` family. */
  private async serveOwnArtifacts(request: AgentArtifactRequest): Promise<AgentArtifactResult> {
    const identity = this.state.subagentIdentity;
    if (identity === null) {
      throw new AgentRpcError("not_found", `no subagent identity on ${this.requireThread()}`);
    }
    const base = `agent/${identity.agentId}`;
    const caps = this.taskConfig();
    if (request.kind === "history") {
      const { events } = await this.readAllEvents();
      return capArtifactText(renderAgentHistory(events, identity.agentId), caps);
    }
    if (request.kind === "json") {
      const raw = await this.ctx.storage.get<string>(`${base}.json`);
      let parsed: unknown;
      if (typeof raw === "string") {
        parsed = JSON.parse(raw) as unknown;
      } else {
        // No sidecar (pre-write journal or data-less terminal): derive from
        // the fold so the read face stays available on any replay state.
        const gate = projectChildRun((await this.readAllEvents()).events);
        parsed = gate.terminal?.data;
      }
      if (parsed === undefined) {
        throw new AgentRpcError(
          "not_found",
          `${identity.agentId} has no structured result (no data sidecar).`,
        );
      }
      if (request.path !== undefined && request.path.length > 0) {
        const walked = walkJsonPath(parsed, request.path);
        if (!walked.ok) {
          throw new AgentRpcError(
            "not_found",
            `JSON path .${request.path.join("/")} failed at segment "${walked.failedAt}".`,
          );
        }
        parsed = walked.value;
      }
      return capArtifactText(
        typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2),
        caps,
      );
    }
    // kind "output": the full .md sidecar; journal-fold fallback renders the
    // delivered text for journals that predate the artifact write.
    const markdown = await this.ctx.storage.get<string>(`${base}.md`);
    if (typeof markdown === "string") return capArtifactText(markdown, caps);
    const gate = projectChildRun((await this.readAllEvents()).events);
    if (gate.terminal === undefined) {
      return capArtifactText(
        gate.warning ??
          `No settled result for ${identity.agentId} yet (run still open or missing yield).`,
        caps,
      );
    }
    return capArtifactText(
      renderYieldDelivery({ terminal: gate.terminal, sections: gate.sections }).output,
      caps,
    );
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
      // T17 structured contract: mirrored so the child's yield gate enforces
      // the caller's outputSchema verdict replay-pure (no parent contact).
      ...((request.outputSchema === undefined
        ? {}
        : { outputSchemaJson: JSON.stringify(request.outputSchema) }) as {
        outputSchemaJson?: string;
      }),
      ...(request.schemaMode === undefined ? {} : { schemaMode: request.schemaMode }),
      ...(request.parentToolCallId === undefined
        ? {}
        : { parentToolCallId: request.parentToolCallId }),
    });
    return this.sendMessage({
      clientRequestId: request.spawnId,
      content: [{ type: "text", text: childAssignment(request.task, request.context) }],
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
    // T19 tombstone resistance (omp agent-registry.ts:190-193 — "delayed
    // revives/progress never flip a tombstone"): a killed spawn's late
    // completion confirms only. The kill already settled the job cancelled;
    // no settlement, no async-result, no wake may follow.
    if (projectLifecycle(events).record(plan.agentId)?.state === "aborted") {
      return { duplicated: true };
    }
    // T20 #110 isolation closure rides the settlement (journal-first: the
    // blocking caller wakes on the settle row, so the release outcome must
    // be IN that row). omp split (isolation-runner.ts:377-381, 468-473):
    // blocking agents are one-shot — release captures-merges at run end;
    // background/keep-alive agents retain the workspace across park and
    // only an explicit release captures-merges. Release failures settle
    // failed (the delta did not land) and name the retained workspace.
    let output = request.output;
    if (plan.isolated && plan.isolation !== undefined) {
      if (plan.mode === "blocking") {
        const outcome =
          this.env.DAEMON_SERVICE === undefined
            ? ({ kind: "host_offline" } as const)
            : await this.daemon().isolationOp({
                machineId: plan.machineId,
                threadId: this.requireThread(),
                op: "release",
                arguments: { threadId: plan.childThreadId },
                timeoutMs: this.cfg.execTimeoutMs,
              });
        if (outcome.kind === "ok") {
          output += `\n\n${outcome.result.output}`;
        } else {
          return this.settleIsolatedReleaseFailure(plan, request, outcome);
        }
      } else {
        output += `\n\n${isolationRetainedNote(plan.isolation)}`;
      }
    }
    // Journal-first settlement (delivery text arrives summary-capped from the
    // child's rendering path — settleSpawn on the parent caps it defensively).
    await settleSpawn(this.taskSpawnSink(), {
      spawnId: plan.spawnId,
      jobId: plan.jobId,
      agentId: plan.agentId,
      childThreadId: plan.childThreadId,
      status: request.status,
      output,
      ...(plan.parentToolCallId === undefined ? {} : { parentToolCallId: plan.parentToolCallId }),
    });
    if (plan.mode === "background" && plan.jobId !== null) {
      // Backflow marker for the parent's next run boundary; settleSpawn's
      // registry.settle already woke blocked waits, so ordering here is
      // journal-visible before the next turn's projection reads it.
      // The T20 isolation suffix rides along — the parent agent needs the
      // retention note in the model-visible backflow too.
      await this.appendEvent("task.async_result", {
        spawnId: plan.spawnId,
        agentId: plan.agentId,
        jobId: plan.jobId,
        status: request.status,
        output,
        ...(plan.parentToolCallId === undefined ? {} : { parentToolCallId: plan.parentToolCallId }),
      });
    }
    this.wakeEdgeWaiter(plan.executionId, { kind: "job" });
    // M1.5 T17 supersession chain: when THIS DO is itself a subagent, the
    // settlement may void a terminal yield (stale) or resolve the last park.
    // The gate fold decides from the journal — a no-op when Main.
    if (this.state.subagentIdentity !== null) {
      await this.advanceChildRun();
    }
    return { duplicated: false };
  }

  /**
   * #276 J5 activity backflow (the omp `subagent_event` frame journal face):
   * the child DO's turn-boundary flush lands its activity/CoT summary units
   * here as `task.subagent_event` wrapper rows. Journal-only — no registry,
   * no waits, no FSM state; the ux projection unfolds the delegation row's
   * childRows from these rows at read time. Dedup by (spawnId, unit kind,
   * unit sourceSeq) makes the flush retry after a cursor-append crash a
   * no-op (completeSubagent's spawnId dedup precedent).
   */
  async reportSubagentActivity(request: {
    spawnId: string;
    agentId: string;
    units: SubagentActivityUnit[];
  }): Promise<{ appended: number; duplicated: number }> {
    await this.ready();
    this.requireThread();
    const { events } = await this.readAllEvents();
    const plan = projectSpawnPlans(events).find((record) => record.spawnId === request.spawnId);
    if (plan === undefined) {
      throw new AgentRpcError("not_found", `no spawn plan for ${request.spawnId}`);
    }
    const seen = new Set<string>();
    for (const event of events) {
      if (event.type !== "task.subagent_event" || event.data.spawnId !== request.spawnId) {
        continue;
      }
      seen.add(`${event.data.unit.kind}:${event.data.unit.sourceSeq}`);
    }
    let appended = 0;
    let duplicated = 0;
    for (const raw of request.units) {
      const parsed = subagentActivityUnitSchema.safeParse(raw);
      if (!parsed.success) {
        throw new AgentRpcError("invalid", "malformed subagent activity unit");
      }
      const unit = parsed.data;
      const key = `${unit.kind}:${unit.sourceSeq}`;
      if (seen.has(key)) {
        duplicated += 1;
        continue;
      }
      seen.add(key);
      await this.appendEvent("task.subagent_event", {
        spawnId: plan.spawnId,
        agentId: plan.agentId,
        childThreadId: plan.childThreadId,
        ...(plan.parentToolCallId === undefined ? {} : { parentToolCallId: plan.parentToolCallId }),
        unit,
      });
      appended += 1;
    }
    return { appended, duplicated };
  }

  /**
   * T20 failure path: an isolated blocking spawn whose release failed (merge
   * conflict, patch refused, capture write) settles the spawn failed with
   * the daemon's error text — the workspace/branch/patch artifacts survive
   * and are named in it (omp merge-failure semantics).
   */
  private async settleIsolatedReleaseFailure(
    plan: SpawnPlanRecord,
    request: { spawnId: string; status: "ok" | "error"; output: string },
    outcome: Extract<IsolationOpOutcome, { kind: "error" | "host_offline" }>,
  ): Promise<{ duplicated: false }> {
    const detail = outcome.kind === "error" ? outcome.error : "daemon host offline";
    const output = `${request.output}\n\n[isolated changes NOT applied: ${detail}]`;
    // Blocking spawns are the only released-at-settle path; their jobId is
    // always null (no JobRegistry row to settle, no async-result backflow).
    await settleSpawn(this.taskSpawnSink(), {
      spawnId: plan.spawnId,
      jobId: plan.jobId,
      agentId: plan.agentId,
      childThreadId: plan.childThreadId,
      status: "error",
      output,
      ...(plan.parentToolCallId === undefined ? {} : { parentToolCallId: plan.parentToolCallId }),
    });
    this.wakeEdgeWaiter(plan.executionId, { kind: "job" });
    // T17 supersession chain runs on the failure path too — a subagent
    // parent's stale-yield/park fold must see the failed settlement.
    if (this.state.subagentIdentity !== null) {
      await this.advanceChildRun();
    }
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
        // T18 permit lifecycle: same dispatch→settlement release as the
        // executor-facing sink (this path serves completeSubagent).
        this.releaseSpawnPermit(settlement.spawnId);
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
      isolationOpTimeoutMs: this.cfg.execTimeoutMs,
      maxConcurrency: this.cfg.taskMaxConcurrency,
      softRequestBudget: this.cfg.taskSoftRequestBudget,
      maxRuntimeMs: this.cfg.taskMaxRuntimeMs,
    };
  }

  /**
   * T18 session-level spawn semaphore (task semantics §4.1): DO-singleton,
   * first use reads the current config; `configureWatchdog` resizes the live
   * instance in place so queued spawns re-evaluate against the new cap.
   */
  private spawnSemaphoreInstance: SpawnSemaphore | undefined;

  private spawnSemaphore(): SpawnSemaphore {
    return (this.spawnSemaphoreInstance ??= new SpawnSemaphore(this.cfg.taskMaxConcurrency));
  }

  /**
   * Permits held by dispatched-but-unsettled spawns (spawnId → releaser).
   * The settlement sink releases — dispatch→settlement span, see
   * TaskToolContext.trackSpawnRelease.
   */
  private spawnReleases = new Map<string, () => void>();

  private releaseSpawnPermit(spawnId: string): void {
    const release = this.spawnReleases.get(spawnId);
    if (release === undefined) return;
    this.spawnReleases.delete(spawnId);
    release();
  }

  /** Child budget policy for the T18 gate (undefined = request tiers off). */
  private childBudgetPolicy(): ChildBudgetPolicy | undefined {
    if (this.cfg.taskSoftRequestBudget <= 0 && this.cfg.taskMaxRuntimeMs <= 0) return undefined;
    return {
      softRequestBudget: this.cfg.taskSoftRequestBudget,
      maxRuntimeMs: this.cfg.taskMaxRuntimeMs,
      now: Date.now(),
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
   * SPA interactions read face (#225): the journal-folded rows the control
   * plane serves to the bb interactions routes. Journal-first like the
   * resolve path — the fold IS the replay truth, so a page reload answers
   * identically after eviction.
   */
  async listInteractions(): Promise<{ interactions: PendingInteractionRow[] }> {
    await this.ready();
    this.requireThread();
    const { events } = await this.readAllEvents();
    return { interactions: projectInteractionRows(events) };
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
      // T19 TTL park tick: the idle deadline passed — park the self record
      // (guarded: Main/running/aborted/already-parked never re-park), then
      // re-derive; a revive that raced in clears the deadline instead.
      await this.sweepLifecycle(now);
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
    // 3. Ruling E: re-ask every non-terminal execution (deduped downstream),
    // in batch-schedule wave order (#328 C3) — same-file conflicts re-dispatch
    // only after the earlier wave settles, so the mutex survives eviction.
    // Detached: recovery must not gate ready() on execution settlement (the
    // blocking edge executors park on their wake channels by design).
    const reaskable = [...this.state.executions.values()].filter(
      (execution) =>
        !executionTerminal(execution) && execution.attempts < this.cfg.maxDispatchAttempts,
    );
    if (reaskable.length > 0) {
      void this.redispatchScheduled(reaskable).catch((error: unknown) => {
        console.error("scheduled recovery re-dispatch failed", error);
      });
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
      // #309/#326: a queued compact turn resumes through the compact core,
      // not the agent turnProgram — the summarizer call must land its
      // thread/compacted checkpoint, which turnProgram knows nothing about.
      // Mid-call compact turns follow the watchdog seal path like agent turns.
      if (turn.inputId.startsWith("compact-") && turn.status === "queued") {
        this.ctx.waitUntil(this.resumeCompactTurn(turn.turnId));
        continue;
      }
      this.ctx.waitUntil(this.driveTurn(turn.turnId));
    }
    // 6. M1.5 T17: a subagent run with NO live turn (interrupted reminder,
    // parked on pending spawns, or missed completion delivery) re-decides
    // from the same journal fold — the recovery face of advanceChildRun.
    if (this.state.subagentIdentity !== null) {
      const live = [...this.state.turns.values()].some((turn) => !turnTerminal(turn));
      if (!live) this.ctx.waitUntil(this.advanceChildRun());
    }
    // 7. M1.5 T19: re-derive the park deadline from the journal — the alarm
    // table carries no state, so an eviction must not strand an idle agent
    // unparked (or park a revived one).
    await this.refreshLifecycleAlarms();
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
    if (
      validated.type === "turn.input" ||
      validated.type === "turn.completed" ||
      validated.type === "turn.failed" ||
      validated.type === "turn.cancelled" ||
      validated.type === "task.yield_completed" ||
      validated.type === "task.subagent_revived" ||
      validated.type === "task.subagent_parked" ||
      validated.type === "task.subagent_aborted"
    ) {
      // T19: these rows move an agent between lifecycle states (or mark
      // activity that restarts the idle TTL) — re-derive the park deadline.
      void this.refreshLifecycleAlarms();
    }
    if (validated.type === "interaction.registered") {
      this.pushInteractionToSubscribers(validated.data.interactionId, "pending");
    } else if (validated.type === "interaction.resolved") {
      this.pushInteractionToSubscribers(validated.data.interactionId, "resolved");
    } else if (validated.type === "interaction.interrupted") {
      this.pushInteractionToSubscribers(validated.data.interactionId, "interrupted");
    }
    // #197 D3: phase rows trail their fact rows inside the same single write
    // path (persist-then-mark, P1) — no terminal/dispatch site can forget.
    await this.appendTrailingPhase(validated);
    // #197 D2: the live line to the hub. Fire-and-forget; a notify NEVER
    // fails an append (spec §5.2).
    this.notifyHub(validated);
    // #238: settle the coarse control-plane execution row at the source of
    // truth. Fire-and-forget like the notify; a settlement NEVER fails an
    // append (the timeline route keeps its lazy backstop either way).
    if (
      validated.type === "turn.completed" ||
      validated.type === "turn.failed" ||
      validated.type === "turn.cancelled"
    ) {
      this.settleControlPlaneRowAfterTerminalTurn(validated.type);
    }
    return record;
  }

  /**
   * #238 root cause: the send/create routes flip the thread row `active` on
   * dispatch, and the ONLY consumer of the DO's terminal turn rows was the
   * lazy `settleThreadTurnStatus` inside GET /threads/:id/timeline. A client
   * that never refetches the timeline after completion (WS gap, background
   * tab) leaves the row `active` indefinitely, and every thread GET —
   * including the reload path's first render — derives "working" from it.
   *
   * The DO is the only actor alive when a turn settles, so it writes the
   * control-plane transition itself: the same cells the worker's FSM
   * (apps/server-worker contract/domain/thread-lifecycle.ts, `active`/`starting`
   * rows) and the lazy backstop map terminal turns to — completed/cancelled →
   * idle, failed → error. The guarded UPDATE encodes the FSM's
   * supersession predicates (notDeleted/notArchived) and the source cells, so
   * a terminal row can never clobber `stopping`/`error` or resurrect a
   * deleted/archived thread. `changes = 0` (already settled, or row absent)
   * pushes nothing — the frame must announce a real transition.
   */
  private settleControlPlaneRowAfterTerminalTurn(
    eventType: "turn.completed" | "turn.failed" | "turn.cancelled",
  ): void {
    if (this.threadId === null) return;
    const db = this.env.DB;
    if (db === undefined) return;
    const nextStatus = eventType === "turn.failed" ? "error" : "idle";
    const threadId = this.threadId;
    this.ctx.waitUntil(
      (async () => {
        const result = await db
          .prepare(
            "UPDATE threads SET status = ?, updated_at = ? " +
              "WHERE id = ? AND deleted_at IS NULL AND archived_at IS NULL " +
              "AND status IN ('active', 'starting')",
          )
          .bind(nextStatus, Date.now(), threadId)
          .run();
        if (result.meta.changes === 0) return;
        const hub = this.hubStub();
        if (hub === undefined) return;
        await hub.notifyThread(threadId, ["status-changed"]);
      })().catch((error: unknown) => {
        console.error("control-plane turn settlement failed", error);
      }),
    );
  }

  /**
   * D3 trailing markers (spec §3.2 append-point table): `terminal` right
   * after every turn.completed/failed/cancelled (reason = the row's
   * outcome), `settled` once executions are all terminal and nothing is
   * left to re-ask, `host_lost` once per turn after the first
   * `tool.dispatch{outcome:"host_offline"}`. Recovery never backfills
   * phases (P2): the fold is the only thing that replays them.
   */
  private async appendTrailingPhase(event: AnyAgentEvent): Promise<void> {
    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled"
    ) {
      const reason =
        event.type === "turn.completed"
          ? "completed"
          : event.type === "turn.failed"
            ? event.data.reason
            : "cancelled";
      await this.appendEvent("turn.phase", {
        turnId: event.data.turnId,
        phase: "terminal",
        reason,
      });
      await this.settleTurnIfReady(event.data.turnId);
      return;
    }
    if (event.type === "tool.dispatch" && event.data.outcome === "host_offline") {
      // #289: an override-target offline is a tool-level explicit failure —
      // the BOUND host may be perfectly alive and the turn continues on it.
      // `host_lost` stays the bound-machine marker; the override error
      // result already tells the model what happened.
      if (event.data.overriddenMachineId !== undefined) return;
      const turn = this.state.turns.get(event.data.turnId);
      if (turn !== undefined && !turn.phases.includes("host_lost")) {
        await this.appendEvent("turn.phase", {
          turnId: event.data.turnId,
          phase: "host_lost",
          reason: "host_offline",
        });
      }
    }
  }

  /**
   * D3 `settled`: silent confirmation — every execution terminal, no
   * in-flight re-ask. The FSM already refuses terminal rows over live
   * executions, so today this lands immediately after `terminal`; the
   * ingestResult hook keeps the semantics honest if a future terminal path
   * relaxes that (host_offline 收尸 convergence, spec §3.2).
   */
  private async settleTurnIfReady(turnId: string): Promise<void> {
    const turn = this.state.turns.get(turnId);
    if (turn === undefined || !turnTerminal(turn)) return;
    if (turn.phases.includes("settled")) return;
    for (const executionId of turn.executionIds) {
      const execution = this.state.executions.get(executionId);
      if (execution === undefined || !executionTerminal(execution)) return;
    }
    await this.appendEvent("turn.phase", { turnId, phase: "settled" });
  }

  // -------------------------------------------------------------------------
  // #197 D2: agent-DO → hub push line (R1). One notify per journal row —
  // the existing delta flush (deltaFlushMs/deltaFlushBytes) already coalesces
  // the stream, so no new buffering, no new timers, DO alarm discipline kept.
  // -------------------------------------------------------------------------

  /** Hub stub; undefined = unbound deployment → notify is a silent no-op
   * (same guard shape as DAEMON_SERVICE === undefined → host_offline). */
  private hubStub(): HubNotifyStub | undefined {
    const namespace = this.env.HUB;
    if (namespace === undefined) return undefined;
    return namespace.get(namespace.idFromName("hub")) as unknown as HubNotifyStub;
  }

  /**
   * D2 push shape (spec §5.2): `model.delta` → `notifyThreadDelta` payload
   * frame (Tier-A; R2-bypass rows omit `text` → freshness signal only);
   * `turn.phase` → `["phase-changed"]` with the row's payload; everything
   * else → `["events-appended"]` Tier-B pointer (eventTypes = the journal
   * type). DO→DO RPC is unordered and at-least-once — consumers reconcile
   * by `seq` per D4, so ordering/buffering machinery would be dead weight.
   *
   * #148 bridge: a `model.delta` row ALSO emits the `["events-appended"]`
   * pointer. The pinned bb SPA (streaming contract §16 S4 not yet landed)
   * ignores the `delta` payload frame, so without the pointer a streaming
   * stretch triggers no Tier-B refetch and the conversation row only grows at
   * turn.completed — the repro behind "流式 delta 未实时投影（turn 完成前
   * conversation 行不生长）". The pointer is redundant-but-idempotent for the
   * future S4 consumer (latestSeq > cursor → throttled catch-up, seq dedupe),
   * and the row rate is already capped by deltaFlushMs/Bytes. Retire this
   * second emit when the S4 SPA consumes delta frames directly.
   */
  private notifyHub(event: AnyAgentEvent): void {
    if (this.threadId === null) return;
    const hub = this.hubStub();
    if (hub === undefined) return;
    const threadId = this.threadId;
    const latestSeq = this.state.latestSeq;
    if (event.type === "model.delta") {
      const { turnId, modelCallId, text } = event.data;
      const frame = threadDeltaMessage({
        threadId,
        turnId,
        itemId: `itm-am-${turnId}:${modelCallId}`,
        seq: event.seq,
        ...(typeof text === "string" ? { text } : {}),
        latestSeq,
      });
      this.ctx.waitUntil(
        hub.notifyThreadDelta(frame).catch((error: unknown) => {
          console.error("hub delta notify failed", error);
        }),
      );
      this.ctx.waitUntil(
        hub
          .notifyThread(threadId, ["events-appended"], { latestSeq, eventTypes: [event.type] })
          .catch((error: unknown) => {
            console.error("hub delta pointer notify failed", error);
          }),
      );
      return;
    }
    if (event.type === "turn.phase") {
      const { turnId, phase, modelCallId, reason } = event.data;
      const frame = threadPhaseChangedMessage({
        threadId,
        latestSeq,
        phase: {
          turnId,
          phase,
          ...(modelCallId !== undefined ? { modelCallId } : {}),
          ...(reason !== undefined ? { reason } : {}),
        },
      });
      this.ctx.waitUntil(
        hub.notifyThread(threadId, frame.changes, frame.metadata).catch((error: unknown) => {
          console.error("hub phase notify failed", error);
        }),
      );
      return;
    }
    if (
      event.type === "interaction.registered" ||
      event.type === "interaction.resolved" ||
      event.type === "interaction.interrupted"
    ) {
      // #225: the SPA's interactions query refetches ONLY on the
      // `interactions-changed` change kind (bb realtime-cache-registry); the
      // generic events-appended pointer never reaches it. The metadata patch
      // (bb buildInteractionChangeMetadata) drives the sidebar badge patch —
      // true when any folded interaction is still pending after this row.
      const hasPending = [...this.state.interactions.values()].some(
        (interaction) => interaction.status === "pending",
      );
      this.ctx.waitUntil(
        hub
          .notifyThread(threadId, ["interactions-changed"], {
            latestSeq,
            hasPendingInteraction: hasPending,
          })
          .catch((error: unknown) => {
            console.error("hub interaction notify failed", error);
          }),
      );
      return;
    }
    this.ctx.waitUntil(
      hub
        .notifyThread(threadId, ["events-appended"], { latestSeq, eventTypes: [event.type] })
        .catch((error: unknown) => {
          console.error("hub notify failed", error);
        }),
    );
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
      // #362: the deploying worker's runtime may re-read mutable provider
      // config (D1 overlay) at the turn boundary — hot-reload without a
      // redeploy. Best-effort: a failed refresh dispatches the last-known
      // registration instead of killing the turn.
      try {
        await getAgentRuntime(this.requireThread()).refreshRuntime?.();
      } catch (error) {
        console.warn("agent runtime refresh failed; dispatching last-known registry", error);
      }
      const exit = await Effect.runPromiseExit(this.turnProgram(turnId, abort.signal));
      if (Exit.isFailure(exit)) {
        const rendered = Cause.pretty(exit.cause);
        if (!rendered.includes("FSM violation")) {
          console.error(`turn driver for ${turnId} failed`, rendered);
        }
      }
    } finally {
      this.activeDrivers.delete(turnId);
      // M1.5 T17: the child-run gate decides what a finished turn means —
      // another reminder (ladder), a park (pending owned spawns), or the
      // settlement delivery. Whatever it is, the parent hears the terminal
      // outcome ("finished and failed subagents both stay interrogable",
      // task semantics §5). Idempotent end-to-end: the verdict fold is
      // journal-pure, the parent dedups by spawnId, and a revived child
      // re-runs the same fold.
      if (this.state.subagentIdentity !== null) {
        await this.advanceChildRun();
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
        // T18 budget gates (task semantics §4.1), evaluated from the run's
        // request tally before every model call: crossing the soft cap
        // steers ONE wind-down notice into the live turn; the hard stop
        // (1.5× soft / wall clock) arms the single forced terminal-yield
        // attempt and, once that attempt has executed a yield call, ends
        // the turn — the child-run gate then settles (usable yield →
        // deliver; else partial findings as the formal report).
        const budgetVerdict = yield* Effect.promise(() =>
          self.checkRunBudget(turnId, turn.inputId),
        );
        if (budgetVerdict === "stop") {
          yield* Effect.promise(() => self.appendEvent("turn.completed", { turnId }));
          return;
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
          // #326 reactive overflow face: a pre-first-byte provider rejection
          // whose message names the context window becomes compact-and-retry
          // instead of the raw failure. The turn still fails (honest journal
          // — the attempt did fail); the auto compact turn + retry turn
          // recover the session without user action.
          if (
            self.cfg.autoCompactionEnabled &&
            !signal.aborted &&
            self.state.subagentIdentity === null &&
            isContextOverflowFailure(outcome.failureMessage)
          ) {
            yield* Effect.promise(() =>
              self.appendEvent("turn.failed", { turnId, reason: "context_overflow" }),
            );
            yield* Effect.promise(() => self.autoCompactAndRetry(turnId));
            return;
          }
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
        if (outcome.usage !== undefined) {
          const usage = outcome.usage;
          yield* Effect.promise(() =>
            self.appendEvent("model.usage_receipt", {
              turnId,
              modelCallId: outcome.modelCallId,
              usage,
            }),
          );
        }
        if (outcome.toolCalls.length === 0) {
          yield* Effect.promise(() => self.appendEvent("turn.completed", { turnId }));
          // #326 proactive face: the just-settled turn may have crossed the
          // compaction threshold — compact now, between turns, so the next
          // input never sees a raw overflow. Fire-and-forget: the journal is
          // the only truth clients observe (compact RPC posture).
          self.ctx.waitUntil(self.maybeAutoCompactAfterTurn());
          return;
        }
        const batch: BatchScheduleItem[] = [];
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
          batch.push({
            executionId: executionIdFor(self.requireThread(), record.seq),
            tool: toolCall.name,
            arguments: toolCall.arguments,
          });
        }
        // #328 C3: conflict-aware batch scheduling (pi agent-loop anchor).
        // The batch splits into waves of mutually non-conflicting calls —
        // read-only calls run together, same-file write/write and read/write
        // conflicts serialize — and each wave settles before the next
        // dispatches, so a conflicting call can never execute concurrently
        // with its predecessor.
        const waves = scheduleBatch(batch);
        for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
          const wave = waves[waveIndex];
          if (wave === undefined) continue;
          const midBatchTurn = self.state.turns.get(turnId);
          if (midBatchTurn === undefined || turnTerminal(midBatchTurn)) return;
          if (midBatchTurn.status === "cancelling") {
            // Cancel landed between waves: undispatched executions have no
            // daemon presence (kill no-ops on unknown ids; watchdog re-asks
            // require a dispatch row) — seal them so the turn converges.
            yield* Effect.promise(() =>
              self.sealUndispatchedExecutions(turnId, waves.slice(waveIndex).flat()),
            );
            yield* Effect.promise(() => self.finalizeCancel(turnId));
            return;
          }
          yield* Effect.forEach(
            wave,
            (executionId) => Effect.promise(() => self.dispatchExecution(turnId, executionId)),
            {
              concurrency: "unbounded",
              discard: true,
            },
          );
          const waitOutcome: "done" | "cancelled" | "turn_failed" = yield* Effect.promise(() =>
            self.waitForExecutions(turnId, wave, signal),
          );
          if (waitOutcome === "done") continue;
          yield* Effect.promise(() =>
            self.sealUndispatchedExecutions(turnId, waves.slice(waveIndex + 1).flat()),
          );
          if (waitOutcome === "cancelled") {
            yield* Effect.promise(() => self.finalizeCancel(turnId));
          }
          return;
        }
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
      let usage: ModelUsageReceipt | undefined;
      let pendingDelta = "";
      let pendingDeltaBytes = 0;
      let pendingThinking = "";
      let pendingThinkingBytes = 0;
      let lastFlushAt = Date.now();
      const flushDelta = (): Effect.Effect<void> =>
        Effect.promise(async () => {
          if (pendingDelta === "") return;
          const chunk = pendingDelta;
          pendingDelta = "";
          pendingDeltaBytes = 0;
          text += chunk;
          const turn = self.state.turns.get(turnId);
          if (turn !== undefined && !turn.phases.includes("first_token")) {
            // #197 D3: turn-level once, immediately before the first
            // non-empty delta row lands. The fold-driven check keeps a
            // resumed driver (recovered mid-stream) from re-appending.
            await self.appendEvent("turn.phase", { turnId, phase: "first_token", modelCallId });
          }
          await self.appendEvent("model.delta", {
            turnId,
            modelCallId,
            text: chunk,
          });
        });
      /**
       * #257 CoT flush: `model.thinking` rows under the same
       * deltaFlushBytes/deltaFlushMs discipline so the journal row rate
       * stays capped and the hub delta pointer fires with it. Deliberately
       * NOT a `first_token` trigger — the phase vocabulary keeps
       * first_token answer-bound (spec §3.2: "首个非空 model.delta"), the
       * Thinking indicator drives off the reasoning rows themselves.
       */
      const flushThinking = (): Effect.Effect<void> =>
        Effect.promise(async () => {
          if (pendingThinking === "") return;
          const chunk = pendingThinking;
          pendingThinking = "";
          pendingThinkingBytes = 0;
          await self.appendEvent("model.thinking", {
            turnId,
            modelCallId,
            text: chunk,
          });
        });
      const guarded: Effect.Effect<ModelCallOutcome, ProviderPullFailure> = Effect.gen(
        function* () {
          // #351: registry resolution (fail-closed) joins the pull-failure
          // channel — a drifted journaled selection retries and lands the
          // model.call_failed/turn.failed ladder like any provider error,
          // instead of killing the driver as a defect.
          const provider = yield* Effect.try({
            try: () => self.resolveTurnProvider(turnId),
            catch: (error: unknown) => new ProviderPullFailure(error),
          });
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
            if (chunk.kind === "usage") {
              usage = chunk.usage;
              continue;
            }
            if (chunk.kind === "thinking-delta") {
              if (!sawFirstByte) {
                sawFirstByte = true;
                lastFlushAt = Date.now();
                yield* Effect.promise(() =>
                  self.appendEvent("turn.phase", { turnId, phase: "stream_started", modelCallId }),
                );
              }
              pendingThinking += chunk.text;
              pendingThinkingBytes += new TextEncoder().encode(chunk.text).byteLength;
              const now = Date.now();
              if (
                pendingThinkingBytes >= self.cfg.deltaFlushBytes ||
                now - lastFlushAt >= self.cfg.deltaFlushMs
              ) {
                lastFlushAt = now;
                yield* flushThinking();
              }
              continue;
            }
            if (chunk.kind === "text-delta") {
              if (!sawFirstByte) {
                sawFirstByte = true;
                lastFlushAt = Date.now();
                // #197 D3: 首字节已见 — the user-perceivable stream start,
                // not the dispatch moment (retries can die silently). Once
                // per model call: a retry legitimately repeats the row.
                yield* Effect.promise(() =>
                  self.appendEvent("turn.phase", { turnId, phase: "stream_started", modelCallId }),
                );
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
            yield* flushThinking();
            return {
              kind: "completed" as const,
              modelCallId,
              text,
              toolCalls: chunk.toolCalls,
              ...(usage !== undefined ? { usage } : {}),
            };
          }
          yield* flushDelta();
          yield* flushThinking();
          return {
            kind: "completed" as const,
            modelCallId,
            text,
            toolCalls: [],
            ...(usage !== undefined ? { usage } : {}),
          };
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
    return { kind: "failed", modelCallId, failureMessage: failure.message };
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
    // #150 experimental gates: the wire assembly filters the experimental
    // tools by the deployment gates, then applies the omp supports(model)
    // verdict (sdk.ts:4275-4282) and derives the forceReasoningOff pin from
    // the RENDERED surface — the DO does not know the relay model id, so the
    // "external CoT ∧ native reasoning never coexist" pairing can only be
    // computed at the wire (#257: pinning off the gate alone killed the
    // native CoT pathway for native-reasoning models like glm-5.3).
    const gated: ModelRequest = {
      ...request,
      // #448: the 产图源 seat gates generate_image (its presence is the
      // user opt-in; #450 — no env fallback) — read per request so a panel
      // edit lands on the next turn without a redeploy.
      experimentalGates: {
        ...this.experimentalGates,
        generateImage: this.imageSource !== null,
      },
    };
    // Matrix C2 (#327): the discovered MCP surface rides every call — the
    // TTL cache inside McpToolSurface bounds the tools/list round-trips, a
    // failing server contributes nothing this call (server isolation), and
    // with no servers configured this line is absent entirely (byte-identical
    // request shape).
    const mcpTools = this.mcpSurface.enabled ? await this.mcpSurface.wireTools() : undefined;
    // M1.5 T16 surface policy: a subagent DO (journaled identity) renders the
    // subagent toolset — hidden `yield` included — with `task` stripped past
    // the recursion cap (omp canSpawnAtDepth gate). Main keeps MAIN_WIRE_TOOLS.
    const identity = this.state.subagentIdentity;
    if (identity === null) {
      // #309/#326: translate derives the tool-free `compaction` surface for
      // compact turns (their `compact-…` inputId); those calls also skip the
      // MCP tools/list round trip the summarizer can never use.
      if (gated.toolSurface === "compaction") return gated;
      return { ...gated, ...(mcpTools === undefined ? {} : { mcpTools }) };
    }
    return {
      ...gated,
      ...(mcpTools === undefined ? {} : { mcpTools }),
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
    return this.daemonFor(this.state.machineId ?? CLOUD_PLACEHOLDER_HOST_ID);
  }

  /**
   * #289 host:path override: the per-dispatch resolution. A parameter-level
   * override rides the TARGET machine's service DO (§2.2 — the frame's
   * machineId leg already exists, zero protocol change); every other leg
   * (ack/kill/ack-query/isolation) stays on the bound machine.
   */
  private daemonFor(machineId: string): DaemonServiceClient {
    const namespace = this.env.DAEMON_SERVICE;
    if (namespace !== undefined && this.threadId !== null) {
      // Binding-shaped stub; the interface is the seam contract (#30). The
      // service DO is per-machine (§1.2, model two): named by the thread's
      // machineId — the same name the daemon client opens its session under.
      // (#30 wrangler: "env.DAEMON_SERVICE.idFromName(machineId)").
      return namespace.get(namespace.idFromName(machineId)) as unknown as DaemonServiceClient;
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

  /**
   * #289 B4 exec-tier gate: a host:path override is an exec-class operation
   * (远端强制 exec 档). The TARGET host's permission ceiling is the grant —
   * hosts.max_permission_mode must be "full"; anything narrower rejects
   * BEFORE the remote DO stub resolves (连接前硬拒 — the rejection never
   * reaches the target). An absent or destroyed registry row is
   * `unknown_host`: the explicit failure, never a fallback to the bound
   * machine (§2.2 last clause; the deployment-default machine gets its row
   * from the attach bridge, so a live daemon always has one). Registry-
   * unbound deployments (rig/standalone DO) cannot consult ceilings: the
   * dispatch goes out and the target service DO's own session/machineId
   * check remains the gate (`host_offline`). A bound registry that FAILS
   * the read rejects (`registry_unavailable`) — a permission gate never
   * silently fails open while blind. Point-in-time check: a ceiling change
   * between re-asks re-evaluates, the same honesty a mid-run disconnect
   * already gets.
   */
  private async checkOverrideTarget(hostId: string): Promise<string | null> {
    const db = this.env.DB;
    if (db === undefined) return null;
    let row: { max_permission_mode: string; destroyed_at: number | null } | null;
    try {
      row = await db
        .prepare("SELECT max_permission_mode, destroyed_at FROM hosts WHERE id = ?")
        .bind(hostId)
        .first<{ max_permission_mode: string; destroyed_at: number | null }>();
    } catch (error) {
      console.error(`hosts registry read failed for override target ${hostId}`, error);
      return (
        `registry_unavailable: the hosts registry read for "${hostId}" failed — ` +
        `the ssh:// override is refused until the registry answers`
      );
    }
    if (row === null) {
      return `unknown_host: no registered host "${hostId}" for the ssh:// override`;
    }
    if (row.destroyed_at !== null) {
      return `unknown_host: host "${hostId}" is destroyed (deletion is explicit and never resurrects)`;
    }
    if (row.max_permission_mode !== "full") {
      return (
        `exec_tier_required: a host:path override is an exec-class operation and host ` +
        `"${hostId}" ceiling is "${row.max_permission_mode}" — raise the host ceiling or ` +
        `run the call on the bound machine`
      );
    }
    return null;
  }

  /** I4: the `tool.call` row is already durable before this can run. */
  private async dispatchExecution(turnId: string, executionId: string): Promise<void> {
    const execution = this.state.executions.get(executionId);
    if (execution === undefined || executionTerminal(execution)) return;
    const threadId = this.requireThread();
    const callData = this.eventData(execution.callSeq);
    const toolName = callData?.type === "tool.call" ? callData.data.tool : "unknown";
    const row = toolRegistryRow(toolName);
    // M1.5 T17: `agent://` and `history://` URIs are DO-mesh surfaces — the
    // artifacts live in child DO storage, unreachable from the host fs the
    // daemon reads. read/write calls carrying them route to the in-DO
    // resolver here, ahead of the registry backend row (everything else
    // keeps its row backend untouched).
    if (callData?.type === "tool.call") {
      const uri = callData.data.arguments.path;
      if (typeof uri === "string" && uri.startsWith("agent://")) {
        if (toolName === "read") {
          await this.executeAgentUriRead(execution, uri);
          return;
        }
        if (toolName === "write") {
          await this.executeAgentUriWrite(execution, uri, callData.data.arguments.content);
          return;
        }
      }
      if (toolName === "read" && typeof uri === "string" && uri.startsWith("history://")) {
        await this.executeAgentUriRead(execution, uri);
        return;
      }
      if (toolName === "write" && typeof uri === "string" && uri.startsWith("proc://")) {
        // M1.5 T19 cancel entry 1: `write proc://<jobId>/kill` — in-DO
        // business cancellation (omp docs/tools/task.md:26/:158), no daemon
        // involvement; the T6 unknown-target refusal is superseded here.
        await this.executeProcUriWrite(execution, uri, callData.data.arguments.content);
        return;
      }
    }
    if (row?.class === "edge") {
      // Edge routing (control-plane §1.2): registry row's do-local backend
      // executes here — journal appends are DO storage writes, never daemon RPC.
      if (callData?.type === "tool.call") {
        await this.executeEdgeLocal(execution, row, callData.data.arguments);
      }
      return;
    }
    if (toolName.startsWith("mcp__")) {
      // Matrix C2 (#327): MCP tools are deployment-config-discovered, never
      // registry rows (control-plane §1.1 stays the registered schema
      // authority) — the wire-name prefix routes them to the in-DO executor,
      // the same iron rules as executeEdgeLocal (idempotent re-ask,
      // journal-first result, zero daemon touches).
      if (callData?.type === "tool.call") {
        await this.executeMcpLocal(execution, toolName, callData.data.arguments);
      }
      return;
    }
    // #289 B1: parameter-level host:path override — resolved BEFORE the
    // dispatch leaves the DO, deterministically from the journaled call
    // arguments (a watchdog re-ask lands on the same target + rewrite; the
    // service journal dedups by executionId). Parse failures and gate
    // rejections ingest a structured error result directly — no
    // `tool.dispatch` row, the same shape as the in-DO URI-read resolutions
    // above; a routed override rides the TARGET machine's service DO with
    // the deviation journaled on the row (B2).
    const boundMachineId = this.state.machineId ?? CLOUD_PLACEHOLDER_HOST_ID;
    const override: HostPathResolution =
      callData?.type === "tool.call"
        ? resolveHostPathOverride(toolName, callData.data.arguments)
        : null;
    if (override !== null && "error" in override) {
      await this.ingestResult(
        execution,
        { status: "error", exitCode: null, output: override.error },
        { ack: false },
      );
      return;
    }
    // A rewrite back to the bound machine (ssh://<bound>/…) is not a
    // deviation: no gate, no journal field — the call stays where it was
    // bound, only the prefix is stripped.
    const overriddenMachineId =
      override !== null && override.machineId !== boundMachineId ? override.machineId : null;
    if (overriddenMachineId !== null) {
      const rejected = await this.checkOverrideTarget(overriddenMachineId);
      if (rejected !== null) {
        await this.ingestResult(
          execution,
          { status: "error", exitCode: null, output: rejected },
          { ack: false },
        );
        return;
      }
    }
    let outcome: DispatchOutcome;
    try {
      outcome = await this.daemonFor(overriddenMachineId ?? boundMachineId).dispatch({
        threadId,
        turnId,
        executionId,
        machineId: overriddenMachineId ?? boundMachineId,
        tool: toolName,
        arguments:
          override !== null
            ? override.arguments
            : callData?.type === "tool.call"
              ? callData.data.arguments
              : {},
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
      ...(overriddenMachineId !== null ? { overriddenMachineId } : {}),
    });
    if (outcome.kind === "completed_cached") {
      await this.ingestResult(execution, outcome.result);
      return;
    }
    if (outcome.kind === "host_offline") {
      await this.ingestResult(execution, {
        status: "error",
        exitCode: null,
        // Bound-machine offline keeps the M0 exact payload (ux placeholder
        // matches on it); an override target names itself so the model can
        // retry locally or against another host.
        output:
          overriddenMachineId === null
            ? "host_offline"
            : `host_offline: override target "${overriddenMachineId}" has no live daemon session`,
      });
    }
  }

  /**
   * Recovery re-ask driver (#328 C3): waves of mutually non-conflicting
   * executions; each wave settles before the next dispatches, so a same-file
   * conflict re-dispatches only after its predecessor is terminal — the
   * mutex survives eviction. Per-execution semantics are unchanged
   * at-least-once re-ask (service journal dedups; the service DO settles
   * dispatch at spawn-ack, results arrive via onExecutionUpdate). Blocking
   * edge executors (wait/ask) dispatch without awaiting and never join a
   * settlement wait — they park on their wake channels until answered or
   * capped.
   */
  private async redispatchScheduled(executions: ExecutionRuntime[]): Promise<void> {
    const waves = scheduleBatch(
      executions.map((execution) => {
        const callData = this.eventData(execution.callSeq);
        return {
          executionId: execution.executionId,
          tool: execution.tool,
          arguments: callData?.type === "tool.call" ? callData.data.arguments : {},
        };
      }),
    );
    for (const wave of waves) {
      const dispatches: Promise<void>[] = [];
      const settleable: string[] = [];
      for (const executionId of wave) {
        const execution = this.state.executions.get(executionId);
        if (execution === undefined || executionTerminal(execution)) continue;
        if (execution.tool === "wait" || execution.tool === "ask") {
          // Blocking edge executors park — the same detached dispatch the
          // inline recovery loop always ran; a lost run stays non-terminal
          // and the next recovery re-asks again.
          void this.dispatchExecution(execution.turnId, executionId).catch((error: unknown) => {
            console.error(`recovery dispatch of ${executionId} failed`, error);
          });
          continue;
        }
        dispatches.push(
          this.dispatchExecution(execution.turnId, executionId).catch((error: unknown) => {
            console.error(`recovery dispatch of ${executionId} failed`, error);
          }),
        );
        settleable.push(executionId);
      }
      await Promise.all(dispatches);
      if (settleable.length > 0) await this.waitForExecutionSettlement(settleable);
    }
  }

  /** Resolves when every named execution is terminal (settlement wake). */
  private waitForExecutionSettlement(executionIds: string[]): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    const check = (): void => {
      if (
        executionIds.every((executionId) => {
          const execution = this.state.executions.get(executionId);
          return execution === undefined || executionTerminal(execution);
        })
      ) {
        for (const executionId of executionIds) {
          const waiters = this.execWaiters.get(executionId);
          if (waiters === undefined) continue;
          const filtered = waiters.filter((waiter) => waiter.turnId !== SETTLEMENT_WAITER_MARK);
          if (filtered.length === 0) this.execWaiters.delete(executionId);
          else this.execWaiters.set(executionId, filtered);
        }
        resolve(undefined);
      }
    };
    for (const executionId of executionIds) {
      const existing = this.execWaiters.get(executionId) ?? [];
      existing.push({ turnId: SETTLEMENT_WAITER_MARK, wake: check });
      this.execWaiters.set(executionId, existing);
    }
    check();
    return promise;
  }

  /** `read agent://…` / `read history://…` — resolve in the DO mesh, journal
   * the result like any edge-local execution (no daemon involvement, no ack).
   */
  private async executeAgentUriRead(execution: ExecutionRuntime, uri: string): Promise<void> {
    let result: { status: "ok" | "error"; output: string; truncated?: boolean };
    try {
      result = uri.startsWith("history://")
        ? await this.readAgentHistoryUri(uri)
        : await this.readAgentArtifactUri(uri);
    } catch (error) {
      result = {
        status: "error",
        output: error instanceof AgentRpcError ? error.message : String(error),
      };
    }
    await this.ingestResult(
      execution,
      {
        status: result.status,
        exitCode: null,
        output: result.output,
        ...(result.truncated === true ? { outputTruncated: true } : {}),
      },
      { ack: false },
    );
  }

  /** `write agent://<id|all>` — the write-only broadcast face (T17); parked
   * revival rides the T19 lifecycle lane, so delivery never starts turns.
   */
  private async executeAgentUriWrite(
    execution: ExecutionRuntime,
    uri: string,
    content: unknown,
  ): Promise<void> {
    const text = typeof content === "string" ? content : "";
    if (uri === "agent://all") {
      const { events } = await this.readAllEvents();
      const plans = projectSpawnPlans(events);
      let delivered = 0;
      const from = this.state.subagentIdentity?.agentId ?? "Main";
      for (const plan of plans) {
        // One delivery per child — the cross-DO budget face (×N children).
        const landed = await this.deliverToChild(plan.childThreadId, from, text);
        if (landed) delivered += 1;
      }
      await this.ingestResult(
        execution,
        { status: "ok", exitCode: null, output: `Broadcast to ${delivered} subagent(s).` },
        { ack: false },
      );
      return;
    }
    const parsed = parseAgentUri(uri);
    if (parsed === null) {
      await this.ingestResult(
        execution,
        { status: "error", exitCode: null, output: `Malformed agent URI: ${uri}` },
        { ack: false },
      );
      return;
    }
    try {
      const target = await this.resolveArtifactTarget(parsed.agentId);
      const from = this.state.subagentIdentity?.agentId ?? "Main";
      const delivered = await target.stub.deliverPeerMessage({
        ownerId: target.childThreadId,
        from,
        text,
      });
      // T19 revival receipt: a parked recipient answers `revived` (the
      // durable row is task.subagent_revived on the child journal).
      await this.ingestResult(
        execution,
        {
          status: "ok",
          exitCode: null,
          output: delivered.revived
            ? `Delivered to ${parsed.agentId} (revived — session rebuilt from transcript).`
            : `Delivered to ${parsed.agentId}.`,
        },
        { ack: false },
      );
    } catch (error) {
      await this.ingestResult(
        execution,
        {
          status: "error",
          exitCode: null,
          output:
            error instanceof AgentRpcError ? error.message : `Delivery failed: ${String(error)}`,
        },
        { ack: false },
      );
    }
  }

  private async deliverToChild(
    childThreadId: string,
    from: string,
    text: string,
  ): Promise<boolean> {
    const namespace = this.env.AGENT_DO;
    if (namespace === undefined) return false;
    const stub = namespace.get(namespace.idFromName(childThreadId)) as unknown as SubagentDoStub;
    try {
      await stub.deliverPeerMessage({ ownerId: childThreadId, from, text });
      return true;
    } catch (error) {
      console.error(`agent://all delivery to ${childThreadId} failed`, error);
      return false;
    }
  }

  /** `write proc://<jobId>/kill` edge-local execution (T19 cancel entry 1).
   * Everything here is business-cancel semantics (matrix §2.4): unknown or
   * foreign jobs are error OUTPUTS (never thrown), an already-settled job
   * answers an idempotent receipt with zero rows, and only a running owned
   * job kills. */
  private async executeProcUriWrite(
    execution: ExecutionRuntime,
    uri: string,
    content: unknown,
  ): Promise<void> {
    let result: { status: "ok" | "error"; output: string };
    try {
      result = await this.killByProcUri(uri, content);
    } catch (error) {
      result = {
        status: "error",
        output: error instanceof AgentRpcError ? error.message : `Kill failed: ${String(error)}`,
      };
    }
    await this.ingestResult(
      execution,
      { status: result.status, exitCode: null, output: result.output },
      { ack: false },
    );
  }

  private async killByProcUri(
    uri: string,
    content: unknown,
  ): Promise<{ status: "ok" | "error"; output: string }> {
    const parsed = parseProcKillUri(uri);
    if (parsed === null) {
      return {
        status: "error",
        output: `Unknown proc target: ${uri} — only proc://<jobId>/kill is supported.`,
      };
    }
    // omp docs/tools/task.md:26 — the kill form carries no content.
    if (typeof content === "string" && content !== "") {
      return {
        status: "error",
        output: "kill takes no content — `write proc://<jobId>/kill` with empty content.",
      };
    }
    const callerOwnerId = this.requireThread();
    const { events } = await this.readAllEvents();
    const jobs = projectJobs(events);
    const decision = decideKill(parsed.jobId, jobs.job(parsed.jobId), callerOwnerId, (jobId) =>
      projectSpawnPlans(events).find((record) => record.jobId === jobId),
    );
    switch (decision.kind) {
      case "unknown_job":
        return { status: "error", output: `Unknown job ${decision.jobId} — nothing to kill.` };
      case "forbidden":
        return {
          status: "error",
          output: `Job ${decision.jobId} is not yours — kill is owner-scoped (omp visibleJobs).`,
        };
      case "already_settled":
        return {
          status: "ok",
          output: `Job ${decision.jobId} already settled (${decision.settlementStatus}); kill is a no-op.`,
        };
      case "kill":
        break;
    }
    const plan = decision.plan;
    // Journal-first: the parent-side tombstone lands BEFORE the child RPC
    // and the cancelled settle — a child completion that raced the kill is
    // confirm-only from here on (tombstone resistance), and the settle below
    // is the only waiter wake.
    if (plan !== null) {
      await this.appendEvent("task.subagent_aborted", {
        spawnId: plan.spawnId,
        agentId: plan.agentId,
        reason: "kill",
      });
      const namespace = this.env.AGENT_DO;
      if (namespace !== undefined) {
        const stub = namespace.get(
          namespace.idFromName(plan.childThreadId),
        ) as unknown as SubagentDoStub;
        await stub
          .abortSubagent({ spawnId: plan.spawnId, agentId: plan.agentId, reason: "kill" })
          .catch((error: unknown) => {
            // The child tombstone is availability, not truth: the parent
            // tombstone above already closed the parent-side semantics.
            console.error(`kill ${plan.agentId}: child abort failed`, error);
          });
      }
    }
    await this.settleJob(parsed.jobId, {
      status: "cancelled",
      output:
        plan === null
          ? "service cancelled via proc:// kill"
          : `subagent ${plan.agentId} killed via proc:// kill`,
    });
    return {
      status: "ok",
      output:
        plan === null
          ? `Killed ${parsed.jobId}; waiters settle cancelled.`
          : `Killed ${plan.agentId} (${parsed.jobId}); session released, waiters settle cancelled.`,
    };
  }

  /** `agent://<id>[/<json path>]` — sidecar-first extraction matrix. */
  private async readAgentArtifactUri(uri: string): Promise<{
    status: "ok" | "error";
    output: string;
    truncated?: boolean;
  }> {
    const parsed = parseAgentUri(uri);
    if (parsed === null) throw new AgentRpcError("invalid", `Malformed agent URI: ${uri}`);
    if (parsed.agentId === "all") {
      throw new AgentRpcError("invalid", "agent://all is write-only (omp broadcast face).");
    }
    const target = await this.resolveArtifactTarget(parsed.agentId);
    const kind = parsed.path === undefined ? "output" : "json";
    const served = await target.stub.readAgentArtifact({
      agentId: parsed.agentId,
      kind,
      ...(parsed.path === undefined ? {} : { path: parsed.path }),
    });
    return { status: "ok", output: served.output, truncated: served.truncated };
  }

  private async readAgentHistoryUri(uri: string): Promise<{
    status: "ok" | "error";
    output: string;
    truncated?: boolean;
  }> {
    const rest = uri.slice("history://".length);
    if (rest === "" || rest.includes("/") || rest.includes("?") || rest.includes("#")) {
      throw new AgentRpcError("invalid", `Malformed history URI: ${uri}`);
    }
    const target = await this.resolveArtifactTarget(rest);
    const served = await target.stub.readAgentArtifact({ agentId: rest, kind: "history" });
    return { status: "ok", output: served.output, truncated: served.truncated };
  }

  /**
   * Hop resolution: this DO serves its OWN agentId; a direct spawn match
   * forwards one hop deeper with the same full id; a nested id resolves its
   * first-segment ancestor here and forwards. Each hop = one cross-DO read
   * (practice-11 budget: agent:// reads are ×hops, uncached by design).
   */
  private async resolveArtifactTarget(
    agentId: string,
  ): Promise<{ stub: SubagentDoStub; childThreadId: string }> {
    const identity = this.state.subagentIdentity;
    if (identity !== null && identity.agentId === agentId) {
      return { stub: this as unknown as SubagentDoStub, childThreadId: this.requireThread() };
    }
    const namespace = this.env.AGENT_DO;
    if (namespace === undefined) {
      throw new AgentRpcError("no_runtime", "no AGENT_DO binding; agent:// is unresolvable here");
    }
    const { events } = await this.readAllEvents();
    const plans = projectSpawnPlans(events);
    const direct = plans.find((plan) => plan.agentId === agentId);
    const firstDot = agentId.indexOf(".");
    const ancestor =
      direct === undefined && firstDot > 0
        ? plans.find((plan) => plan.agentId === agentId.slice(0, firstDot))
        : undefined;
    const plan = direct ?? ancestor;
    if (plan === undefined) {
      throw new AgentRpcError(
        "not_found",
        `No subagent "${agentId}" known to ${identity?.agentId ?? "Main"}.`,
      );
    }
    return {
      stub: namespace.get(namespace.idFromName(plan.childThreadId)) as unknown as SubagentDoStub,
      childThreadId: plan.childThreadId,
    };
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
    if (row.name === "web_search") {
      // M1.5 T12: register the cancel controller BEFORE the executor runs so
      // killNonTerminalExecutions can abort an in-flight transport; the
      // executor surfaces the abort as a cancelled tool result itself.
      this.webSearchAborts.set(execution.executionId, new AbortController());
    }
    const webSearchAbort =
      row.name === "web_search" ? this.webSearchAborts.get(execution.executionId) : undefined;
    if (row.name === "generate_image") {
      // B2 #322: register the cancel controller BEFORE the executor runs
      // (the web_search posture): killNonTerminalExecutions aborts an
      // in-flight image transport; the executor journals `cancelled`.
      this.generateImageAborts.set(execution.executionId, new AbortController());
    }
    const generateImageAbort =
      row.name === "generate_image"
        ? this.generateImageAborts.get(execution.executionId)
        : undefined;
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
      // T17 yield gate: the fold source for schema/empty streaks + identity
      // schema (tools/task/child-run.ts). Bound for every edge call; only
      // the yield row consumes it.
      yieldJournal: async () => (await this.readAllEvents()).events,
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
      ...(webSearchAbort ? { webSearch: this.webSearchToolContext(webSearchAbort.signal) } : {}),
      ...(generateImageAbort
        ? { generateImage: this.generateImageToolContext(threadId, generateImageAbort.signal) }
        : {}),
    }).finally(() => {
      this.edgeWaiters.delete(execution.executionId);
      this.askWaiters.delete(execution.executionId);
      this.waitWindows.delete(execution.executionId);
      this.webSearchAborts.delete(execution.executionId);
      this.generateImageAborts.delete(execution.executionId);
    });
    await this.ingestResult(
      execution,
      {
        status: result.status,
        exitCode: null,
        output: result.output,
        ...(result.images ? { images: result.images } : {}),
      },
      { ack: false },
    );
  }

  /**
   * DO-local MCP execution (matrix C2, #327): the same iron rules as
   * executeEdgeLocal — executionId dedup guards re-asks (a terminal
   * execution re-asked after eviction answers from the journal, never a
   * second execution), the result persists as `tool.result` before any
   * waiter wakes, zero daemon involvement. Cancel rides the web_search
   * vocabulary (killNonTerminalExecutions aborts the registered controller;
   * the transport surfaces it and the executor journals `cancelled`).
   */
  private async executeMcpLocal(
    execution: ExecutionRuntime,
    wireName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (executionTerminal(execution)) return;
    const route: McpToolRoute | undefined = this.mcpSurface.routeOf(wireName);
    if (route === undefined) {
      // Fail closed with a structured answer: the name was on the wire once
      // (the model could only have learned it from discovery) but routes no
      // longer carry it — stale surface after a DO eviction whose discovery
      // now fails, or the server dropped the tool. Never a daemon dispatch.
      await this.ingestResult(
        execution,
        {
          status: "error",
          exitCode: null,
          output: `mcp: no live route for ${wireName} — the server failed discovery this turn or no longer lists the tool`,
        },
        { ack: false },
      );
      return;
    }
    // Register the cancel controller BEFORE the executor runs (web_search
    // discipline, M1.5 T12).
    const abort = new AbortController();
    this.mcpAborts.set(execution.executionId, abort);
    try {
      const result = await this.mcpSurface.callTool(route, args, {
        signal: abort.signal,
        timeoutMs: execution.timeoutMs,
      });
      const output = limitMcpOutput(projectMcpToolOutput(result));
      await this.ingestResult(
        execution,
        { status: result.isError === true ? "error" : "ok", exitCode: null, output },
        { ack: false },
      );
    } catch (error) {
      // Cancelled owning call/turn: the cancelled tool.result row (omp
      // throwIfAborted rethrow semantics); anything else is an error result —
      // transport text surfaces verbatim so the model can retry or reroute.
      const cancelled = abort.signal.aborted;
      await this.ingestResult(
        execution,
        {
          status: cancelled ? "cancelled" : "error",
          exitCode: null,
          output: cancelled
            ? "cancelled: the owning turn was cancelled while the MCP call was in flight"
            : `mcp: ${error instanceof Error ? error.message : String(error)}`,
        },
        { ack: false },
      );
    } finally {
      this.mcpAborts.delete(execution.executionId);
    }
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
        // The owning provider id comes from the turn's journaled execution
        // (#434: never the retired "omp" sentinel); a pre-#351 journal
        // without an execution carries the honest "unknown".
        const providerId =
          this.state.turns.get(execution.turnId)?.execution?.providerId ?? "unknown";
        await this.appendEvent("interaction.registered", {
          interactionId: input.interactionId,
          turnId: execution.turnId,
          executionId: execution.executionId,
          providerId,
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
    // B1 (#321): image artifacts ride the result payload; each lands its own
    // journal row BEFORE the closing tool.result (todo_phases
    // journal-before-result ordering, parentToolCallId = the bare call
    // executionId). The terminal guard above is the idempotency: a result
    // redelivered after ack is dropped, so the rows append exactly once per
    // settled execution.
    for (const image of result.images ?? []) {
      await this.appendEvent("imageView", {
        turnId: execution.turnId,
        parentToolCallId: execution.executionId,
        path: image.path,
      });
    }
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
      await this.settleTurnIfReady(execution.turnId);
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
    await this.settleTurnIfReady(execution.turnId);
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
        // web_search rides the same vocabulary: abort the in-flight
        // transport; the executor journals the cancelled tool.result row.
        this.webSearchAborts.get(executionId)?.abort();
        // generate_image too (B2 #322): same abort-as-cancelled vocabulary.
        this.generateImageAborts.get(executionId)?.abort();
        continue;
      }
      if (execution.tool.startsWith("mcp__")) {
        // Matrix C2 (#327): MCP rides the same vocabulary — abort the
        // in-flight transport; the executor journals the cancelled
        // tool.result row. Never a daemon kill (no daemon execution exists).
        this.mcpAborts.get(executionId)?.abort();
        continue;
      }
      try {
        await this.daemon().kill(executionId);
      } catch {
        // Ruling I: kill is at-least-once; recovery re-sends after eviction.
      }
    }
  }

  /**
   * #328 C3 wave scheduling: executions a settling turn never dispatched
   * have no daemon presence — `kill` no-ops on unknown ids and the watchdog
   * re-ask requires a dispatch row (`lastDispatchAt`) — so without a seal
   * they would dangle non-terminal forever and cancellation could not
   * converge. The call never left the DO: "cancelled" is the honest
   * terminal, journaled here (I6: at most one result per executionId).
   */
  private async sealUndispatchedExecutions(turnId: string, executionIds: string[]): Promise<void> {
    for (const executionId of executionIds) {
      const execution = this.state.executions.get(executionId);
      if (execution === undefined || executionTerminal(execution)) continue;
      await this.appendEvent("tool.result", {
        turnId,
        executionId,
        status: "cancelled",
        exitCode: null,
        output: "",
      });
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
    // T19 TTL park deadline rides the single alarm (practice 4 — the alarm
    // table carries no park state; refreshLifecycleAlarms recomputes it).
    if (
      this.lifecycleParkDeadline !== null &&
      (next === null || this.lifecycleParkDeadline < next)
    ) {
      next = this.lifecycleParkDeadline;
    }
    if (next !== null) {
      void this.ctx.storage.setAlarm(next);
    } else {
      void this.ctx.storage.deleteAlarm().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // T19 subagent lifecycle timer (proposal §3 T19): idle → TTL park, via the
  // CHILD DO's alarm. Park is a local DO state write (ticket DO budget);
  // revival is message-triggered (deliverPeerMessage), zero polling.
  // -------------------------------------------------------------------------

  /** The armed park deadline (idleSince + TTL), or null when nothing arms. */
  private lifecycleParkDeadline: number | null = null;

  /** Re-derive the park deadline from the journal, then re-arm the alarm. */
  private async refreshLifecycleAlarms(): Promise<void> {
    try {
      this.lifecycleParkDeadline = await this.computeParkDeadline();
      this.armWatchdog();
    } catch (error) {
      console.error("lifecycle alarm refresh failed", error);
    }
  }

  /**
   * omp task.agentIdleTtlMs (default 420_000; ≤0 disables): an IDLE self
   * record parks when the TTL elapses from its idle moment. Main never parks
   * (identity null); a live turn means the agent is running, not idle.
   */
  private async computeParkDeadline(): Promise<number | null> {
    const identity = this.state.subagentIdentity;
    if (identity === null) return null;
    if (this.cfg.taskAgentIdleTtlMs <= 0) return null;
    const active = this.activeTurn();
    if (active !== undefined && !turnTerminal(active)) return null;
    const record = projectLifecycle((await this.readAllEvents()).events).record(identity.agentId);
    if (record?.state !== "idle" || record.idleSince === null) {
      return null;
    }
    return record.idleSince + this.cfg.taskAgentIdleTtlMs;
  }

  /** The alarm's park tick: fold-fresh and guarded — running / parked /
   * aborted / revived agents never (re-)park, and neither does Main. */
  private async parkIdleSelf(): Promise<void> {
    const identity = this.state.subagentIdentity;
    if (identity === null) return;
    const active = this.activeTurn();
    if (active !== undefined && !turnTerminal(active)) return;
    const record = projectLifecycle((await this.readAllEvents()).events).record(identity.agentId);
    if (record?.state !== "idle") return;
    await this.appendEvent("task.subagent_parked", {
      spawnId: identity.spawnId,
      agentId: identity.agentId,
    });
  }

  /**
   * Lifecycle maintenance tick (the alarm's park branch, also the ops/test
   * face where the platform alarm cannot fire — vitest-pool-workers never
   * triggers DO alarms): park an idle-past-TTL self record, then re-derive
   * the deadline (a revive that raced in clears it).
   */
  async sweepLifecycle(now: number = Date.now()): Promise<{ parked: boolean }> {
    if (this.lifecycleParkDeadline !== null && now >= this.lifecycleParkDeadline) {
      this.lifecycleParkDeadline = null;
      await this.parkIdleSelf();
    }
    await this.refreshLifecycleAlarms();
    const record = this.state.subagentIdentity
      ? projectLifecycle((await this.readAllEvents()).events).record(
          this.state.subagentIdentity.agentId,
        )
      : undefined;
    return { parked: record?.state === "parked" };
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

  /**
   * DO-bound `web_search` context (M1.5 T12, tools/web-search.ts): the
   * decoded provider config, the owning call's cancel signal (aborting
   * surfaces as a cancelled tool result — omp throwIfAborted), and global
   * fetch (MSW-intercepted under the vitest workers pool). Zero journal
   * state beyond the tool.result row (practice 11).
   */
  private webSearchToolContext(signal: AbortSignal): WebSearchToolContext {
    return {
      config: this.webSearchConfig,
      signal,
      fetchImpl: (input, init) => fetch(input, init),
    };
  }

  /**
   * DO-bound `generate_image` context (B2 #322, tools/generate-image.ts):
   * the decoded image source, the owning call's cancel signal, global
   * fetch, and the two daemon-service thread-file seams (the write is the
   * product's host-disk landing; the read resolves `input[].path` legs).
   * Both ride the per-machine service DO stub synchronously — the B2 twins
   * of the B1 host-file read face. The unwrapped outcome kinds map 1:1.
   */
  private generateImageToolContext(
    threadId: string,
    signal: AbortSignal,
  ): GenerateImageToolContext {
    const machineId = this.state.machineId ?? CLOUD_PLACEHOLDER_HOST_ID;
    return {
      config: this.imageSource,
      signal,
      fetchImpl: (input, init) => fetch(input, init),
      writeThreadFile: async ({ filename, contentBase64 }) => {
        const outcome = await this.daemon().hostThreadFileWrite({
          machineId,
          threadId,
          filename,
          contentBase64,
          timeoutMs: HOST_FILE_RPC_TIMEOUT_MS,
        });
        return outcome;
      },
      readThreadFile: async ({ path }) => {
        const outcome = await this.daemon().hostThreadFileRead({
          machineId,
          path,
          timeoutMs: HOST_FILE_RPC_TIMEOUT_MS,
        });
        return outcome;
      },
    };
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
      machineId: this.state.machineId ?? CLOUD_PLACEHOLDER_HOST_ID,
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
          ...(plan.context === undefined ? {} : { context: plan.context }),
          ...(plan.model === undefined ? {} : { model: plan.model }),
          ...((plan.outputSchema === undefined
            ? {}
            : { outputSchemaJson: JSON.stringify(plan.outputSchema) }) as {
            outputSchemaJson?: string;
          }),
          depth: plan.depth,
          ...((plan.isolation === undefined
            ? {}
            : { isolationJson: JSON.stringify(plan.isolation) }) as {
            isolationJson?: string;
          }),
          ...(plan.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: plan.parentToolCallId }),
        });
      },
      recordSpawnSettlement: async (settlement) => {
        await this.appendEvent("task.spawn_settled", settlement);
        // T18 permit lifecycle: the dispatch→settlement span ends here —
        // release the run's slot (no-op when the spawn was never permitted,
        // e.g. journal-replayed rows).
        this.releaseSpawnPermit(settlement.spawnId);
      },
      registry: {
        register: (input: JobRegistration) => this.registerJob(input),
        settle: (jobId: string, settlement: JobSettlement) => this.settleJob(jobId, settlement),
      },
      subagentHost,
      // T20 #110: the daemon isolation seam rides the DAEMON_SERVICE binding
      // (same machine-named DO the dispatch path uses); unbound deployments
      // leave it undefined and isolated spawns fail loudly.
      isolationOp:
        this.env.DAEMON_SERVICE === undefined
          ? undefined
          : (request) =>
              this.daemon().isolationOp({
                machineId: request.machineId,
                threadId: request.threadId,
                op: request.op,
                arguments: request.arguments,
                timeoutMs: request.timeoutMs,
              }),
      wake: () => {
        const { promise, resolve } = Promise.withResolvers<WaitWake>();
        this.edgeWaiters.set(execution.executionId, { resolve });
        return promise.then((wake) => wake.kind);
      },
      semaphore: this.spawnSemaphore(),
      trackSpawnRelease: (spawnId, release) => {
        this.spawnReleases.set(spawnId, release);
      },
      config: this.taskConfig(),
    };
  }

  // -------------------------------------------------------------------------
  // Child-run gate (M1.5 T17) — the omp reminder ladder / yield-supersession
  // chain. All state is journal-derived (tools/task/child-run.ts); this is
  // only the effectful edge: append the reminder turn, park, or settle.
  // -------------------------------------------------------------------------

  /**
   * Serialization for the gate: driveTurn finally, grandchild completion
   * callbacks and cold-start recovery can all fire concurrently; each
   * invocation re-reads the journal inside its chained turn (level-triggered,
   * the watchdog re-arm pattern), so a stale observation re-decides instead
   * of double-acting.
   */
  private childRunChain: Promise<void> = Promise.resolve();

  /**
   * Pre-call budget check for a live subagent turn (task semantics §4.1).
   * Cheap path first — the run's request tally from replay state; journal
   * I/O only on a threshold crossing. "stop" means the hard stop is armed
   * AND its single forced attempt already executed a yield call: the turn
   * ends and the child-run gate settles (usable yield → deliver; else
   * partial findings as the formal report).
   */
  private async checkRunBudget(turnId: string, turnInputId: string): Promise<"continue" | "stop"> {
    if (this.state.subagentIdentity === null) return "continue";
    const policy = this.childBudgetPolicy();
    if (policy === undefined) return "continue";
    const requests = this.state.modelCalls.size;
    const soft = policy.softRequestBudget;
    const hardExceeded = soft > 0 && requests >= budgetHardLimit(soft);
    const runtimeExceeded =
      policy.maxRuntimeMs > 0 &&
      this.state.identityCreatedAt !== null &&
      Date.now() - this.state.identityCreatedAt >= policy.maxRuntimeMs;

    const { events } = await this.readAllEvents();

    if (hardExceeded || runtimeExceeded) {
      // The ladder compresses into ONE forced terminal-yield attempt for
      // THIS turn: the reminder marker bound to the turn's inputId makes
      // translate pin tool_choice for the remaining calls of the turn.
      const armed = events.find(
        (event): event is Extract<AnyAgentEvent, { type: "task.yield_reminder" }> =>
          event.type === "task.yield_reminder" && event.data.reason === "budget",
      );
      if (armed === undefined) {
        await this.appendEvent("task.yield_reminder", {
          inputId: turnInputId,
          forced: true,
          reason: "budget",
        });
        return "continue";
      }
      const yieldedAfterArm = events.some(
        (event) =>
          event.type === "tool.call" && event.data.tool === "yield" && event.seq > armed.seq,
      );
      return yieldedAfterArm ? "stop" : "continue";
    }

    if (soft > 0 && requests >= soft) {
      const noticed = events.some((event) => event.type === "task.budget_notice");
      if (!noticed) {
        // Journal-first idempotency marker, then steer the wind-down notice
        // into the live turn (consumed at this iteration's call boundary).
        const inputId = `budget-notice-${crypto.randomUUID()}`;
        await this.appendEvent("task.budget_notice", { inputId });
        await this.appendEvent("turn.steer", {
          turnId,
          inputId,
          content: [{ type: "text", text: budgetNoticeText(soft, budgetHardLimit(soft)) }],
        });
      }
    }
    return "continue";
  }

  private advanceChildRun(): Promise<void> {
    const next = this.childRunChain.catch(() => undefined).then(() => this.advanceChildRunOnce());
    this.childRunChain = next;
    return next;
  }

  private async advanceChildRunOnce(): Promise<void> {
    if (this.state.subagentIdentity === null) return;
    // #276 J5 activity backflow runs on every gate pass (turn end, reminder,
    // settle, grandchild cascade) BEFORE any delivery — the parent journal
    // sees the child's activity before the settlement row. Cursor-folded and
    // parent-deduped, so repeated passes append nothing.
    await this.flushSubagentActivity();
    const active = this.activeTurn();
    if (active !== undefined && !turnTerminal(active)) return;
    const { events } = await this.readAllEvents();
    const verdict = childRunVerdict(projectChildRun(events), this.childBudgetPolicy());
    if (verdict.kind === "noop") return;
    if (verdict.kind === "remind") {
      // Reuse the interrupted marker's inputId (crash between marker append
      // and turn drive): sendMessage's I2 dedup makes the re-send a no-op if
      // the turn somehow did land.
      const inputId = verdict.reuseInputId ?? `yield-reminder-${crypto.randomUUID()}`;
      await this.appendEvent("task.yield_reminder", {
        inputId,
        forced: verdict.forced,
        reason: verdict.reason,
      });
      await this.sendMessage({
        clientRequestId: inputId,
        content: [{ type: "text", text: verdict.text }],
        mode: "start",
      });
      return;
    }
    if (verdict.kind === "notice") {
      // T18 soft-budget wind-down notice (task semantics §4.1): journaled
      // first (the fold's idempotency key), then its own turn — the gate
      // only runs with no live turn, so "start" is always the right mode.
      const inputId = `budget-notice-${crypto.randomUUID()}`;
      await this.appendEvent("task.budget_notice", { inputId });
      await this.sendMessage({
        clientRequestId: inputId,
        content: [{ type: "text", text: verdict.text }],
        mode: "start",
      });
      return;
    }
    // Settle. Freshness re-check first: a grandchild settlement may have
    // landed between the fold and here; a newly-stale yield must ladder, not
    // deliver (the completing callback's own kick is chained behind and will
    // run the ladder).
    const fresh = projectChildRun((await this.readAllEvents()).events);
    if (fresh.terminal !== undefined && fresh.stale) return;
    // Ladder exhaustion: inject the omp SYSTEM WARNING into the child
    // session BEFORE the failed settlement (docs/tools/task.md:186) — the
    // transcript keeps the warning even though no model call follows.
    if (verdict.output === NO_YIELD_WARNING && fresh.warning === undefined) {
      await this.appendEvent("task.yield_warning", { text: NO_YIELD_WARNING });
    }
    await this.writeChildArtifacts(fresh, verdict.output);
    const delivered = await this.deliverChildOutcome(verdict.status, verdict.output);
    if (delivered) {
      // Journal-first receipt: late arrivals after this row are T19
      // idle-follow-up material, never supersession fodder.
      await this.appendEvent("task.yield_completed", {
        status: verdict.status,
        output: verdict.output,
      });
    }
  }

  /**
   * #276 J5 child-side flush: derive this run's unreported activity/CoT
   * summaries from the journal (fold since the `task.subagent_flush`
   * cursor), land them on the parent as `task.subagent_event` rows, then
   * advance the cursor. Every failure mode degrades to "retry next pass":
   * an RPC failure leaves the cursor put (the fold re-derives), and a
   * pre-J1 identity (no anchor) flushes nothing — the parent would drop
   * unattributable rows anyway. Best-effort: the settlement channel
   * (deliverChildOutcome) stays authoritative and must never wait behind a
   * broken activity face.
   */
  private async flushSubagentActivity(): Promise<void> {
    const identity = this.state.subagentIdentity;
    if (identity?.parentToolCallId === undefined) return;
    const namespace = this.env.AGENT_DO;
    if (namespace === undefined) return;
    const { events } = await this.readAllEvents();
    const cursor = lastActivityFlushThroughSeq(events);
    const { units, throughSeq } = projectActivityFlush(
      events,
      cursor,
      this.taskConfig().inlineSummaryCapChars,
    );
    if (units.length === 0) return;
    const parent = namespace.get(
      namespace.idFromName(identity.parentThreadId),
    ) as unknown as SubagentDoStub;
    try {
      await parent.reportSubagentActivity({
        spawnId: identity.spawnId,
        agentId: identity.agentId,
        units,
      });
    } catch (error) {
      console.error(`subagent ${identity.agentId}: activity flush failed`, error);
      return;
    }
    await this.appendEvent("task.subagent_flush", { throughSeq });
  }

  /**
   * Child→parent terminal delivery (the T16 completeSpawnToParent body,
   * verdict-fed). Returns whether the parent accepted; delivery failures log
   * and return false so a later advance can retry (the parent dedups by
   * spawnId, and no receipt row is appended on failure).
   */
  private async deliverChildOutcome(status: "ok" | "error", output: string): Promise<boolean> {
    const identity = this.state.subagentIdentity;
    if (identity === null) return false;
    const namespace = this.env.AGENT_DO;
    if (namespace === undefined) {
      console.error(`subagent ${identity.agentId}: no AGENT_DO binding; completion not delivered`);
      return false;
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
      return true;
    } catch (error) {
      console.error(`subagent ${identity.agentId}: completion delivery failed`, error);
      return false;
    }
  }

  /**
   * The omp artifact family (docs/tools/task.md:89-94) written into THIS
   * child DO's storage before delivery: `<agentId>.md` full output,
   * `<agentId>.jsonl` session history, `<agentId>.json` structured sidecar —
   * the sidecar is written even when the payload failed schema validation
   * ("sidecar 无效 schema 也写", §3 T17 acceptance).
   */
  private async writeChildArtifacts(state: ChildRunState, output: string): Promise<void> {
    const identity = this.state.subagentIdentity;
    if (identity === null) return;
    const base = `agent/${identity.agentId}`;
    try {
      await this.ctx.storage.put(`${base}.md`, output);
      await this.ctx.storage.put(`${base}.jsonl`, renderJournalJsonl(state.events));
      if (state.terminal?.data !== undefined) {
        await this.ctx.storage.put(`${base}.json`, JSON.stringify(state.terminal.data, null, 2));
      }
    } catch (error) {
      // Artifacts are an availability surface, not the settlement channel —
      // delivery proceeds; the journal fold can re-derive on the next advance.
      console.error(`subagent ${identity.agentId}: artifact write failed`, error);
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

  /**
   * #351 dispatch resolution (the per-turn half of the providerId-keyed
   * relay registry). Order: an exact per-thread registration wins (test and
   * mocked rigs pin their provider — selection then resolves nowhere); a
   * journaled selection resolves through the registry the deploying worker
   * installed — fail-closed on catalog drift (RelaySelectionError surfaces
   * as a turn failure, never a silent re-route); no selection dispatches the
   * deployment default ("*") provider, the pre-#351 posture verbatim.
   */
  private resolveTurnProvider(turnId: string): ModelProvider {
    const runtime = getAgentRuntime(this.requireThread());
    const selection = this.state.turns.get(turnId)?.execution ?? null;
    if (selection !== null && runtime.resolveExecutionProvider !== undefined) {
      return runtime.resolveExecutionProvider(selection);
    }
    return runtime.provider;
  }

  /** Test/config seam: persist a watchdog config patch. */
  async configureWatchdog(
    patch: Record<string, number | boolean>,
  ): Promise<{ config: Record<string, number> }> {
    await this.ready();
    const merged = mergeWatchdogConfig(this.cfg, parseWatchdogConfigPatch(patch));
    this.cfg = merged;
    // T18 in-place semaphore resize (task/index.ts:639-643): applies to
    // already-queued spawns; unset instance defers to first-use config read.
    this.spawnSemaphoreInstance?.resize(merged.taskMaxConcurrency);
    // T19: a taskAgentIdleTtlMs patch re-derives the park deadline (a child
    // DO configured after its run settled must pick the new TTL up too).
    void this.refreshLifecycleAlarms();
    this.ctx.storage.kv.put(WATCHDOG_CONFIG_KV_KEY, JSON.stringify(patch));
    this.armWatchdog();
    return { config: merged as unknown as Record<string, number> };
  }
}
