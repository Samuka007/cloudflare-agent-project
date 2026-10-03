import { DurableObject } from "cloudflare:workers";
import { Cause, Effect, Exit } from "effect";
import {
  threadEventsAppendedMessage,
  realtimeClientMessageSchema,
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
  type TurnRuntime,
} from "./turn-state.js";
import type {
  AgentEventDataByType,
  AgentEventRecord,
  AgentEventType,
} from "./fsm-events.js";
import type { ToolResultStatus } from "./fsm-events.js";
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
import {
  ModelProviderError,
  type ModelRequest,
  type ModelStreamChunk,
} from "./provider.js";
import { projectToUxEvents } from "./ux-projection.js";
import { getAgentRuntime } from "./injection.js";

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
}

export class AgentRpcError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "conflict"
      | "invalid"
      | "wrong_thread"
      | "no_runtime",
    message: string,
  ) {
    super(message);
    this.name = "AgentRpcError";
  }
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
  content: Array<{ type: "text"; text: string }>;
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
      toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
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
    Array<{ turnId: string; wake: (forced: boolean) => void }>
  >();

  constructor(ctx: DurableObjectState, env: AgentDoBindings) {
    super(ctx, env);
    this.cfg = decodeWatchdogConfig(
      env.AGENT_DO_WATCHDOG,
      DEFAULT_WATCHDOG_CONFIG,
    );
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
    const wantSteer =
      request.mode === "steer" || (request.mode === "auto" && active !== undefined);
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

  override async fetch(request: Request): Promise<Response> {
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
      parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
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
      throw new AgentRpcError("wrong_thread", `subscription targets foreign thread ${target.threadId}`);
    }
    ws.send(JSON.stringify({ type: clientMessage.data.type, target }));
  }

  override webSocketClose(_ws: WebSocket, _code: number, _reason: string, _clean: boolean): void {}

  // -------------------------------------------------------------------------
  // Alarm watchdog (§2.5): single alarm, deadline table recomputed from state
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    try {
      await this.ready();
      const now = Date.now();
      const due = computeDueWork(this.state, this.cfg, now);
      for (const modelCallId of due.sealedModelCallIds) {
        await this.sealModelCall(modelCallId);
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
      await this.ctx.storage.setAlarm(Date.now() + 1_000).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Recovery (cold start) — the only place the log is read back wholesale
  // -------------------------------------------------------------------------

  private loadState(): ReplayState {
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; id: string; thread_id: string; type: string; data: string; created_at: number }>(
        "SELECT seq, id, thread_id, type, data, created_at FROM events ORDER BY seq",
      )
      .toArray();
    const events = rows.map((row) =>
      parseAgentEvent({
        id: row.id,
        threadId: row.thread_id,
        seq: Number(row.seq),
        type: row.type,
        data: JSON.parse(row.data),
        createdAt: Number(row.created_at),
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
    const persistedCfgRaw = await this.ctx.storage.kv.get<string>(WATCHDOG_CONFIG_KV_KEY);
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
    const record = (await this.log.append(
      this.threadId,
      type,
      data,
      createdAt,
    )) as AgentEventRecord<TType>;
    // Shape was schema-validated inside the log; widen to the union.
    const validated: AnyAgentEvent = record as unknown as AnyAgentEvent;
    applyEvent(this.state, validated);
    this.knownEventCount += 1;
    this.pushToSubscribers();
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
        const pendingSteers = turn.steerSeqs.filter(
          (seq) => !turn.consumedSteerSeqs.includes(seq),
        );
        const started = yield* Effect.promise(() =>
          self.appendEvent("model.call_started", {
            turnId,
            consumedSteerSeqs: pendingSteers,
          }),
        );
        const outcome: ModelCallOutcome = yield* self.consumeModelCall(
          turnId,
          started.seq,
          signal,
        );
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
          executionIds.push(executionIdFor(self.threadId as string, record.seq));
        }
        yield* Effect.forEach(executionIds, (executionId) => Effect.promise(() => self.dispatchExecution(turnId, executionId)), {
          concurrency: "unbounded",
          discard: true,
        });
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
        const provider = getAgentRuntime(self.threadId as string).provider;
        const request = self.buildModelRequest(turnId, modelCallId);
          const iterator = provider.streamTurn(request, {
            signal: combined,
          })[Symbol.asyncIterator]();
          const pull: Effect.Effect<IteratorResult<ModelStreamChunk>, ProviderPullFailure> =
            Effect.callback((resume) => {
            void iterator.next().then(
              (result) => resume(Effect.succeed(result)),
                (error: unknown) => resume(Effect.fail(new ProviderPullFailure(error))),
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
      typeof error === "object" && error !== null && "_tag" in error && error._tag === "TimeoutError";
    if (isCap && !signal.aborted) {
      callAbort.abort();
      await this.appendEvent("model.call_sealed", {
        turnId,
        modelCallId,
        prefixChars: new TextEncoder().encode(text).byteLength,
      });
      return { kind: "sealed", modelCallId };
    }
    const pullFailure =
      error instanceof ProviderPullFailure ? error.error : error;
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

  private buildModelRequest(turnId: string, modelCallId: number): ModelRequest {
    const turn = this.state.turns.get(turnId);
    if (turn === undefined) throw new AgentRpcError("not_found", `unknown turn ${turnId}`);
    const inputText = this.inputTextOf(turn);
    const steers = turn.steerSeqs
      .filter((seq) => !turn.consumedSteerSeqs.includes(seq))
      .map((seq) => ({ seq, text: this.steerTextOf(turn.turnId, seq) }));
    const priorAssistantText = this.assistantTextOf(turn);
    const toolResults: Array<{
      executionId: string;
      tool: string;
      status: "ok" | "error" | "timeout" | "cancelled" | "outcome_unknown";
      output: string;
    }> = [];
    for (const executionId of turn.executionIds) {
      const execution = this.state.executions.get(executionId);
      if (execution === undefined || !executionTerminal(execution)) continue;
      const status: ToolResultStatus =
        execution.status === "ok"
          ? "ok"
          : execution.status === "error"
            ? "error"
            : execution.status === "timeout"
              ? "timeout"
              : execution.status === "cancelled"
                ? "cancelled"
                : "outcome_unknown";
      toolResults.push({
        executionId,
        tool: this.toolNameOf(execution.callSeq),
        status,
        output: this.toolOutputOf(execution),
      });
    }
    return {
      threadId: this.threadId as string,
      turnId,
      modelCallId,
      input: inputText,
      steers,
      priorAssistantText,
      toolResults,
    };
  }

  private eventData(seq: number): AnyAgentEvent | null {
    if (this.threadId === null) return null;
    const row = this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM events WHERE thread_id = ? AND seq = ?", this.threadId, seq)
      .one();
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
    const row = this.ctx.storage.sql
      .exec<{ type: string }>("SELECT type FROM events WHERE thread_id = ? AND seq = ?", this.threadId, seq)
      .one();
    return row?.type ?? "";
  }

  private inputTextOf(turn: { inputSeq: number }): string {
    const data = this.eventData(turn.inputSeq);
    if (data === null || data.type !== "turn.input") return "";
    const content = data.data.content;
    return content.map((part) => part.text ?? "").join("\n");
  }

  private steerTextOf(_turnId: string, seq: number): string {
    const data = this.eventData(seq);
    if (data === null || data.type !== "turn.steer") return "";
    const content = data.data.content;
    return content.map((part) => part.text ?? "").join("\n");
  }

  private assistantTextOf(turn: TurnRuntime): string {
    const rows = this.ctx.storage.sql
      .exec<{ data: string }>(
        "SELECT data FROM events WHERE thread_id = ? AND seq > ? AND type = 'model.delta'",
        this.threadId,
        turn.inputSeq,
      )
      .toArray();
    let text = "";
    for (const row of rows) {
      const parsed = JSON.parse(row.data) as { modelCallId: unknown; text: unknown };
      if (typeof parsed.modelCallId !== "number") continue;
      if (!turn.modelCallIds.includes(parsed.modelCallId)) continue;
      if (typeof parsed.text === "string") text += parsed.text;
    }
    return text;
  }

  private toolNameOf(callSeq: number): string {
    const data = this.eventData(callSeq);
    if (data === null || data.type !== "tool.call") return "unknown";
    return data.data.tool;
  }

  private toolOutputOf(execution: ExecutionRuntime): string {
    if (execution.resultSeq === null) return "";
    const data = this.eventData(execution.resultSeq);
    if (data === null || data.type !== "tool.result") return "";
    return typeof data.data.output === "string" ? data.data.output : "";
  }

  // -------------------------------------------------------------------------
  // Tool dispatch + result ingest
  // -------------------------------------------------------------------------

  private daemon(): DaemonServiceClient {
    const namespace = this.env.DAEMON_SERVICE;
    if (namespace !== undefined && this.threadId !== null) {
      // Binding-shaped stub; the interface is the seam contract (#30).
      return namespace.get(namespace.idFromName(this.threadId)) as unknown as DaemonServiceClient;
    }
    const registered = getAgentRuntime(this.threadId as string).daemon;
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
    const callData = this.eventData(execution.callSeq);
    let outcome: DispatchOutcome;
    try {
      outcome = await this.daemon().dispatch({
        threadId: this.threadId as string,
        turnId,
        executionId,
        machineId: this.state.machineId ?? "local",
        tool: callData?.type === "tool.call" ? callData.data.tool : "unknown",
        arguments:
          callData?.type === "tool.call" ? callData.data.arguments : {},
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

  /** Persist the terminal result, then (and only then) ack the service (I21). */
  private async ingestResult(
    execution: ExecutionRuntime,
    result: ToolResultPayload,
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
    try {
      await this.daemon().ackExecution(execution.executionId, record.seq);
    } catch {
      // Ack loss is survivable: the service keeps the result until a later
      // re-ack (duplicate delivery re-acks — I21 recovery path).
    }
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
      wake: (_forced: boolean) => check(),
    }));
    for (let i = 0; i < executionIds.length; i++) {
      const executionId = executionIds[i];
      const waiter = waiters[i];
      if (executionId === undefined || waiter === undefined) continue;
      const existing = this.execWaiters.get(executionId) ?? [];
      existing.push(waiter);
      this.execWaiters.set(executionId, existing);
    }
    const onAbort = () => check();
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
      try {
        await this.daemon().kill(executionId);
      } catch {
        // Ruling I: kill is at-least-once; recovery re-sends after eviction.
      }
    }
  }

  private async finalizeCancel(turnId: string): Promise<void> {
    const turn = this.state.turns.get(turnId);
    if (turn === undefined || turn.status !== "cancelling") return;
    await this.killNonTerminalExecutions(turnId);
    for (;;) {
      const pending = turn.executionIds.filter((id) => {
        const execution = this.state.executions.get(id);
        return execution === undefined || !executionTerminal(execution);
      });
      if (pending.length === 0) break;
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        for (const id of pending) {
          const waiters = this.execWaiters.get(id);
          if (waiters === undefined) continue;
          for (const waiter of [...waiters]) {
            if (waiter.turnId !== turnId) continue;
            waiter.wake(false);
          }
        }
        resolve();
      }, 250);
      const check = () => {
        const stillPending = pending.filter((id) => {
          const execution = this.state.executions.get(id);
          return execution === undefined || !executionTerminal(execution);
        });
        if (stillPending.length === 0) {
          clearTimeout(timer);
          resolve();
        }
      };
      for (const id of pending) {
        const existing = this.execWaiters.get(id) ?? [];
        existing.push({ turnId, wake: () => check() });
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
    if (call === undefined || call.status !== "running") return;
    const turn = this.state.turns.get(call.turnId);
    await this.appendEvent("model.call_sealed", {
      turnId: call.turnId,
      modelCallId,
      prefixChars: call.deltaChars,
    });
    if (turn !== undefined && turn.status === "cancelling") {
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
    const due = computeDueWork(this.state, this.cfg, Date.now());
    if (due.nextDeadlineAt !== null) {
      void this.ctx.storage.setAlarm(due.nextDeadlineAt);
    } else {
      void this.ctx.storage.deleteAlarm().catch(() => {});
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
  async configureWatchdog(patch: Record<string, number>): Promise<{ config: Record<string, number> }> {
    await this.ready();
    const merged = mergeWatchdogConfig(this.cfg, parseWatchdogConfigPatch(patch));
    this.cfg = merged;
    await this.ctx.storage.kv.put(WATCHDOG_CONFIG_KV_KEY, JSON.stringify(patch));
    this.armWatchdog();
    return { config: merged as unknown as Record<string, number> };
  }
}
