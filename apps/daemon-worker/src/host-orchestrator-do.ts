import { DurableObject } from "cloudflare:workers";
import { newId } from "@cap/protocol";
import {
  DAEMON_DISCONNECT_GRACE_MS,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_WS_SUBPROTOCOL,
  COMMAND_TIMEOUT_MS,
} from "./constants.js";
import {
  getMachineDispatcher,
  getProviderAdapter,
} from "./injection.js";
import type {
  AdapterCommand,
  AdapterCommandOutcome,
  AdapterCommandType,
} from "./provider-adapter.js";
import {
  daemonServerMessageSchema,
  type DaemonServerMessage,
  type DaemonSessionCloseReason,
  type HostDaemonSessionOpenRequest,
} from "./session-contract.js";
import {
  executionIdFor,
  type MachineCommandDispatchOutcome,
} from "./seam/machine-dispatch.js";
import {
  WatchSetAggregator,
  type WatchSetApplyArgs,
  type DaemonWatchSet,
} from "./watch-set.js";

/**
 * Per-host orchestration DO (#27): the bb daemon's orchestration half as one
 * durable object — `host_daemon_sessions` mirror (replace-on-reopen, lease/
 * heartbeat, disconnect grace), `host_daemon_commands`/`_attempts` journal
 * with audit semantics, and the watch-set generation+fingerprint machine.
 *
 * bb lineage (all @ 8473d8c33): sessions.ts openSession/closeSession/
 * heartbeatSession; internal/session.ts open handler (protocol strict-equal);
 * ws/daemon-protocol.ts lease renewal formula; internal/
 * session-owner-side-effects.ts disconnect grace; ws/watch-interests.ts
 * aggregation; db/drizzle 0000/0010 command+attempt audit tables.
 */

// ---------------------------------------------------------------------------
// Storage schema (versioned migrations, agent-do event-log pattern).
// ---------------------------------------------------------------------------

