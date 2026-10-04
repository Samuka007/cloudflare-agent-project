import type {
  DispatchOutcome,
  ExecutionUpdate,
  ToolDispatchRequest,
  ToolResultPayload,
} from "@cap/agent-do";
import { DurableObject } from "cloudflare:workers";
import {
  DAEMON_PROTOCOL_VERSION,
  DEFAULT_EXEC_TIMEOUT_MS,
  DISCONNECT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  LIVENESS_PROJECTION_INTERVAL_MS,
  LEASE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  RESULT_INLINE_LIMIT_BYTES,
  SPAWN_ACK_TIMEOUT_MS,
  SYNC_SPAWN_DEFER_TIMEOUT_MS,
} from "./constants.js";
import { DoOverloadError } from "./edge.js";
import { threadIdFromExecutionId } from "./execution-id.js";
import { markHostSeen } from "./hosts-registry.js";
import {
  emptyServiceState,
  foldOp,
  type ExecutionRecord,
  type JournalOp,
  type ReconcileAction,
  type ServiceStateData,
} from "./journal.js";
import {
  clientFrameSchema,
  type BootAnnounceReceived,
  type ExecExitedFrame,
  type ExecKilledAckFrame,
  type ExecOutputFrame,
  type ExecOutputGapFrame,
  type ExecSpawnAckFrame,
  type ExecStartedFrame,
  type KillListServiceFrame,
  observedFingerprint,
  type ServiceFrame,
  type ToolExitedFrame,
} from "./protocol.js";

/**
 * Daemon service DO — per-machine claim authority (unified-turn-state §1.2,
 * model two).
 *
 * Layers:
 * - RPC seam (packages/agent-do/src/daemon.ts): dispatch / kill / ackExecution
 *   / queryUnacked. The agent DO resolves this DO via its DAEMON_SERVICE
 *   namespace binding; the DO name is the machine identity.
 * - WS surface for the daemon client: hibernation API, boot.announce
 *   reconcile (§8.5 judgment tree), offset relay (§8.3), result delivery +
 *   forget closure (§8.4), lease lifecycle (§5).
 * - Alarm: single fallback timer — lease lapse → orphan_suspect, spawn-ack
 *   watchdog re-ask, execution-timeout kill forwarding (§2.5/§5.1).
 *
 * Ordering discipline: journal INSERT (transactionSync) → fold → side
 * effect. Nothing observable leaves this DO before it is durable (§0 rule 1).
 */

export interface DaemonServiceEnv {
  /** Agent-update sink; the integration worker binds the real AgentDO. */
  AGENT_DO: DurableObjectNamespace;
  /**
   * #62 hosts-registry D1 for the liveness projection (heartbeat →
   * last_seen_at; the port's markHostSeen). The composed deployment binds
   * the same control-plane database as the app's DB; standalone rigs omit
   * the binding and the projection skips. Optional for exactly that reason.
   */
  HOSTS_DB?: D1Database;
}

interface SocketAttachment {
  hostId: string;
  sessionId: string;
}

interface SpawnAckWaiter {
  resolve: (ack: { ok: boolean; error?: string }) => void;
  timer: TimerHandle;
}

interface SyncGateWaiter {
  resolve: (released: boolean) => void;
  timer: TimerHandle;
}

interface SpawnAck {
  ok: boolean;
  error?: string;
}

/** Handle returned by the ambient `setTimeout`: a bare `number` under the
 * Workers lib, `NodeJS.Timeout` under Node-types composed graphs — derived,
 * never pinned, so this file typechecks under both. */
type TimerHandle = ReturnType<typeof setTimeout>;

/** Storage key of the hostKey-hash mirror (#36 auth ladder authority). */
const HOST_KEY_MIRROR_KEY = "hostKeyMirror";

/** openSession contract (bb §2.1 step 1): lease params on success, the
 * frozen protocol-mismatch shape otherwise. Consumed by the worker front. */
export type OpenSessionResult =
  | { ok: true; sessionId: string; heartbeatIntervalMs: number; leaseTimeoutMs: number }
  | { ok: false; error: "protocol_version_mismatch" };

interface HostKeyMirrorEntry {
  keyHash: string;
  hostId: string;
  expiresAt: number;
}

export class DaemonServiceDO extends DurableObject<DaemonServiceEnv> {
  private state: ServiceStateData = emptyServiceState();
  private readyPromise: Promise<void> | null = null;
  /** In-flight spawn Q&A waiters (bb host-rpc requestId shape; §1.2: never persisted). */
  private readonly spawnWaiters = new Map<string, SpawnAckWaiter>();
  /** requestId → executionId; in-flight only, voided on session replace. */
  private readonly inflightRequests = new Map<string, string>();
  /** Dispatches parked by the syncing gate (I30). */
  private syncingWaiters: SyncGateWaiter[] = [];
  /** #36: DO-touch counter on the negotiation seam (edgeStats). */
  private edgeOpenSessionCalls = 0;
  /** #36: L1 fault injection — arms quota/overload-class failures (same
   * family as debugForceLeaseExpiry). Never set by production paths. */
  private debugOverload = false;