const MIGRATIONS: readonly {
  version: number;
  name: string;
  statements: readonly string[];
}[] = [
  {
    version: 1,
    name: "daemon-worker-orchestrator",
    statements: [
      `CREATE TABLE IF NOT EXISTS orchestrator_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS host_daemon_sessions (
         id TEXT PRIMARY KEY,
         host_id TEXT NOT NULL,
         instance_id TEXT NOT NULL,
         host_name TEXT NOT NULL,
         host_type TEXT NOT NULL,
         data_dir TEXT NOT NULL,
         platform TEXT NOT NULL,
         protocol_version INTEGER NOT NULL,
         heartbeat_interval_ms INTEGER NOT NULL,
         lease_timeout_ms INTEGER NOT NULL,
         status TEXT NOT NULL,
         lease_expires_at INTEGER NOT NULL,
         closed_at INTEGER,
         close_reason TEXT,
         socket_attached INTEGER NOT NULL DEFAULT 0,
         active_thread_ids TEXT NOT NULL DEFAULT '[]',
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS host_daemon_sessions_host_status_idx
         ON host_daemon_sessions (host_id, status)`,
      `CREATE TABLE IF NOT EXISTS host_daemon_commands (
         id TEXT PRIMARY KEY,
         host_id TEXT NOT NULL,
         session_id TEXT,
         cursor INTEGER NOT NULL,
         type TEXT NOT NULL,
         thread_id TEXT,
         payload TEXT NOT NULL,
         state TEXT NOT NULL,
         retry_count INTEGER NOT NULL DEFAULT 0,
         result_payload TEXT,
         created_at INTEGER NOT NULL,
         fetched_at INTEGER,
         completed_at INTEGER
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS host_daemon_commands_host_cursor_idx
         ON host_daemon_commands (host_id, cursor)`,
      `CREATE INDEX IF NOT EXISTS host_daemon_commands_host_state_cursor_idx
         ON host_daemon_commands (host_id, state, cursor)`,
      `CREATE TABLE IF NOT EXISTS host_daemon_command_attempts (
         id TEXT PRIMARY KEY,
         command_id TEXT NOT NULL,
         session_id TEXT,
         status TEXT NOT NULL,
         delivered_at INTEGER NOT NULL,
         lease_expires_at INTEGER NOT NULL,
         settled_at INTEGER
       )`,
      `CREATE INDEX IF NOT EXISTS host_daemon_command_attempts_command_status_idx
         ON host_daemon_command_attempts (command_id, status)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS host_daemon_command_attempts_active_command_idx
         ON host_daemon_command_attempts (command_id) WHERE status = 'active'`,
      `CREATE TABLE IF NOT EXISTS pending_disconnect_grace (
         session_id TEXT PRIMARY KEY,
         host_id TEXT NOT NULL,
         deadline_at INTEGER NOT NULL,
         completed_at INTEGER
       )`,
      `CREATE TABLE IF NOT EXISTS disconnect_dispositions (
         session_id TEXT PRIMARY KEY,
         host_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         completed_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS daemon_outbox (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         payload TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS orchestrator_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    ],
  },
];

// ---------------------------------------------------------------------------
// Row + outcome types.
// ---------------------------------------------------------------------------

export interface HostDaemonSessionRow {
  id: string;
  hostId: string;
  instanceId: string;
  hostName: string;
  hostType: string;
  dataDir: string;
  platform: string;
  protocolVersion: number;
  heartbeatIntervalMs: number;
  leaseTimeoutMs: number;
  status: "active" | "closed";
  leaseExpiresAt: number;
  closedAt: number | null;
  closeReason: DaemonSessionCloseReason | null;
  socketAttached: boolean;
  activeThreadIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface HostDaemonCommandRow {
  id: string;
  hostId: string;
  sessionId: string | null;
  cursor: number;
  type: AdapterCommandType;
  threadId: string | null;
  payload: unknown;
  state: "pending" | "fetched" | "completed" | "failed";
  retryCount: number;
  resultPayload: AdapterCommandOutcome | null;
  createdAt: number;
  fetchedAt: number | null;
  completedAt: number | null;
}

export interface HostDaemonCommandAttemptRow {
  id: string;
  commandId: string;
  sessionId: string | null;
  status: "active" | "ok" | "failed" | "timeout";
  deliveredAt: number;
  leaseExpiresAt: number;
  settledAt: number | null;
}

export type DisconnectDisposition = {
  sessionId: string;
  hostId: string;
  kind: "daemon-disconnect-grace-completed";
  completedAt: number;
};

export type SessionOpenOutcome =
  | {
      kind: "opened";
      session: HostDaemonSessionRow;
      previousSessionId: string | null;
      /**
       * bb handleHostSessionOpened replace dispositions: `socket-only` closes
       * just the superseded socket (same daemon instance — sending
       * session-close would make it tear down every resident runtime);
       * `session-close` notifies the old socket so a different instance
       * stops its runtimes.
       */
      replacedDisposition: "socket-only" | "session-close" | null;
      /** bb session/open response watchSet (reconcile, no generation bump). */
      watchSet: DaemonWatchSet;
    }
  | {
      kind: "protocol_version_mismatch";
      details: { serverProtocolVersion: number; rejectedProtocolVersion: number };
    };

export type SocketAttachOutcome =
  | { kind: "attached"; session: HostDaemonSessionRow }
  | { kind: "rejected"; closeCode: 1008; reason: string };

export type DaemonMessageReceipt =
  | { kind: "renewed"; leaseExpiresAt: number }
  | { kind: "inactive" };

export type CommandDispatchOutcome =
  | { kind: "settled"; outcome: AdapterCommandOutcome; attemptId: string }
  | { kind: "stale_settlement"; attemptId: string }
  | { kind: "accepted_async"; attemptId: string }
  | { kind: "not_dispatchable"; state: HostDaemonCommandRow["state"] }
  | { kind: "unknown_command" };

export type CommandSettleOutcome =
  | { kind: "accepted" }
  | { kind: "rejected"; reason: "attempt-terminal" | "command-terminal" | "unknown" };

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// Type aliases (not interfaces) so they satisfy the SqlStorage exec
// Record<string, SqlStorageValue> constraint via implicit index signatures.
type SessionRowSql = {
  id: string;
  host_id: string;
  instance_id: string;
  host_name: string;
  host_type: string;
  data_dir: string;
  platform: string;
  protocol_version: number;
  heartbeat_interval_ms: number;
  lease_timeout_ms: number;
  status: string;
  lease_expires_at: number;
  closed_at: number | null;
  close_reason: string | null;
  socket_attached: number;
  active_thread_ids: string;
  created_at: number;
  updated_at: number;
};

function sessionFromSql(row: SessionRowSql): HostDaemonSessionRow {
  return {
    id: row.id,
    hostId: row.host_id,
    instanceId: row.instance_id,
    hostName: row.host_name,
    hostType: row.host_type,
    dataDir: row.data_dir,
    platform: row.platform,
    protocolVersion: Number(row.protocol_version),
    heartbeatIntervalMs: Number(row.heartbeat_interval_ms),
    leaseTimeoutMs: Number(row.lease_timeout_ms),
    status: row.status as HostDaemonSessionRow["status"],
    leaseExpiresAt: Number(row.lease_expires_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
    closeReason: (row.close_reason ?? null) as HostDaemonSessionRow["closeReason"],
    socketAttached: Number(row.socket_attached) === 1,
    activeThreadIds: JSON.parse(row.active_thread_ids) as string[],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

type CommandRowSql = {
  id: string;
  host_id: string;
  session_id: string | null;
  cursor: number;
  type: string;
  thread_id: string | null;
  payload: string;
  state: string;
  retry_count: number;
  result_payload: string | null;
  created_at: number;
  fetched_at: number | null;
  completed_at: number | null;
};

function commandFromSql(row: CommandRowSql): HostDaemonCommandRow {
  return {
    id: row.id,
    hostId: row.host_id,
    sessionId: row.session_id,
    cursor: Number(row.cursor),
    type: row.type as HostDaemonCommandRow["type"],
    threadId: row.thread_id,
    payload: JSON.parse(row.payload) as unknown,
    state: row.state as HostDaemonCommandRow["state"],
    retryCount: Number(row.retry_count),
    resultPayload:
      row.result_payload === null
        ? null
        : (JSON.parse(row.result_payload) as AdapterCommandOutcome),
    createdAt: Number(row.created_at),
    fetchedAt: row.fetched_at === null ? null : Number(row.fetched_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

type AttemptRowSql = {
  id: string;
  command_id: string;
  session_id: string | null;
  status: string;
  delivered_at: number;
  lease_expires_at: number;
  settled_at: number | null;
};

function attemptFromSql(row: AttemptRowSql): HostDaemonCommandAttemptRow {
  return {
    id: row.id,
    commandId: row.command_id,
    sessionId: row.session_id,
    status: row.status as HostDaemonCommandAttemptRow["status"],
    deliveredAt: Number(row.delivered_at),
    leaseExpiresAt: Number(row.lease_expires_at),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
  };
}

// ---------------------------------------------------------------------------
// The DO.
// ---------------------------------------------------------------------------

export class HostOrchestratorDO extends DurableObject {
  private readonly sql: SqlStorage;
  private hostId: string | null = null;
  private watchAggregator: WatchSetAggregator | null = null;
  /** Serializes dispatches (bb per-host lane discipline, M0 granularity). */
  private dispatchChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orchestrator_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`);
    const applied = new Set(
      this.sql
        .exec<{ version: number }>("SELECT version FROM orchestrator_migrations")
        .toArray()
        .map((row) => Number(row.version)),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.ctx.storage.transactionSync(() => {
        for (const statement of migration.statements) {
          this.sql.exec(statement);
        }
        this.sql.exec(
          "INSERT INTO orchestrator_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          migration.version,
          migration.name,
          Date.now(),
        );
      });
    }
  }

  // -- meta kv ---------------------------------------------------------------

  private metaGet(key: string): string | undefined {
    const row = this.sql
      .exec<{ value: string }>(
        "SELECT value FROM orchestrator_meta WHERE key = ?",
        key,
      )
      .toArray()[0];
    return row?.value;
  }

  private metaSet(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO orchestrator_meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private requireHostId(incoming: string): void {
    const stored = this.metaGet("host_id");
    if (stored === undefined) {
      this.metaSet("host_id", incoming);
      this.hostId = incoming;
      return;
    }
    if (stored !== incoming) {
      throw new Error(
        `host mismatch: this orchestrator DO owns ${stored}, got ${incoming}`,
      );
    }
    this.hostId = incoming;
  }

  // ===========================================================================
  // Session mirror (host_daemon_sessions semantics).
  // ===========================================================================

  /**
   * bb openSession + handleHostSessionOpened: any active session for the host
   * is closed with reason "replaced" (socket-only for the same daemon
   * instance, full session-close notification otherwise), then the new
   * active session is inserted with a fresh lease.
   */
  async openSession(
    args: HostDaemonSessionOpenRequest & {
      heartbeatIntervalMs?: number;
      leaseTimeoutMs?: number;
    },
  ): Promise<SessionOpenOutcome> {
    this.requireHostId(args.hostId);
    if (args.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      // bb: record lastRejectedProtocolVersion, notify host-disconnected —
      // the notification rides the control plane (M0: recorded only).
      this.metaSet("last_rejected_protocol_version", String(args.protocolVersion));
      return {
        kind: "protocol_version_mismatch",
        details: {
          serverProtocolVersion: DAEMON_PROTOCOL_VERSION,
          rejectedProtocolVersion: args.protocolVersion,
        },
      };
    }
    const now = Date.now();
    const heartbeatIntervalMs = args.heartbeatIntervalMs ?? 5_000;
    const leaseTimeoutMs = args.leaseTimeoutMs ?? 30_000;
    const sessionId = newId("hses");

    const previous = this.latestSessionForHost();
    let replacedDisposition: "socket-only" | "session-close" | null = null;
    if (previous !== null && previous.id !== sessionId) {
      this.cancelPendingGrace(previous.id);
      if (previous.status === "active") {
        const sameDaemonInstance = previous.instanceId === args.instanceId;
        this.closeSessionRow(previous.id, "replaced", now);
        if (sameDaemonInstance) {
          replacedDisposition = "socket-only";
        } else {
          replacedDisposition = "session-close";
          if (previous.socketAttached) {
            this.pushOutbox({ type: "session-close", reason: "replaced" });
          }
        }
      }
    }

    const leaseExpiresAt = now + leaseTimeoutMs;
    this.sql.exec(
      `INSERT INTO host_daemon_sessions (
         id, host_id, instance_id, host_name, host_type, data_dir, platform,
         protocol_version, heartbeat_interval_ms, lease_timeout_ms, status,
         lease_expires_at, socket_attached, active_thread_ids, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?)`,
      sessionId,
      args.hostId,
      args.instanceId,
      args.hostName,
      args.hostType,
      args.dataDir,
      args.platform,
      args.protocolVersion,
      heartbeatIntervalMs,
      leaseTimeoutMs,
      leaseExpiresAt,
      JSON.stringify(args.activeThreads.map((t) => t.threadId)),
      now,
      now,
    );
    const session = this.getSessionRow(sessionId);
    if (session === null) {
      throw new Error("session insert failed");
    }
    this.scheduleAlarm();
    return {
      kind: "opened",
      session,
      previousSessionId: previous?.id ?? null,
      replacedDisposition,
      watchSet: this.reconcileWatchSet(),
    };
  }

  /**
   * Bind the command journal's host identity without opening a session
   * (#31 composition seam): provider-route commands are journalable before
   * any daemon client has enrolled — the server-side bridge calls this once
   * per orchestrator before its first enqueue. Idempotent; the first hostId
   * wins (same pinning rule as openSession). A mismatch is an outcome, not a
   * thrown RPC error — the bridge maps it to a control-plane 500.
   */
  async ensureHost(args: {
    hostId: string;
  }): Promise<{ kind: "bound"; hostId: string } | { kind: "host_mismatch"; boundHostId: string }> {
    const stored = this.metaGet("host_id");
    if (stored !== undefined && stored !== args.hostId) {
      return { kind: "host_mismatch", boundHostId: stored };
    }
    this.requireHostId(args.hostId);
    return { kind: "bound", hostId: this.hostId ?? args.hostId };
  }

  /**
   * bb validateDaemonWebSocket (M0 minus bearer auth — the hostKey gate is a
   * control-plane concern): subprotocol check, session must belong to the
   * host and be active with an unexpired lease. A successful attach also
   * cancels the session's pending disconnect grace (bb registerDaemon) and
   * detaches any other socket the host holds (bb unregisterDaemon of the old
   * session id).
   */
  async attachSocket(args: {
    sessionId: string;
    hostId: string;
    wsSubprotocol?: string;
  }): Promise<SocketAttachOutcome> {
    if (args.wsSubprotocol !== undefined && args.wsSubprotocol !== DAEMON_WS_SUBPROTOCOL) {
      return { kind: "rejected", closeCode: 1008, reason: "unsupported-protocol" };
    }
    const session = this.getSessionRow(args.sessionId);
    if (session === null || session.status !== "active") {
      return { kind: "rejected", closeCode: 1008, reason: "inactive-session" };
    }
    if (session.hostId !== args.hostId) {
      return { kind: "rejected", closeCode: 1008, reason: "unauthorized-session" };
    }
    if (session.leaseExpiresAt <= Date.now()) {
      this.closeSessionRow(session.id, "expired", Date.now());
      return { kind: "rejected", closeCode: 1008, reason: "inactive-session" };
    }
    // One live socket per host: superseded registrations detach silently.
    this.sql.exec(
      "UPDATE host_daemon_sessions SET socket_attached = 0, updated_at = ? " +
        "WHERE host_id = ? AND socket_attached = 1 AND id != ?",
      Date.now(),
      args.hostId,
      session.id,
    );
    this.sql.exec(
      "UPDATE host_daemon_sessions SET socket_attached = 1, updated_at = ? WHERE id = ?",
      Date.now(),
      session.id,
    );
    this.cancelPendingGrace(session.id);
    const attached = this.getSessionRow(session.id);
    return attached === null
      ? { kind: "rejected", closeCode: 1008, reason: "inactive-session" }
      : { kind: "attached", session: attached };
  }

  /**
   * bb handleDaemonSocketClosed: the session row closes immediately with
   * reason "daemon-disconnect"; owner-side-effect completion waits a grace
   * window for a reconnect and is skipped entirely when any socket is
   * attached for the host when it fires.
   */
  async detachSocket(args: {
    sessionId: string;
    graceMs?: number;
  }): Promise<{ closed: boolean; graceDeadlineAt: number | null }> {
    const session = this.getSessionRow(args.sessionId);
    if (session === null || session.status !== "active") {
      return { closed: false, graceDeadlineAt: null };
    }
    const now = Date.now();
    this.closeSessionRow(session.id, "daemon-disconnect", now);
    const graceMs = args.graceMs ?? DAEMON_DISCONNECT_GRACE_MS;
    const deadline = now + graceMs;
    this.sql.exec(
      "INSERT INTO pending_disconnect_grace (session_id, host_id, deadline_at, completed_at) " +
        "VALUES (?, ?, ?, NULL) " +
        "ON CONFLICT(session_id) DO UPDATE SET deadline_at = excluded.deadline_at, completed_at = NULL",
      session.id,
      session.hostId,
      deadline,
    );
    this.scheduleAlarm();
    return { closed: true, graceDeadlineAt: deadline };
  }

  /**
   * bb onDaemonSocketMessage lease renewal (daemon-protocol.ts:129-136):
   * every valid message renews the lease to
   * `max(now + leaseTimeoutMs, previousExpiry + 1)`. Inactive or
   * already-expired sessions answer `inactive` — the WS layer closes 1008
   * "inactive-session".
   */
  async recordDaemonMessage(args: {
    sessionId: string;
  }): Promise<DaemonMessageReceipt> {
    const session = this.getSessionRow(args.sessionId);
    if (session === null || session.status !== "active") {
      return { kind: "inactive" };
    }
    const now = Date.now();
    if (session.leaseExpiresAt <= now) {
      this.closeSessionRow(session.id, "expired", now);
      return { kind: "inactive" };
    }
    const leaseExpiresAt = Math.max(
      now + session.leaseTimeoutMs,
      session.leaseExpiresAt + 1,
    );
    this.sql.exec(
      "UPDATE host_daemon_sessions SET lease_expires_at = ?, updated_at = ? WHERE id = ?",
      leaseExpiresAt,
      now,
      session.id,
    );
    this.scheduleAlarm();
    return { kind: "renewed", leaseExpiresAt };
  }

  /** bb heartbeat frame is just a message — same renewal path. */
  async heartbeat(args: { sessionId: string }): Promise<DaemonMessageReceipt> {
    return this.recordDaemonMessage(args);
  }

  async getSession(args: {
    sessionId: string;
  }): Promise<HostDaemonSessionRow | null> {
    return this.getSessionRow(args.sessionId);
  }

  async getLatestSessionForHost(): Promise<HostDaemonSessionRow | null> {
    return this.latestSessionForHost();
  }

  async listSessions(): Promise<HostDaemonSessionRow[]> {
    return this.sql
      .exec<SessionRowSql>(
        "SELECT * FROM host_daemon_sessions ORDER BY created_at, id",
      )
      .toArray()
      .map(sessionFromSql);
  }

  async listDisconnectDispositions(): Promise<DisconnectDisposition[]> {
    return this.sql
      .exec<{
        session_id: string;
        host_id: string;
        kind: string;
        completed_at: number;
      }>(
        "SELECT session_id, host_id, kind, completed_at FROM disconnect_dispositions ORDER BY completed_at",
      )
      .toArray()
      .map((row) => ({
        sessionId: row.session_id,
        hostId: row.host_id,
        kind: row.kind as DisconnectDisposition["kind"],
        completedAt: Number(row.completed_at),
      }));
  }

  // -- session internals -------------------------------------------------------

  /** bb getLatestSessionForHost ordering (updated_at, created_at, id). */
  private latestSessionForHost(): HostDaemonSessionRow | null {
    const hostId = this.metaGet("host_id");
    if (hostId === undefined) {
      return null;
    }
    const row = this.sql
      .exec<SessionRowSql>(
        "SELECT * FROM host_daemon_sessions WHERE host_id = ? " +
          "ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1",
        hostId,
      )
      .toArray()[0];
    return row === undefined ? null : sessionFromSql(row);
  }

  private getSessionRow(sessionId: string): HostDaemonSessionRow | null {
    const row = this.sql
      .exec<SessionRowSql>("SELECT * FROM host_daemon_sessions WHERE id = ?", sessionId)
      .toArray()[0];
    return row === undefined ? null : sessionFromSql(row);
  }

  private closeSessionRow(
    sessionId: string,
    reason: DaemonSessionCloseReason,
    now: number,
  ): void {
    this.sql.exec(
      "UPDATE host_daemon_sessions SET status = 'closed', closed_at = ?, " +
        "close_reason = ?, socket_attached = 0, updated_at = ? " +
        "WHERE id = ? AND status = 'active'",
      now,
      reason,
      now,
      sessionId,
    );
  }

  private cancelPendingGrace(sessionId: string): void {
    this.sql.exec("DELETE FROM pending_disconnect_grace WHERE session_id = ?", sessionId);
  }

  // ===========================================================================
  // Command journal (host_daemon_commands / host_daemon_command_attempts).
  // ===========================================================================

  async enqueueCommand(args: {
    type: AdapterCommandType;
    command: AdapterCommand;
    threadId?: string;
  }): Promise<{ commandId: string; cursor: number }> {
    // The journal is host-scoped: openSession binds the host first (bb wrote
    // host_daemon_commands rows only for enrolled hosts).
    if (this.metaGet("host_id") === undefined) {
      throw new Error(
        "no host bound — openSession must run before enqueueCommand",
      );
    }
    const nextCursor =
      Number(this.metaGet("command_cursor") ?? "0") + 1;
    const commandId = newId("hcmd");
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO host_daemon_commands (
         id, host_id, session_id, cursor, type, thread_id, payload, state,
         retry_count, created_at
       ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'pending', 0, ?)`,
      commandId,
      this.hostId,
      nextCursor,
      args.type,
      args.threadId ?? null,
      JSON.stringify(args.command),
      now,
    );
    this.metaSet("command_cursor", String(nextCursor));
    return { commandId, cursor: nextCursor };
  }

  /**
   * One dispatch lane per host (bb command-router lane discipline at M0
   * granularity): concurrent dispatchCommands queue behind a promise chain so
   * the provider adapter sees commands in journal order.
   */
  async dispatchCommand(args: {
    commandId: string;
    timeoutMs?: number;
    route?: "provider" | "machine";
  }): Promise<CommandDispatchOutcome> {
    const run = this.dispatchChain.then(() =>
      this.dispatchCommandInner(args),
    );
    this.dispatchChain = run.catch(() => {});
    return run;
  }

  private async dispatchCommandInner(args: {
    commandId: string;
    timeoutMs?: number;
    route?: "provider" | "machine";
  }): Promise<CommandDispatchOutcome> {
    const cmd = this.getCommandRow(args.commandId);
    if (cmd === undefined) {
      return { kind: "unknown_command" };
    }
    if (cmd.state !== "pending") {
      return { kind: "not_dispatchable", state: cmd.state };
    }
    const now = Date.now();
    const timeoutMs = args.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const route = args.route ?? "provider";
    const activeSession = this.activeSessionRow();
    const attemptId = newId("hcmda");
    this.sql.exec(
      "UPDATE host_daemon_commands SET state = 'fetched', fetched_at = ?, session_id = ? WHERE id = ?",
      now,
      activeSession?.id ?? null,
      cmd.id,
    );
    this.sql.exec(
      `INSERT INTO host_daemon_command_attempts (
         id, command_id, session_id, status, delivered_at, lease_expires_at
       ) VALUES (?, ?, ?, 'active', ?, ?)`,
      attemptId,
      cmd.id,
      activeSession?.id ?? null,
      now,
      now + timeoutMs,
    );
    this.scheduleAlarm();

    // Journal payloads were type-checked at enqueueCommand; the JSON
    // round-trip only widens the row type to `unknown` — this cast restores
    // what storage lost.
    const command = cmd.payload as AdapterCommand;
    if (route === "machine") {
      if (cmd.threadId === null) {
        return this.settleAttempt(cmd.id, attemptId, {
          ok: false,
          errorCode: "internal",
          errorMessage: "machine route requires a threadId",
        });
      }
      const dispatcher = getMachineDispatcher();
      let machineOutcome: MachineCommandDispatchOutcome;
      try {
        machineOutcome = await dispatcher.dispatch({
          executionId: executionIdFor(cmd.threadId, cmd.cursor),
          threadId: cmd.threadId,
          command,
          timeoutMs,
        });
      } catch (error) {
        return this.settleAttempt(cmd.id, attemptId, {
          ok: false,
          errorCode: "internal",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      switch (machineOutcome.kind) {
        case "accepted":
          // Settle-type command (bb transport split): the journal holds the
          // active attempt until `settleCommand` or the lease alarm.
          return { kind: "accepted_async", attemptId };
        case "completed_cached":
          return this.settleAttempt(cmd.id, attemptId, {
            ok: true,
            result: machineOutcome.result,
          });
        case "host_offline":
          return this.settleAttempt(cmd.id, attemptId, {
            ok: false,
            errorCode: "machine_unavailable",
            errorMessage: "no live daemon client for this host",
            retryable: true,
          });
      }
    }

    const adapter = getProviderAdapter();
    let outcome: AdapterCommandOutcome;
    try {
      outcome = await adapter.handleCommand(command, { timeoutMs });
    } catch (error) {
      outcome = {
        ok: false,
        errorCode: "internal",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    return this.settleAttempt(cmd.id, attemptId, outcome);
  }

  /**
   * Async settlement entry point (machine-route results flow back here).
   * Terminal attempts and terminal commands reject late results as stale —
   * the unique-active attempt index guarantees at most one live attempt.
   */
  async settleCommand(args: {
    commandId: string;
    attemptId: string;
    outcome: AdapterCommandOutcome;
  }): Promise<CommandSettleOutcome> {
    const attempt = this.getAttemptRow(args.attemptId);
    if (attempt === undefined || attempt.commandId !== args.commandId) {
      return { kind: "rejected", reason: "unknown" };
    }
    if (attempt.status !== "active") {
      // The attempt row is the precise audit answer (e.g. status "timeout"):
      // after a lease expiry both attempt and command are terminal, and the
      // caller's attempt is what went stale.
      return { kind: "rejected", reason: "attempt-terminal" };
    }
    const cmd = this.getCommandRow(args.commandId);
    if (cmd === undefined || cmd.state !== "fetched") {
      return { kind: "rejected", reason: "command-terminal" };
    }
    this.applySettlement(cmd.id, args.attemptId, args.outcome, Date.now());
    return { kind: "accepted" };
  }

  /**
   * bb retryable-command path: a failed command re-enters the pending queue
   * with an incremented retry_count; the next dispatch opens a fresh attempt.
   */
  async retryCommand(args: {
    commandId: string;
  }): Promise<{ queued: boolean; state: HostDaemonCommandRow["state"] | null; retryCount: number | null }> {
    const cmd = this.getCommandRow(args.commandId);
    if (cmd === undefined || cmd.state !== "failed") {
      return {
        queued: false,
        state: cmd?.state ?? null,
        retryCount: cmd?.retryCount ?? null,
      };
    }
    this.sql.exec(
      "UPDATE host_daemon_commands SET state = 'pending', retry_count = retry_count + 1 WHERE id = ?",
      cmd.id,
    );
    return { queued: true, state: "pending", retryCount: cmd.retryCount + 1 };
  }

  async getCommand(args: {
    commandId: string;
  }): Promise<HostDaemonCommandRow | null> {
    return this.getCommandRow(args.commandId) ?? null;
  }

  async listCommands(): Promise<HostDaemonCommandRow[]> {
    return this.sql
      .exec<CommandRowSql>(
        "SELECT * FROM host_daemon_commands ORDER BY cursor",
      )
      .toArray()
      .map(commandFromSql);
  }

  async listAttempts(args: {
    commandId: string;
  }): Promise<HostDaemonCommandAttemptRow[]> {
    return this.sql
      .exec<AttemptRowSql>(
        "SELECT * FROM host_daemon_command_attempts WHERE command_id = ? ORDER BY delivered_at, id",
        args.commandId,
      )
      .toArray()
      .map(attemptFromSql);
  }

  // -- command internals -------------------------------------------------------

  private getCommandRow(commandId: string): HostDaemonCommandRow | undefined {
    const row = this.sql
      .exec<CommandRowSql>("SELECT * FROM host_daemon_commands WHERE id = ?", commandId)
      .toArray()[0];
    return row === undefined ? undefined : commandFromSql(row);
  }

  private getAttemptRow(attemptId: string): HostDaemonCommandAttemptRow | undefined {
    const row = this.sql
      .exec<AttemptRowSql>(
        "SELECT * FROM host_daemon_command_attempts WHERE id = ?",
        attemptId,
      )
      .toArray()[0];
    return row === undefined ? undefined : attemptFromSql(row);
  }

  private activeSessionRow(): HostDaemonSessionRow | null {
    const hostId = this.hostId ?? this.metaGet("host_id");
    if (hostId === undefined) {
      return null;
    }
    const row = this.sql
      .exec<SessionRowSql>(
        "SELECT * FROM host_daemon_sessions WHERE host_id = ? AND status = 'active' " +
          "ORDER BY created_at DESC, id DESC LIMIT 1",
        hostId,
      )
      .toArray()[0];
    return row === undefined ? null : sessionFromSql(row);
  }

  private settleAttempt(
    commandId: string,
    attemptId: string,
    outcome: AdapterCommandOutcome,
  ): CommandDispatchOutcome {
    const applied = this.applySettlement(commandId, attemptId, outcome, Date.now());
    if (applied) {
      return { kind: "settled", outcome, attemptId };
    }
    // The journal already holds the terminal truth (attempt lease timed out
    // before settlement) — report it rather than fabricating an outcome.
    return { kind: "stale_settlement", attemptId };
  }

  /** Synchronous journal transition; idempotent (terminal states refuse). */
  private applySettlement(
    commandId: string,
    attemptId: string,
    outcome: AdapterCommandOutcome,
    now: number,
  ): boolean {
    const attempt = this.getAttemptRow(attemptId);
    const cmd = this.getCommandRow(commandId);
    if (attempt === undefined || cmd === undefined) {
      return false;
    }
    if (attempt.status !== "active" || cmd.state !== "fetched") {
      return false;
    }
    this.sql.exec(
      "UPDATE host_daemon_command_attempts SET status = ?, settled_at = ? WHERE id = ?",
      outcome.ok ? "ok" : "failed",
      now,
      attemptId,
    );
    this.sql.exec(
      "UPDATE host_daemon_commands SET state = ?, result_payload = ?, completed_at = ? WHERE id = ?",
      outcome.ok ? "completed" : "failed",
      JSON.stringify(outcome),
      now,
      commandId,
    );
    return true;
  }

  // ===========================================================================
  // Watch-set aggregation.
  // ===========================================================================

  async applyWatchInterests(
    args: WatchSetApplyArgs,
  ): Promise<{ emitted: boolean; generation: number }> {
    const aggregator = this.loadWatchAggregator();
    aggregator.apply(args);
    this.persistWatchInterests(aggregator);
    const generationBefore = aggregator.currentGeneration();
    const snapshot = aggregator.refreshForSend();
    if (snapshot.generation === generationBefore) {
      // Identical fingerprint: bb keeps the old generation and sends nothing.
      return { emitted: false, generation: snapshot.generation };
    }
    this.metaSet("watch_generation", String(snapshot.generation));
    this.metaSet("watch_fingerprint", snapshot.fingerprint);
    this.pushOutbox({
      type: "watch-set.replace",
      generation: snapshot.watchSet.generation,
      workspaceTargets: snapshot.watchSet.workspaceTargets,
      threadStorageTargets: snapshot.watchSet.threadStorageTargets,
    });
    return { emitted: true, generation: snapshot.generation };
  }

  /** bb reconcileWatchSetForHost — the set at the current generation. */
  reconcileWatchSet(): DaemonWatchSet {
    return this.loadWatchAggregator().reconcile();
  }

  private loadWatchAggregator(): WatchSetAggregator {
    if (this.watchAggregator !== null) {
      return this.watchAggregator;
    }
    const aggregator = new WatchSetAggregator();
    const generation = this.metaGet("watch_generation");
    const fingerprint = this.metaGet("watch_fingerprint");
    aggregator.restore({
      generation: generation === undefined ? 0 : Number(generation),
      fingerprint: fingerprint ?? null,
    });
    const interests = this.metaGet("watch_interests");
    if (interests !== undefined) {
      aggregator.apply(JSON.parse(interests) as WatchSetApplyArgs);
    }
    this.watchAggregator = aggregator;
    return aggregator;
  }

  private persistWatchInterests(aggregator: WatchSetAggregator): void {
    this.metaSet(
      "watch_interests",
      JSON.stringify(aggregator.snapshotInterests()),
    );
  }

  // ===========================================================================
  // Daemon outbox (server→daemon frames awaiting the WS layer).
  // ===========================================================================

  async drainDaemonOutbox(): Promise<DaemonServerMessage[]> {
    const rows = this.sql
      .exec<{ seq: number; payload: string }>(
        "SELECT seq, payload FROM daemon_outbox ORDER BY seq",
      )
      .toArray();
    this.sql.exec("DELETE FROM daemon_outbox");
    return rows.map((row) => daemonServerMessageSchema.parse(JSON.parse(row.payload)));
  }

  private pushOutbox(message: DaemonServerMessage): void {
    this.sql.exec(
      "INSERT INTO daemon_outbox (payload, created_at) VALUES (?, ?)",
      JSON.stringify(message),
      Date.now(),
    );
  }

  // ===========================================================================
  // Alarm: lease expiry, attempt timeouts, disconnect grace completion.
  // ===========================================================================

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const session of await this.listSessions()) {
      if (session.status === "active" && session.leaseExpiresAt <= now) {
        this.closeSessionRow(session.id, "expired", now);
      }
    }
    for (const attempt of this.sql
      .exec<AttemptRowSql & { command_state: string }>(
        "SELECT a.*, c.state AS command_state FROM host_daemon_command_attempts a " +
          "JOIN host_daemon_commands c ON c.id = a.command_id " +
          "WHERE a.status = 'active' AND a.lease_expires_at <= ?",
        now,
      )
      .toArray()) {
      const timedOut: AdapterCommandOutcome = {
        ok: false,
        errorCode: "timeout",
        errorMessage: "dispatch lease expired before settlement",
        retryable: true,
      };
      this.sql.exec(
        "UPDATE host_daemon_command_attempts SET status = 'timeout', settled_at = ? WHERE id = ?",
        now,
        attempt.id,
      );
      if (attempt.command_state === "fetched") {
        this.sql.exec(
          "UPDATE host_daemon_commands SET state = 'failed', result_payload = ?, completed_at = ? WHERE id = ?",
          JSON.stringify(timedOut),
          now,
          attempt.command_id,
        );
      }
    }
    for (const grace of this.sql
      .exec<{ session_id: string; host_id: string; deadline_at: number }>(
        "SELECT session_id, host_id, deadline_at FROM pending_disconnect_grace " +
          "WHERE completed_at IS NULL AND deadline_at <= ?",
        now,
      )
      .toArray()) {
      this.sql.exec(
        "UPDATE pending_disconnect_grace SET completed_at = ? WHERE session_id = ?",
        now,
        grace.session_id,
      );
      // bb completeDaemonDisconnectGrace: skip when any socket is attached
      // for the host (reconnected before the window closed).
      const hostHasSocket = this.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM host_daemon_sessions " +
            "WHERE host_id = ? AND socket_attached = 1 AND status = 'active'",
          grace.host_id,
        )
        .toArray()[0];
      if (hostHasSocket !== undefined && Number(hostHasSocket.n) > 0) {
        continue;
      }
      this.sql.exec(
        "INSERT INTO disconnect_dispositions (session_id, host_id, kind, completed_at) " +
          "VALUES (?, ?, 'daemon-disconnect-grace-completed', ?) " +
          "ON CONFLICT(session_id) DO NOTHING",
        grace.session_id,
        grace.host_id,
        now,
      );
    }
    await this.scheduleAlarm();
  }

  /** Arm the alarm at the earliest outstanding deadline, if any. */
  private async scheduleAlarm(): Promise<void> {
    const now = Date.now();
    const deadlines: number[] = [];
    // Any outstanding deadline needs its sweep — including ones already
    // overdue (this runs after the row inserts, so a zero-length lease can
    // be in the past by the time we look): arm at max(deadline, now).
    const sessionDeadline = this.sql
      .exec<{ d: number }>(
        "SELECT MIN(lease_expires_at) AS d FROM host_daemon_sessions WHERE status = 'active'",
      )
      .toArray()[0];
    if (sessionDeadline?.d !== undefined) {
      deadlines.push(Math.max(Number(sessionDeadline.d), now));
    }
    const attemptDeadline = this.sql
      .exec<{ d: number }>(
        "SELECT MIN(lease_expires_at) AS d FROM host_daemon_command_attempts WHERE status = 'active'",
      )
      .toArray()[0];
    if (attemptDeadline?.d !== undefined) {
      deadlines.push(Math.max(Number(attemptDeadline.d), now));
    }
    const graceDeadline = this.sql
      .exec<{ d: number }>(
        "SELECT MIN(deadline_at) AS d FROM pending_disconnect_grace WHERE completed_at IS NULL",
      )
      .toArray()[0];
    if (graceDeadline?.d !== undefined) {
      deadlines.push(Math.max(Number(graceDeadline.d), now));
    }
    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const earliest = Math.min(...deadlines);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > earliest) {
      await this.ctx.storage.setAlarm(earliest);
    }
  }
}