  constructor(ctx: DurableObjectState, env: DaemonServiceEnv) {
    super(ctx, env);
    // Append-only journal: the only persisted state (§0 rule 2). op_seq is
    // the replay order; execution_id is the audit-lookup index.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS journal_ops (
        op_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        execution_id TEXT,
        payload TEXT NOT NULL
      )`);
  }

  // -------------------------------------------------------------------------
  // Ready / replay (§0 rule 2: replay is truth).
  // -------------------------------------------------------------------------

  private async ready(): Promise<void> {
    this.readyPromise ??= this.replay();
    await this.readyPromise;
  }

  private async replay(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM journal_ops ORDER BY op_seq")
      .toArray();
    for (const row of rows) {
      foldOp(this.state, JSON.parse(row.payload) as JournalOp);
    }
    if (this.state.session !== null) {
      // Honest degradation (§1.2): the lease clock restarts after a DO
      // restart; a truly-gone client converges to the orphan path.
      this.state.session.leaseExpiresAt = Date.now() + LEASE_TIMEOUT_MS;
    }
    await this.scheduleNextAlarm();
  }

  // -------------------------------------------------------------------------
  // Journal write path (live writes and replay share `foldOp`).
  // -------------------------------------------------------------------------

  private journal(op: JournalOp): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO journal_ops (kind, execution_id, payload) VALUES (?, ?, ?)",
        op.kind,
        "executionId" in op ? op.executionId : null,
        JSON.stringify(op),
      );
    });
    foldOp(this.state, op);
  }

  // -------------------------------------------------------------------------
  // Agent-facing seam (packages/agent-do/src/daemon.ts contract).
  // -------------------------------------------------------------------------

  async dispatch(request: ToolDispatchRequest): Promise<DispatchOutcome> {
    await this.ready();
    const existing = this.state.executions.get(request.executionId);
    // Execution dedup point (§3.5/E): COMPLETED or acked tombstone is
    // answered from the journal — the client never spawns twice (I16).
    if (
      existing !== undefined &&
      (existing.state === "COMPLETED" || existing.state === "TOMBSTONE")
    ) {
      const result = existing.result ?? {
        status: "error",
        exitCode: null,
        output: existing.outputText,
      };
      return { kind: "completed_cached", result };
    }
    const session = this.state.session;
    if (session === null || this.liveSocket() === null || request.machineId !== session.hostId) {
      // Explicit, never a hang (§5.1). Mis-routed machineIds fail the same way.
      return { kind: "host_offline" };
    }
    if (session.syncing) {
      // I30: no spawn lands before reconcile completes. The announce round
      // trip resolves this in milliseconds; a stuck sync fails honestly.
      const released = await this.waitForSyncGate();
      const currentSession = this.state.session;
      if (!released || currentSession === null || this.liveSocket() === null) {
        return { kind: "host_offline" };
      }
    }
    // M1.5/T5' routing: bash keeps the M0 command projection (our PTY-less
    // executor — spike §4 verdict, not-worth); every other host tool rides
    // the embedded omp runtime on the client, relayed verbatim. The frame is
    // tool-agnostic here; unknown tool names are answered by the client host
    // with a structured error payload.
    if (request.tool !== "bash") {
      return this.dispatchTool(request);
    }
    const command = bashCommandOf(request.arguments);
    if (command === null) {
      // Caller contract violation (bash tool schema guarantees command):
      // persisted, explicit, never a silent no-op.
      this.journal({
        kind: "spawn_failed",
        at: Date.now(),
        executionId: request.executionId,
        error: "missing_command_argument",
      });
      return { kind: "host_offline" };
    }
    const current = this.state.executions.get(request.executionId);
    if (current?.state === "RUNNING" && current.spawnAcked) {
      // Re-attach (§3.5): the same boot already holds the process; its
      // stream continues. Zero additional spawn.
      return { kind: "accepted" };
    }
    const timeoutMs = request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_EXEC_TIMEOUT_MS;
    this.journal({
      kind: "dispatch",
      at: Date.now(),
      executionId: request.executionId,
      threadId: request.threadId,
      bootId: this.state.session?.bootId ?? "?",
      machineId: request.machineId,
      tool: null,
      argumentsJson: null,
      command,
      cwd: sandboxCwdOf(request.arguments),
      timeoutMs,
    });
    const ack = await this.forwardSpawn(request, command);
    if (!ack.ok) {
      this.journal({
        kind: "spawn_failed",
        at: Date.now(),
        executionId: request.executionId,
        error: ack.error ?? "spawn_refused",
      });
      return { kind: "host_offline" };
    }
    void this.scheduleNextAlarm();
    return { kind: "accepted" };
  }

  /**
   * Host-tool path (T5'): journal-first, forward tool.exec, settle on the
   * client's tool.exited. Same iron rules as the bash path: execution dedup
   * at the journal, spawn watchdog re-forward, timeout kill forward, and
   * results that only exist after journal persistence.
   */
  private async dispatchTool(request: ToolDispatchRequest): Promise<DispatchOutcome> {
    const current = this.state.executions.get(request.executionId);
    if (current?.state === "RUNNING" && current.spawnAcked) {
      // Re-attach (§3.5): the same boot already holds the live run; its
      // stream continues. Zero additional execution.
      return { kind: "accepted" };
    }
    const timeoutMs = request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_EXEC_TIMEOUT_MS;
    this.journal({
      kind: "dispatch",
      at: Date.now(),
      executionId: request.executionId,
      threadId: request.threadId,
      bootId: this.state.session?.bootId ?? "?",
      machineId: request.machineId,
      tool: request.tool,
      argumentsJson: JSON.stringify(request.arguments),
      command: "",
      cwd: ".",
      timeoutMs,
    });
    const ack = await this.forwardToolExec(request, timeoutMs);
    if (!ack.ok) {
      this.journal({
        kind: "spawn_failed",
        at: Date.now(),
        executionId: request.executionId,
        error: ack.error ?? "spawn_refused",
      });
      return { kind: "host_offline" };
    }
    void this.scheduleNextAlarm();
    return { kind: "accepted" };
  }

  async kill(executionId: string): Promise<void> {
    await this.ready();
    const record = this.state.executions.get(executionId);
    // Unknown executionId → no-op ack; terminal → no-op (§2.4).
    if (record?.state !== "RUNNING") return;
    this.journal({ kind: "cancel_requested", at: Date.now(), executionId });
    const socket = this.liveSocket();
    if (socket === null) return;
    const requestId = crypto.randomUUID();
    this.journal({ kind: "kill_forwarded", at: Date.now(), executionId, requestId });
    this.send(socket, {
      type: "exec.kill",
      requestId,
      threadId: threadIdFromExecutionId(executionId),
      executionId,
    });
  }

  async ackExecution(executionId: string, resultSeq: number): Promise<void> {
    await this.ready();
    const record = this.state.executions.get(executionId);
    if (record?.state !== "COMPLETED") return;
    // Claim/ack closure (§3.6/F): tombstone only after the agent DO has
    // durably appended the result — this call IS that promise (I21).
    this.journal({ kind: "ack", at: Date.now(), executionId, resultSeq });
    this.journal({ kind: "tombstone", at: Date.now(), executionId });
    const socket = this.liveSocket();
    if (socket !== null) {
      // §8.4 forget closure. Loss is survivable: the next announce re-reports
      // ended and forget is re-sent (I27).
      this.send(socket, {
        type: "exec.forget",
        threadId: threadIdFromExecutionId(executionId),
        executionId,
      });
    }
  }

  async queryUnacked(
    threadId: string,
  ): Promise<{ executionId: string; result: ToolResultPayload }[]> {
    await this.ready();
    const unacked: { executionId: string; result: ToolResultPayload }[] = [];
    for (const record of this.state.executions.values()) {
      if (record.threadId !== threadId) continue;
      if (record.state !== "COMPLETED" || record.result === null) continue;
      unacked.push({ executionId: record.executionId, result: record.result });
    }
    return unacked;
  }

  // -------------------------------------------------------------------------
  // Session open (bb §2.1 three-step handshake, step 1).
  // -------------------------------------------------------------------------

  async openSession(args: {
    hostId: string;
    protocolVersion: number;
    bootId: string;
  }): Promise<
    | { ok: true; sessionId: string; heartbeatIntervalMs: number; leaseTimeoutMs: number }
    | { ok: false; error: "protocol_version_mismatch" }
  > {
    this.edgeOpenSessionCalls += 1;
    await this.ready();
    if (this.debugOverload) throw new DoOverloadError();
    if (args.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      return { ok: false, error: "protocol_version_mismatch" };
    }
    const previous = this.state.session;
    if (previous !== null) {
      // 顶替 (§5.2.5): a second dial for the same host closes the old session
      // (close 1000 replaced) and voids its in-flight requestIds.
      this.journal({
        kind: "session_replaced",
        at: Date.now(),
        hostId: args.hostId,
        oldSessionId: previous.sessionId,
      });
      this.inflightRequests.clear();
      for (const waiter of this.spawnWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: false, error: "session_replaced" });
      }
      this.spawnWaiters.clear();
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = attachmentOf(socket);
        if (attachment?.sessionId === previous.sessionId) {
          try {
            socket.close(1000, "replaced");
          } catch {
            // already closing
          }
        }
      }
    }
    const sessionId = `sess_${crypto.randomUUID()}`;
    this.journal({
      kind: "session_opened",
      at: Date.now(),
      hostId: args.hostId,
      sessionId,
      bootId: args.bootId,
      previousBootId: previous?.bootId ?? null,
      protocolVersion: args.protocolVersion,
    });
    return {
      ok: true,
      sessionId,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      leaseTimeoutMs: LEASE_TIMEOUT_MS,
    };
  }

  /** Session validity check used by the worker's WS upgrade forward. */
  async sessionFor(hostId: string, sessionId: string): Promise<{ valid: boolean }> {
    await this.ready();
    const session = this.state.session;
    const valid = session !== null && session.hostId === hostId && session.sessionId === sessionId;
    return { valid };
  }

  // -------------------------------------------------------------------------
  // Edge auth seam (#36): the DO holds the authoritative key-hash mirror;
  // the front's KV is a cache. Enroll order: mirror write (authority) → KV
  // put (cache). Failure window: a failed KV put leaves auth on the one-DO
  // authCheck fallback, which backfills the cache on the next request.
  // -------------------------------------------------------------------------

  async mirrorHostKey(args: {
    keyHash: string;
    hostId: string;
    ttlMs: number;
  }): Promise<{ ok: true }> {
    const entry: HostKeyMirrorEntry = {
      keyHash: args.keyHash,
      hostId: args.hostId,
      expiresAt: Date.now() + args.ttlMs,
    };
    await this.ctx.storage.put(HOST_KEY_MIRROR_KEY, entry);
    return { ok: true };
  }

  async authCheck(args: { keyHash: string }): Promise<{ ok: boolean; hostId: string | null }> {
    const entry = await this.ctx.storage.get<HostKeyMirrorEntry>(HOST_KEY_MIRROR_KEY);
    if (entry === undefined || entry.expiresAt <= Date.now()) return { ok: false, hostId: null };
    if (entry.keyHash !== args.keyHash) return { ok: false, hostId: null };
    return { ok: true, hostId: entry.hostId };
  }

  /** DO-touch observability for the #36 request-budget tests. */
  edgeStats(): Promise<{ openSessionCalls: number }> {
    return Promise.resolve({ openSessionCalls: this.edgeOpenSessionCalls });
  }

  // -------------------------------------------------------------------------
  // WS surface (hibernation API).
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    await this.ready();
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
      return new Response("daemon-service DO: WS only", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const hostId = url.searchParams.get("hostId") ?? "";
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const session = this.state.session;
    const valid = session !== null && session.hostId === hostId && session.sessionId === sessionId;
    if (!valid) {
      // Attach-time validation failure (§8.5 step 1 shape): reject the
      // upgrade outright — bb closes 1008 post-upgrade, but a post-upgrade
      // close does not reliably reach the client on this platform, so the
      // gate degrades to an explicit 401 before any socket exists.
      return Response.json(
        {
          code: "invalid_session",
          message: "attach rejected: unknown or stale sessionId",
          retryable: false,
        },
        { status: 401 },
      );
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [sessionId]);
    pair[1].serializeAttachment({ hostId, sessionId } satisfies SocketAttachment);
    session.leaseExpiresAt = Date.now() + LEASE_TIMEOUT_MS;
    this.send(pair[1], {
      type: "session.ready",
      sessionId,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      leaseTimeoutMs: LEASE_TIMEOUT_MS,
    });
    void this.scheduleNextAlarm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready();
    if (typeof message !== "string") {
      ws.close(1008, "binary_frames_unsupported");
      return;
    }
    if (message.length > MAX_FRAME_BYTES) {
      ws.close(1008, "frame_too_large");
      return;
    }
    const attachment = attachmentOf(ws);
    const session = this.state.session;
    if (attachment === null || session === null) {
      ws.close(1008, "no_session");
      return;
    }
    if (attachment.sessionId !== session.sessionId) {
      // Stale-session frames are refused, never applied (§5.2.5, I17).
      this.journal({
        kind: "stale_session_rejected",
        at: Date.now(),
        hostId: attachment.hostId,
        sessionId: attachment.sessionId,
      });
      ws.close(1000, "stale_session");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      ws.close(1008, "bad_json");
      return;
    }
    const frame = clientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      ws.close(1008, "bad_frame");
      return;
    }
    // Any valid message renews the lease (bb semantics).
    session.leaseExpiresAt = Date.now() + LEASE_TIMEOUT_MS;
    switch (frame.data.type) {
      case "heartbeat":
        // #62: the heartbeat is the liveness carrier — project it into the
        // hosts registry so last_seen_at advances while the daemon lives
        // (bb heartbeatSession → markHostSeen, daemon-protocol.ts:129-136).
        await this.projectLiveness(session.hostId);
        return;
      case "boot.announce":
        await this.handleAnnounce(ws, frame.data);
        return;
      case "exec.started":
      case "exec.spawn_ack":
        this.handleSpawnAck(frame.data);
        return;
      case "exec.output":
        this.handleOutput(ws, frame.data);
        return;
      case "exec.output_gap":
        this.handleOutputGap(frame.data);
        return;
      case "exec.exited":
        await this.handleExited(frame.data);
        return;
      case "exec.killed_ack":
        this.handleKillReceipt(frame.data);
        return;
      case "tool.exited":
        await this.handleToolExited(frame.data);
        return;
    }
  }

  override webSocketClose(ws: WebSocket, _code: number, _reason: string, _clean: boolean): void {
    // Explicit-abort policy (§8.5): a closed socket only arms the grace
    // timer — never a kill, never an implicit drain. The client keeps
    // running and buffering; reconcile decides on reconnect.
    void this.armGraceAlarm();
    // bb closeSession stamps last_seen_at at close (sessions.ts:126); the
    // port stamps via the same throttled projection. Fire-and-forget: the
    // regular heartbeat already keeps the stamp within one window.
    const attachment = attachmentOf(ws);
    if (attachment !== null) {
      void this.projectLiveness(attachment.hostId);
    }
  }

  /**
   * #62 hosts-registry projection: best-effort by contract (the #49
   * bridge's shape) — a failed write only delays the stamp until the next
   * heartbeat; it never kills the session.
   */
  private async projectLiveness(hostId: string): Promise<void> {
    await this.ready();
    const db = this.env.HOSTS_DB;
    if (db === undefined) return;
    try {
      await markHostSeen(db, hostId, Date.now(), LIVENESS_PROJECTION_INTERVAL_MS);
    } catch (error) {
      console.error(`host liveness projection failed for ${hostId}:`, error);
    }
  }

  /**
   * #62 /hosts liveness seam — bb toHostStatus (entity-lookup.ts:71-80)
   * derives status read-time from the open daemon session (hub registration
   * + active session row); this DO holds both in the port (hibernated
   * sockets + journal session), so the hosts routes ask here: connected iff
   * a current session for the host still has a live socket.
   */
  async hostLiveness(args: { hostId: string }): Promise<{ connected: boolean }> {
    await this.ready();
    const session = this.state.session;
    return {
      connected: session !== null && session.hostId === args.hostId && this.liveSocket() !== null,
    };
  }

  /** Tighten the alarm to the disconnect-grace deadline (bb disconnect timer). */
  private async armGraceAlarm(): Promise<void> {
    const graceDeadline = Date.now() + DISCONNECT_GRACE_MS;
    const stored = await this.ctx.storage.getAlarm();
    if (stored !== null && stored <= graceDeadline) return;
    await this.ctx.storage.setAlarm(graceDeadline);
  }

  // -------------------------------------------------------------------------
  // boot.announce reconcile — §8.5 judgment tree (I28: exactly one action
  // per running-or-observed execution; no no-action, no double-action).
  // -------------------------------------------------------------------------

  private async handleAnnounce(ws: WebSocket, announce: BootAnnounceReceived): Promise<void> {
    const session = this.state.session;
    if (session === null) {
      ws.close(1008, "no_session");
      return;
    }
    // I23: generation is monotonic per session; stale announces rejected.
    if (announce.generation <= session.generation) {
      this.send(ws, {
        type: "error",
        code: "stale_generation",
        message: `announce generation ${announce.generation} <= accepted ${session.generation}`,
      });
      return;
    }
    const fingerprint = observedFingerprint(announce.observed);
    session.generation = announce.generation;
    session.lastFingerprint = fingerprint;

    // §8.5 step 4: compare the announce against the replaced session's boot
    // — null (machine's first session) can only be a clean/same-shaped pass.
    const sameBoot = session.previousBootId === null || announce.bootId === session.previousBootId;
    const actionsBefore = this.countReconcileActions();
    if (sameBoot) {
      await this.reconcileSameBoot(ws, announce, session);
    } else {
      await this.reconcileNewBoot(ws, announce, session);
    }
    if (this.countReconcileActions() === actionsBefore) {
      // §8.5 step 5: nothing in flight, nothing observed — a clean session.
      this.journalReconcileAction("__clean__", "clean");
    }
    this.send(ws, { type: "sync.complete", generation: announce.generation });
    // I30: parked spawns land only after the scene is known.
    this.releaseSyncWaiters();
    void this.scheduleNextAlarm();
  }

  /** §8.5 same-boot branch: mere disconnection — resume or backfill, no kills. */
  private reconcileSameBoot(
    ws: WebSocket,
    announce: BootAnnounceReceived,
    session: NonNullable<ServiceStateData["session"]>,
  ): Promise<void> {
    session.syncing = false;
    for (const record of this.runningOfBoot(session.bootId)) {
      if (record.orphanSuspect) {
        // §6.2: same-boot reconnect clears the orphan suspicion.
        this.journal({
          kind: "orphan_suspect_cleared",
          at: Date.now(),
          executionId: record.executionId,
        });
      }
      const observed = announce.observed.find((entry) => entry.executionId === record.executionId);
      if (observed === undefined) {
        // §8.5: same-boot process death without an ended report → 宁错杀不错认.
        this.journalOutcome(record.executionId, "outcome_unknown_direct");
        continue;
      }
      if (observed.state === "ended") {
        this.journalReconcileAction(record.executionId, "backfill");
        this.backfillEnded(record, observed);
        continue;
      }
      this.journalReconcileAction(record.executionId, "resume");
      this.send(ws, {
        type: "exec.resume",
        threadId: record.threadId,
        executionId: record.executionId,
        ackedOffset: record.lastOffset,
      });
    }
    // I27: an ended re-report for an already-settled execution means the
    // exec.forget was lost — re-send it; zero journal delta (§8.4).
    for (const entry of announce.observed) {
      if (entry.state !== "ended") continue;
      const record = this.state.executions.get(entry.executionId);
      if (record === undefined) continue;
      if (record.state !== "COMPLETED" && record.state !== "TOMBSTONE") continue;
      this.send(ws, {
        type: "exec.forget",
        threadId: record.threadId,
        executionId: record.executionId,
      });
    }
    return Promise.resolve();
  }

  /** §8.5 new-boot branch: client restarted — kill-list and/or direct UNKNOWN. */
  private reconcileNewBoot(
    ws: WebSocket,
    announce: BootAnnounceReceived,
    session: NonNullable<ServiceStateData["session"]>,
  ): Promise<void> {
    const observedByExecution = new Map<string, ObservedEntry>();
    for (const entry of announce.observed) observedByExecution.set(entry.executionId, entry);
    const oldRunning = [...this.state.executions.values()].filter(
      // The judgment baseline is the replaced session's boot (§8.5 tree):
      // RUNNING records owned by any boot other than the announcing one.
      (record) =>
        record.state === "RUNNING" && record.bootId !== null && record.bootId !== announce.bootId,
    );
    const oldRunningIds = new Set(oldRunning.map((record) => record.executionId));
    const killEntries: KillListServiceFrame["entries"] = [];

    for (const record of oldRunning) {
      const observed = observedByExecution.get(record.executionId);
      if (observed === undefined || observed.state === "ended") {
        // journal 有、observed 无 → died with the restart → direct UNKNOWN.
        this.journalOutcome(record.executionId, "outcome_unknown_direct");
        continue;
      }
      // journal ∩ observed running → kill-list entry; the UNKNOWN outcome is
      // journaled immediately (§5.2.3: no dependency on the receipt arriving).
      this.journalOutcome(record.executionId, "kill_list");
      killEntries.push({
        threadId: record.threadId,
        executionId: record.executionId,
        pid: observed.pid,
        pidStartedAt: observed.pidStartedAt,
      });
    }

    // I24: observed-only marker processes are unauthorized — the journal is
    // the sole authorization list. foldOp never materializes records from
    // reconcile_action rows, so the journal keeps no RUNNING record for them.
    for (const [executionId, observed] of observedByExecution) {
      if (observed.state !== "running") continue;
      if (oldRunningIds.has(executionId)) continue;
      if (this.state.executions.get(executionId) !== undefined) continue;
      this.journalReconcileAction(executionId, "kill_list");
      killEntries.push({
        threadId: threadIdFromExecutionId(executionId),
        executionId,
        pid: observed.pid,
        pidStartedAt: observed.pidStartedAt,
      });
    }

    session.bootId = announce.bootId;
    session.syncing = false;
    if (killEntries.length > 0) {
      this.send(ws, { type: "kill.list", requestId: crypto.randomUUID(), entries: killEntries });
    }
    return Promise.resolve();
  }

  /**
   * Same-boot ended backfill (§8.5/§8.4): when the journal already holds the
   * whole stream and the announce carries closure fields, settle immediately;
   * otherwise pull the buffered tail with a resume and let the client's own
   * exec.exited close the record.
   */
  private backfillEnded(record: ExecutionRecord, observed: ObservedEntry): void {
    const hasFullStream =
      observed.finalOffset !== undefined && observed.finalOffset <= record.lastOffset;
    const hasExit = observed.exitCode !== undefined && observed.exitCode !== null;
    if (!hasFullStream || !hasExit) {
      const socket = this.liveSocket();
      if (socket !== null) {
        this.send(socket, {
          type: "exec.resume",
          threadId: record.threadId,
          executionId: record.executionId,
          ackedOffset: record.lastOffset,
        });
      }
      return;
    }
    const exitCode = observed.exitCode ?? 0;
    this.journal({
      kind: "exited",
      at: Date.now(),
      executionId: record.executionId,
      status: exitCode === 0 ? "ok" : "error",
      exitCode,
      finalOffset: observed.finalOffset ?? record.lastOffset,
    });
    void this.forwardResultToAgent(record.executionId);
  }

  // -------------------------------------------------------------------------
  // Client frame handlers.
  // -------------------------------------------------------------------------

  private handleSpawnAck(frame: ExecStartedFrame | ExecSpawnAckFrame): void {
    const waiter = this.spawnWaiters.get(frame.requestId);
    if (waiter !== undefined) {
      this.spawnWaiters.delete(frame.requestId);
      clearTimeout(waiter.timer);
      if (frame.type === "exec.spawn_ack" && !frame.ok) {
        waiter.resolve({ ok: false, error: frame.error });
      } else {
        waiter.resolve({ ok: true });
      }
    }
    this.inflightRequests.delete(frame.requestId);
    const record = this.state.executions.get(frame.executionId);
    if (record?.state !== "RUNNING" || record.spawnAcked) return;
    if (record.tool !== null) {
      // Host-tool run accepted (T5'): no pid exists — journal the pid-0
      // sentinel (the same sentinel observedSnapshot uses for pid-less
      // entries) and open the started update; output/result follow via
      // exec.output / tool.exited.
      this.journal({
        kind: "spawn_ack",
        at: Date.now(),
        executionId: frame.executionId,
        pid: 0,
        pidStartedAt: 0,
      });
      void this.forwardToAgent({ kind: "started", executionId: frame.executionId });
      return;
    }
    if (frame.pid === undefined || frame.pidStartedAt === undefined) return;
    this.journal({
      kind: "spawn_ack",
      at: Date.now(),
      executionId: frame.executionId,
      pid: frame.pid,
      pidStartedAt: frame.pidStartedAt,
    });
    void this.forwardToAgent({
      kind: "started",
      executionId: frame.executionId,
      pid: frame.pid,
      pidStartedAt: frame.pidStartedAt,
    });
  }

  private handleOutput(ws: WebSocket, frame: ExecOutputFrame): void {
    const record = this.state.executions.get(frame.executionId);
    if (record?.state !== "RUNNING") return;
    const text = base64ToText(frame.bytesBase64);
    if (frame.offset < record.lastOffset) {
      // Overlap retransmit → dropped + journaled (I20).
      this.journal({
        kind: "output_dup_dropped",
        at: Date.now(),
        executionId: frame.executionId,
        offset: frame.offset,
      });
      return;
    }
    const unmarkedHoleStart = Math.max(record.lastOffset, record.gapTo);
    if (frame.offset > unmarkedHoleStart) {
      // Unexpected hole in the stream — never silently accepted (I26); a
      // client-DECLARED gap already covering the range is not re-marked.
      this.journal({
        kind: "output_gap",
        at: Date.now(),
        executionId: frame.executionId,
        from: unmarkedHoleStart,
        to: frame.offset,
      });
    }
    this.journal({
      kind: "output",
      at: Date.now(),
      executionId: frame.executionId,
      offset: frame.offset,
      text,
    });
    // The ack frontier is state (I25 monotonicity, I19 replay) — journal it
    // like every other fact before the frame leaves.
    this.journal({
      kind: "output_ack",
      at: Date.now(),
      executionId: frame.executionId,
      ackedOffset: record.lastOffset,
    });
    const ackedOffset = record.lastOffset;
    // Ack strictly after persistence (§8.3 先落盘后 ack); monotonic frontier
    // (I25) — the acked offset IS the journal frontier.
    this.send(ws, {
      type: "exec.output_ack",
      threadId: frame.threadId,
      executionId: frame.executionId,
      ackedOffset,
    });
    void this.forwardToAgent({
      kind: "output",
      executionId: frame.executionId,
      offset: frame.offset,
      chunk: text,
    });
  }

  private handleOutputGap(frame: ExecOutputGapFrame): void {
    const record = this.state.executions.get(frame.executionId);
    if (record?.state !== "RUNNING") return;
    // Client-declared ring eviction: explicit truncated marker over the gap
    // interval (§8.3, I26 — gaps are never silent).
    this.journal({
      kind: "output_gap",
      at: Date.now(),
      executionId: frame.executionId,
      from: frame.from,
      to: frame.to,
    });
  }

  private async handleExited(frame: ExecExitedFrame): Promise<void> {
    const record = this.state.executions.get(frame.executionId);
    if (record?.state !== "RUNNING") return;
    if (frame.finalOffset > record.lastOffset) {
      // Exit ahead of the byte frontier → honest truncated marker.
      this.journal({
        kind: "output_gap",
        at: Date.now(),
        executionId: frame.executionId,
        from: record.lastOffset,
        to: frame.finalOffset,
      });
    }
    const status = resultStatusFor(record, frame.reason ?? null, frame.exitCode);
    this.journal({
      kind: "exited",
      at: Date.now(),
      executionId: frame.executionId,
      status,
      exitCode: frame.exitCode,
      finalOffset: frame.finalOffset,
    });
    record.result = {
      status,
      exitCode: frame.exitCode,
      output: clampInlineOutput(record.outputText),
      ...(record.outputTruncated ? { outputTruncated: true } : {}),
    };
    await this.forwardResultToAgent(frame.executionId);
  }

  /**
   * Structured host-tool closure (T5'): the omp projection travels verbatim
   * (isError/timeout/truncation are payload facts, not exit-code derivations)
   * and is journaled inside the exited op so live state and replayed state
   * stay identical (§8.3 先落盘后 ack — the agent update leaves only after
   * persistence).
   */
  private async handleToolExited(frame: ToolExitedFrame): Promise<void> {
    const record = this.state.executions.get(frame.executionId);
    if (record?.state !== "RUNNING") return;
    this.journal({
      kind: "exited",
      at: Date.now(),
      executionId: frame.executionId,
      status: frame.result.status,
      exitCode: frame.result.exitCode,
      finalOffset: record.lastOffset,
      toolResult: {
        ...frame.result,
        output: clampInlineOutput(frame.result.output),
      },
    });
    await this.forwardResultToAgent(frame.executionId);
  }

  private handleKillReceipt(frame: ExecKilledAckFrame): void {
    // Audit-only: the UNKNOWN outcome was journaled at kill-list time, so a
    // client that dies again cannot stall closure (§5.2.3). The receipt just
    // records whether the pid+start-time verification passed (I22 shape).
    this.journal({
      kind: "kill_receipt",
      at: Date.now(),
      executionId: frame.executionId,
      verified: frame.verified,
    });
  }

  // -------------------------------------------------------------------------
  // Alarm (§2.5): lease lapse → orphan_suspect; spawn watchdog; timeout kill.
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    await this.ready();
    const now = Date.now();
    const session = this.state.session;
    let nextDeadline = Number.MAX_SAFE_INTEGER;

    if (session !== null) {
      const graceDeadline = session.leaseExpiresAt + DISCONNECT_GRACE_MS;
      if (now >= graceDeadline) {
        // §5.2.1: lease lapsed past grace → the boot's RUNNING set becomes
        // orphan_suspect. No kill from here — the client is unreachable; the
        // judgment tree resolves when (if) it returns.
        for (const record of this.runningOfBoot(session.bootId)) {
          if (record.orphanSuspect) continue;
          this.journal({ kind: "orphan_suspect", at: now, executionId: record.executionId });
          record.orphanSuspect = true;
        }
        session.leaseExpiresAt = now + LEASE_TIMEOUT_MS;
      }
      nextDeadline = Math.min(nextDeadline, session.leaseExpiresAt + DISCONNECT_GRACE_MS);
    }

    const socket = this.liveSocket();
    for (const record of this.state.executions.values()) {
      if (record.state !== "RUNNING") continue;
      if (!record.spawnAcked) {
        // Spawn watchdog (§5.1 COMMAND_TIMEOUT shape): re-ask the client with
        // the same executionId — idempotent against the client process table.
        if (socket !== null && !record.orphanSuspect) {
          const requestId = crypto.randomUUID();
          this.journal({
            kind: "spawn_forwarded",
            at: now,
            executionId: record.executionId,
            requestId,
          });
          if (record.tool !== null) {
            this.send(socket, {
              type: "tool.exec",
              requestId,
              threadId: record.threadId,
              executionId: record.executionId,
              tool: record.tool,
              arguments: JSON.parse(record.argumentsJson ?? "{}") as Record<string, unknown>,
              timeoutMs: record.timeoutMs,
            });
          } else {
            this.send(socket, {
              type: "exec.spawn",
              requestId,
              threadId: record.threadId,
              executionId: record.executionId,
              command: record.command,
              cwd: record.cwd,
              timeoutMs: record.timeoutMs,
            });
          }
        }
        nextDeadline = Math.min(nextDeadline, now + SPAWN_ACK_TIMEOUT_MS);
        continue;
      }
      const deadline = record.createdAt + record.timeoutMs;
      if (now >= deadline && !record.timeoutKillForwarded) {
        // Execution timeout (§5.1): policy owned by the agent DO, enforcement
        // here — forward exec.kill; the exit arrives with reason=timeout.
        record.timeoutKillForwarded = true;
        if (socket !== null) {
          const requestId = crypto.randomUUID();
          this.journal({
            kind: "kill_forwarded",
            at: now,
            executionId: record.executionId,
            requestId,
          });
          this.send(socket, {
            type: "exec.kill",
            requestId,
            threadId: record.threadId,
            executionId: record.executionId,
          });
        }
        nextDeadline = Math.min(nextDeadline, now + SPAWN_ACK_TIMEOUT_MS);
        continue;
      }
      nextDeadline = Math.min(nextDeadline, deadline + SPAWN_ACK_TIMEOUT_MS);
    }

    await this.setAlarmAt(nextDeadline);
  }

  private async scheduleNextAlarm(): Promise<void> {
    const stored = await this.ctx.storage.getAlarm();
    if (stored !== null) return; // §2.5: never blind-set over an existing alarm
    await this.setAlarmAt(Date.now() + LEASE_TIMEOUT_MS);
  }

  private async setAlarmAt(at: number): Promise<void> {
    if (!Number.isFinite(at) || at >= Number.MAX_SAFE_INTEGER) return;
    const stored = await this.ctx.storage.getAlarm();
    if (stored !== null && stored <= at) return;
    await this.ctx.storage.setAlarm(at);
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private forwardSpawn(request: ToolDispatchRequest, command: string): Promise<SpawnAck> {
    const socket = this.liveSocket();
    if (socket === null) return Promise.resolve({ ok: false, error: "no_socket" });
    const requestId = crypto.randomUUID();
    this.inflightRequests.set(requestId, request.executionId);
    this.journal({
      kind: "spawn_forwarded",
      at: Date.now(),
      executionId: request.executionId,
      requestId,
    });
    const { promise, resolve } = Promise.withResolvers<SpawnAck>();
    const timer = setTimeout(() => {
      this.spawnWaiters.delete(requestId);
      resolve({ ok: false, error: "spawn_ack_timeout" });
    }, SPAWN_ACK_TIMEOUT_MS);
    this.spawnWaiters.set(requestId, { resolve, timer });
    const timeoutMs = request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_EXEC_TIMEOUT_MS;
    this.send(socket, {
      type: "exec.spawn",
      requestId,
      threadId: request.threadId,
      executionId: request.executionId,
      command,
      cwd: sandboxCwdOf(request.arguments),
      timeoutMs,
    });
    return promise;
  }

  /** tool.exec relay — the tool-agnostic frame minus the machineId leg. */
  private forwardToolExec(request: ToolDispatchRequest, timeoutMs: number): Promise<SpawnAck> {
    const socket = this.liveSocket();
    if (socket === null) return Promise.resolve({ ok: false, error: "no_socket" });
    const requestId = crypto.randomUUID();
    this.inflightRequests.set(requestId, request.executionId);
    this.journal({
      kind: "spawn_forwarded",
      at: Date.now(),
      executionId: request.executionId,
      requestId,
    });
    const { promise, resolve } = Promise.withResolvers<SpawnAck>();
    const timer = setTimeout(() => {
      this.spawnWaiters.delete(requestId);
      resolve({ ok: false, error: "spawn_ack_timeout" });
    }, SPAWN_ACK_TIMEOUT_MS);
    this.spawnWaiters.set(requestId, { resolve, timer });
    this.send(socket, {
      type: "tool.exec",
      requestId,
      threadId: request.threadId,
      executionId: request.executionId,
      tool: request.tool,
      arguments: request.arguments,
      timeoutMs,
    });
    return promise;
  }

  private waitForSyncGate(): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      this.syncingWaiters = this.syncingWaiters.filter((entry) => entry.resolve !== resolve);
      resolve(false);
    }, SYNC_SPAWN_DEFER_TIMEOUT_MS);
    this.syncingWaiters.push({ resolve, timer });
    return promise;
  }

  private releaseSyncWaiters(): void {
    for (const waiter of this.syncingWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    this.syncingWaiters = [];
  }

  private liveSocket(): WebSocket | null {
    const session = this.state.session;
    if (session === null) return null;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (attachment?.sessionId === session.sessionId) return socket;
    }
    return null;
  }

  private send(socket: WebSocket, frame: ServiceFrame): void {
    socket.send(JSON.stringify(frame));
  }

  /**
   * UNKNOWN is a terminal, persisted outcome (§0 rule 4) — journaled once and
   * reported to the agent DO; the kill receipt never re-opens it.
   */
  private journalOutcome(
    executionId: string,
    action: Extract<ReconcileAction, "outcome_unknown_direct" | "kill_list">,
  ): void {
    this.journal({ kind: "outcome_unknown", at: Date.now(), executionId });
    this.journalReconcileAction(executionId, action);
    void this.forwardResultToAgent(executionId);
  }

  private journalReconcileAction(executionId: string, action: ReconcileAction): void {
    this.journal({
      kind: "reconcile_action",
      at: Date.now(),
      executionId,
      hostId: this.state.session?.hostId ?? "?",
      action,
    });
  }

  private runningOfBoot(bootId: string): ExecutionRecord[] {
    return [...this.state.executions.values()].filter(
      (record) => record.state === "RUNNING" && record.bootId === bootId,
    );
  }

  private countReconcileActions(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM journal_ops WHERE kind = 'reconcile_action'")
      .one().n;
  }

  private async forwardResultToAgent(executionId: string): Promise<void> {
    const record = this.state.executions.get(executionId);
    if (record?.result === null || record === undefined) return;
    await this.forwardToAgent({ kind: "exited", executionId, result: record.result });
  }

  /**
   * Journal-first already happened at every call site; delivery is
   * at-least-once, the agent DO dedups and re-acks (I21 recovery path).
   */
  private async forwardToAgent(update: ExecutionUpdate): Promise<void> {
    const sinkId = this.env.AGENT_DO.idFromName(threadIdFromExecutionId(update.executionId));
    // AGENT_DO is the real AgentDO in production, this package's test sink
    // in L1/smoke; both expose onExecutionUpdate.
    const stub = this.env.AGENT_DO.get(sinkId) as DurableObjectStub & {
      onExecutionUpdate(update: ExecutionUpdate): Promise<unknown>;
    };
    try {
      await stub.onExecutionUpdate(update);
    } catch (error) {
      // Survivable: the agent's watchdog re-asks via queryUnacked (§8.4).
      console.error(`agent update delivery failed for ${update.executionId}`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Observability RPCs (L1 tests + smoke).
  // -------------------------------------------------------------------------

  async journalOps(executionId?: string): Promise<(JournalOp & { opSeq: number })[]> {
    await this.ready();
    const rows =
      executionId === undefined
        ? this.ctx.storage.sql
            .exec<{ op_seq: number; payload: string }>(
              "SELECT op_seq, payload FROM journal_ops ORDER BY op_seq",
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<{ op_seq: number; payload: string }>(
              "SELECT op_seq, payload FROM journal_ops WHERE execution_id = ? ORDER BY op_seq",
              executionId,
            )
            .toArray();
    return rows.map((row) => ({
      ...(JSON.parse(row.payload) as JournalOp),
      opSeq: row.op_seq,
    }));
  }

  async executionView(executionId: string): Promise<{
    state: ExecutionRecord["state"] | "ABSENT";
    lastOffset: number;
    ackedOffset: number;
    bootId: string | null;
    pid: number | null;
    pidStartedAt: number | null;
    orphanSuspect: boolean;
    outputTruncated: boolean;
    result: ToolResultPayload | null;
  }> {
    await this.ready();
    const record = this.state.executions.get(executionId);
    if (record === undefined) {
      return {
        state: "ABSENT",
        lastOffset: 0,
        ackedOffset: 0,
        bootId: null,
        pid: null,
        pidStartedAt: null,
        orphanSuspect: false,
        outputTruncated: false,
        result: null,
      };
    }
    return {
      state: record.state,
      lastOffset: record.lastOffset,
      ackedOffset: record.ackedOffset,
      bootId: record.bootId,
      pid: record.pid,
      pidStartedAt: record.pidStartedAt,
      orphanSuspect: record.orphanSuspect,
      outputTruncated: record.outputTruncated,
      result: record.result,
    };
  }

  async sessionView(): Promise<{
    hostId: string;
    sessionId: string;
    bootId: string;
    generation: number;
    syncing: boolean;
  } | null> {
    await this.ready();
    const session = this.state.session;
    if (session === null) return null;
    return {
      hostId: session.hostId,
      sessionId: session.sessionId,
      bootId: session.bootId,
      generation: session.generation,
      syncing: session.syncing,
    };
  }

  /** L1/seam tests re-point the record at an injected spawn clock. */
  async debugForceLeaseExpiry(): Promise<void> {
    await this.ready();
    const session = this.state.session;
    if (session === null) return;
    session.leaseExpiresAt = Date.now() - DISCONNECT_GRACE_MS - 1;
    await this.ctx.storage.deleteAlarm();
    await this.alarm();
  }

  /** L1 (#36): arm/disarm the quota/overload fault the edge classifiers key on. */
  debugSetOverload(on: boolean): Promise<void> {
    this.debugOverload = on;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Frame-level helpers (module scope: pure, no DO state).
// ---------------------------------------------------------------------------

type ObservedEntry = BootAnnounceReceived["observed"][number];

function attachmentOf(socket: WebSocket): SocketAttachment | null {
  try {
    return socket.deserializeAttachment() as SocketAttachment | null;
  } catch {
    return null;
  }
}

function base64ToText(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function clampInlineOutput(text: string): string {
  if (text.length <= RESULT_INLINE_LIMIT_BYTES) return text;
  return text.slice(0, RESULT_INLINE_LIMIT_BYTES);
}

function resultStatusFor(
  record: ExecutionRecord,
  reason: "timeout" | null,
  exitCode: number | null,
): ToolResultPayload["status"] {
  if (record.cancelRequested) return "cancelled";
  if (reason === "timeout" || record.timeoutKillForwarded) return "timeout";
  if (exitCode === 0) return "ok";
  return "error";
}

function sandboxCwdOf(args: Record<string, unknown>): string {
  const cwd = args.cwd;
  return typeof cwd === "string" ? cwd : ".";
}

function bashCommandOf(args: Record<string, unknown>): string | null {
  const command = args.command;
  return typeof command === "string" && command.length > 0 ? command : null;
}
