import {
  setAgentRuntime,
  type AgentDO,
  type SendMessageResult,
} from "@cap/agent-do";
import type { PromptContent } from "@cap/protocol";
import { DurableObject } from "cloudflare:workers";
import type {
  AdapterCommand,
  AdapterCommandOutcome,
} from "../../daemon-worker/src/provider-adapter.js";
import {
  classifyHarnessProjection,
  harnessFromSnapshot,
  projectHarness,
  resolveHarness,
  snapshotHarness,
} from "./harness.js";
import type { HarnessEnv } from "./harness.js";
import {
  EMPTY_PROVIDER_OVERLAY,
  RelayProviderRegistry,
  relayAgentRuntime,
} from "./relay-registry.js";
import { loadProviderConfigOverlay, type ProviderConfigEnv } from "./provider-configs.js";
import { flattenPromptInputGroups } from "./flatten-input.js";

/**
 * Manager DO (ticket #28) — the provider application's durable brain, the
 * worker-side replacement for bb's daemon-side runtime manager (port-inventory
 * §2.3):
 *
 * - session registry (durable truth, bb's `host_daemon_sessions` +
 *   runtime-memory Map collapsed into one SQLite table): threadId ↔
 *   providerThreadId (the edge-agent session identity, `pthr_<threadId>`),
 *   lifecycle, and the ompRecovery-equivalent descriptor;
 * - per-thread agent DO spawn/reuse: `AGENT_DO.idFromName(threadId)` — the
 *   fleet-wide DO name is the LOGICAL thread id (#31 composition): the
 *   daemon-service DO self-routes execution updates by
 *   `threadIdFromExecutionId`, and the server control plane reads events by
 *   threadId, so every caller must land on the same DO. The providerThreadId
 *   stays the provider-session registry key (bb `processKey` analogue) without
 *   being the DO name;
 * - harness config application: the resolved three keys are snapshotted per
 *   thread, drift is classified (live vs session) at each turn, and the
 *   relay client is (re)registered into the agent DO injection registry
 *   whenever the resolved relay fingerprint changes.
 *
 * Consistency model: the registry row is the identity truth (ids, descriptor,
 * host binding); the agent DO remains the sole truth for turn/tool state —
 * `lifecycle`/`activeTurnId` here are an advisory mirror updated at command
 * boundaries only. An evicted manager rebuilds nothing (rows come back from
 * SQLite); an evicted agent DO replays from its own log.
 */

export interface ManagerDoBindings extends HarnessEnv, ProviderConfigEnv {
  AGENT_DO: DurableObjectNamespace;
}

interface SessionRow {
  threadId: string;
  providerThreadId: string;
  lifecycle: "ready" | "active";
  cwd: string;
  machineId: string;
  title: string;
  recoverySessionId: string;
  recoverySessionFile: string;
  activeClientRequestId: string | null;
  activeTurnId: string | null;
  poisoned: boolean;
  archived: boolean;
  harnessJson: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionRowDb extends Record<string, SqlStorageValue> {
  thread_id: string;
  provider_thread_id: string;
  lifecycle: string;
  cwd: string;
  machine_id: string;
  title: string;
  recovery_session_id: string;
  recovery_session_file: string;
  active_client_request_id: string | null;
  active_turn_id: string | null;
  poisoned: number;
  archived: number;
  harness_json: string;
  created_at: number;
  updated_at: number;
}

function decodeRow(row: SessionRowDb): SessionRow {
  return {
    threadId: row.thread_id,
    providerThreadId: row.provider_thread_id,
    lifecycle: row.lifecycle === "active" ? "active" : "ready",
    cwd: row.cwd,
    machineId: row.machine_id,
    title: row.title,
    recoverySessionId: row.recovery_session_id,
    recoverySessionFile: row.recovery_session_file,
    activeClientRequestId: row.active_client_request_id,
    activeTurnId: row.active_turn_id,
    poisoned: row.poisoned === 1,
    archived: row.archived === 1,
    harnessJson: row.harness_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function errorOutcome(
  errorCode: string,
  errorMessage: string,
  retryable = false,
): AdapterCommandOutcome {
  return { ok: false, errorCode, errorMessage, retryable };
}

/**
 * AgentRpcError classes do not survive the DO RPC boundary (plain Error
 * carrying the original message), so the seam-owned message text is the
 * mapping key: `... is active (${status}); use mode "auto" or "steer"`
 * (AgentDO.sendMessage conflict) and `DO owns thread ...` (createThread).
 */
function mapAgentError(error: unknown): AdapterCommandOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("is active (")) {
    return errorOutcome("turn_already_active", message);
  }
  if (message.includes("DO owns thread")) {
    return errorOutcome("session_conflict", message);
  }
  return errorOutcome("provider_error", message);
}

/**
 * Adapter input → DO journal content (#317 gate unlock): the full prompt
 * union rides through; the request layer's mentions/visibility extras stay
 * behind. The historical text-only gate died with the M0 face — an
 * image-only turn is a legal turn; only an EMPTY input stays invalid.
 */
function promptContentOf(
  command: Extract<AdapterCommand, { type: "turn/start" } | { type: "turn/steer" }>,
): PromptContent[] {
  return flattenPromptInputGroups(command.input, command.inputGroups).map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text" as const, text: part.text };
      case "image":
        return { type: "image" as const, url: part.url };
      case "localImage":
        return { type: "localImage" as const, path: part.path };
      case "localFile":
        return {
          type: "localFile" as const,
          path: part.path,
          ...(part.name !== undefined ? { name: part.name } : {}),
          ...(part.sizeBytes !== undefined ? { sizeBytes: part.sizeBytes } : {}),
          ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
        };
    }
  });
}

function firstTextOf(
  command: Extract<AdapterCommand, { type: "thread/start" }>,
): string | undefined {
  for (const part of command.input ?? []) {
    if (part.type === "text") return part.text;
  }
  return undefined;
}

export class ManagerDo extends DurableObject<ManagerDoBindings> {
  /** Last relay fingerprint registered in this isolate (module-global seam). */
  private registeredRelayFingerprint: string | null = null;

  constructor(ctx: DurableObjectState, env: ManagerDoBindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS provider_sessions (
        thread_id TEXT PRIMARY KEY,
        provider_thread_id TEXT NOT NULL UNIQUE,
        lifecycle TEXT NOT NULL,
        cwd TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        title TEXT NOT NULL,
        recovery_session_id TEXT NOT NULL,
        recovery_session_file TEXT NOT NULL,
        active_client_request_id TEXT,
        active_turn_id TEXT,
        poisoned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        harness_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  // -------------------------------------------------------------------------
  // RPC surface — consumed by the edge-agent adapter (in-process) or a
  // MANAGER binding holder.
  // -------------------------------------------------------------------------

  async handleAdapterCommand(command: AdapterCommand): Promise<AdapterCommandOutcome> {
    await this.ensureAgentRuntime();
    switch (command.type) {
      case "initialize":
        return this.initialize();
      case "skills/configure":
        return this.configureSkills(command.skillRoots.length);
      case "model/list":
        return this.modelList();
      case "thread/start":
        return this.startThread(command);
      case "thread/resume":
        return this.resumeThread(command);
      case "thread/fork":
        return errorOutcome("unsupported", "agent DO sessions do not support fork in M0");
      case "turn/start":
        return this.startTurn(command);
      case "turn/steer":
        return this.steerTurn(command);
      case "thread/stop":
        return this.stopThread(command);
      case "thread/discard":
        return this.discardThread(command.providerThreadId);
      case "thread/goal/clear":
        return this.withRow(command.providerThreadId, () => ({
          ok: true,
          result: { cleared: true },
        }));
      case "thread/name/set":
        return this.setName(command.providerThreadId, command.title);
      case "thread/archive":
        return this.setArchived(command.providerThreadId, true);
      case "thread/unarchive":
        return this.setArchived(command.providerThreadId, false);
    }
  }

  // -------------------------------------------------------------------------
  // Registry-backed command bodies
  // -------------------------------------------------------------------------

  private initialize(): AdapterCommandOutcome {
    const harness = resolveHarness(this.env);
    return {
      ok: true,
      result: {
        protocolVersion: 1,
        provider: "edge-agent",
        relayMode: harness.relay.mode,
        machineId: harness.hostBinding.machineId,
      },
    };
  }

  private configureSkills(rootCount: number): AdapterCommandOutcome {
    // M0 harness minimal face: the loop ships bash only (ruling 2026-10-03);
    // skill roots are accepted and ignored until the tools ticket lands.
    return { ok: true, result: { configuredRoots: rootCount } };
  }

  private modelList(): AdapterCommandOutcome {
    const harness = resolveHarness(this.env);
    // #496: no channel env = no channel — the face advertises nothing rather
    // than a synthesized row (the D1 catalog is the selection 正本, #450).
    if (harness.relay.model === "") {
      return { ok: true, result: { models: [], selectedOnlyModels: [] } };
    }
    return {
      ok: true,
      result: {
        models: [
          {
            id: "edge-agent-default",
            model: harness.relay.model,
            displayName: `Edge agent (${harness.relay.model})`,
            description:
              harness.relay.mode === "mock"
                ? "Fixed-reply mock (relay key not configured)"
                : harness.relay.api === "openai-responses"
                  ? "OpenAI Responses-protocol relay model (#361 adaptor)"
                  : harness.relay.api === "openai-completions"
                    ? "OpenAI Chat Completions-protocol relay model (#363 adaptor)"
                  : "Anthropic-protocol relay model (GLM coding plan)",
            supportedReasoningEfforts: [
              {
                reasoningEffort: "none",
                description: "Deterministic budget (thinking disabled by default)",
              },
            ],
            defaultReasoningEffort: "none",
            isDefault: true,
          },
        ],
        selectedOnlyModels: [],
      },
    };
  }

  private async startThread(
    command: Extract<AdapterCommand, { type: "thread/start" }>,
  ): Promise<AdapterCommandOutcome> {
    const now = Date.now();
    const existing = this.rowByThreadId(command.threadId);
    if (existing !== undefined) {
      // Reuse: one agent DO per thread — re-issue createThread so an evicted
      // DO replays from its own log while the row identity stays untouched.
      await this.agentStub(existing.threadId).createThread({
        threadId: existing.threadId,
        title: existing.title,
        machineId: existing.machineId,
      });
      return {
        ok: true,
        result: {
          threadId: existing.threadId,
          providerThreadId: existing.providerThreadId,
          sessionRestorable: true,
        },
      };
    }
    const providerThreadId = `pthr_${command.threadId}`;
    const clash = this.rowByProviderThreadId(providerThreadId);
    if (clash !== undefined) {
      return errorOutcome(
        "provider_thread_conflict",
        `providerThreadId ${providerThreadId} already bound to thread ${clash.threadId}`,
      );
    }
    const titleRaw = firstTextOf(command)?.slice(0, 120) ?? "";
    const title = titleRaw === "" ? `thread ${command.threadId}` : titleRaw;
    // #288: the control plane's resolved binding wins; the harness hostBinding
    // stays the fallback for commands that predate the field.
    const machineId = command.machineId ?? resolveHarness(this.env).hostBinding.machineId;
    const created = await this.agentStub(command.threadId).createThread({
      threadId: command.threadId,
      title,
      machineId,
      ...(command.execution !== undefined ? { execution: command.execution } : {}),
    });
    const harness = resolveHarness(this.env);
    this.ctx.storage.sql.exec(
      `INSERT INTO provider_sessions (
         thread_id, provider_thread_id, lifecycle, cwd, machine_id, title,
         recovery_session_id, recovery_session_file,
         active_client_request_id, active_turn_id, poisoned, archived,
         harness_json, created_at, updated_at
       ) VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?, ?)`,
      command.threadId,
      providerThreadId,
      command.cwd,
      machineId,
      title,
      providerThreadId,
      `agent-do://${providerThreadId}/events.jsonl`,
      snapshotHarness(harness),
      now,
      now,
    );
    return {
      ok: true,
      result: {
        threadId: command.threadId,
        providerThreadId,
        // `duplicated: true` would mean the DO was pre-seeded out-of-band;
        // a fresh start always creates its own log.
        sessionRestorable: true,
        agentDoCreated: !created.duplicated,
      },
    };
  }

  private async resumeThread(
    command: Extract<AdapterCommand, { type: "thread/resume" }>,
  ): Promise<AdapterCommandOutcome> {
    const row = this.rowByProviderThreadId(command.providerThreadId);
    if (row !== undefined) {
      if (row.poisoned && command.ompRecovery === undefined) {
        return errorOutcome(
          "session_recovery_required",
          "interrupted session requires the ompRecovery descriptor",
        );
      }
      // Ownership re-verification: an evicted agent DO replays from its log
      // and answers duplicated=true; a wiped DO is re-created under the row's
      // frozen identity (the registry stays the mapping truth).
      try {
        await this.agentStub(row.threadId).createThread({
          threadId: row.threadId,
          title: row.title,
          machineId: row.machineId,
        });
      } catch (error) {
        return mapAgentError(error);
      }
      return {
        ok: true,
        result: {
          threadId: row.threadId,
          providerThreadId: row.providerThreadId,
          ompRecovery: command.ompRecovery ?? {
            sessionId: row.recoverySessionId,
            sessionFile: row.recoverySessionFile,
          },
        },
      };
    }
    if (command.ompRecovery !== undefined) {
      // Registry lost but the daemon kept the descriptor: reattach under the
      // descriptor's identity (agent DO replay restores the log if it held one).
      const providerThreadId = command.ompRecovery.sessionId;
      const clash = this.rowByProviderThreadId(providerThreadId);
      if (clash !== undefined) {
        return errorOutcome(
          "provider_thread_conflict",
          `descriptor sessionId ${providerThreadId} already bound to thread ${clash.threadId}`,
        );
      }
      const now = Date.now();
      const title = `thread ${command.threadId}`;
      const created = await this.agentStub(command.threadId).createThread({
        threadId: command.threadId,
        title,
        machineId: resolveHarness(this.env).hostBinding.machineId,
      });
      const harness = resolveHarness(this.env);
      this.ctx.storage.sql.exec(
        `INSERT INTO provider_sessions (
           thread_id, provider_thread_id, lifecycle, cwd, machine_id, title,
           recovery_session_id, recovery_session_file,
           active_client_request_id, active_turn_id, poisoned, archived,
           harness_json, created_at, updated_at
         ) VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?, ?)`,
        command.threadId,
        providerThreadId,
        command.cwd,
        harness.hostBinding.machineId,
        title,
        command.ompRecovery.sessionId,
        command.ompRecovery.sessionFile,
        snapshotHarness(harness),
        now,
        now,
      );
      return {
        ok: true,
        result: {
          threadId: command.threadId,
          providerThreadId,
          ompRecovery: command.ompRecovery,
          sessionRestorable: created.duplicated,
        },
      };
    }
    return errorOutcome("thread_not_found", `unknown provider thread ${command.providerThreadId}`);
  }

  private async startTurn(
    command: Extract<AdapterCommand, { type: "turn/start" }>,
  ): Promise<AdapterCommandOutcome> {
    const row = this.rowByProviderThreadId(command.providerThreadId);
    if (row === undefined) {
      return errorOutcome(
        "thread_not_found",
        `unknown provider thread ${command.providerThreadId}`,
      );
    }
    if (row.poisoned) {
      return errorOutcome(
        "session_recovery_required",
        `provider thread ${row.providerThreadId} is poisoned by an interrupted turn`,
      );
    }
    const drift = this.classifyRowDrift(row);
    if (drift === "session") {
      return errorOutcome(
        "host_binding_changed",
        "host binding changed since thread start — rebuild the provider session (thread/resume)",
      );
    }
    const content = promptContentOf(command);
    if (content.length === 0) {
      return errorOutcome("invalid_input", "turn/start carries no input");
    }
    let sent: SendMessageResult;
    try {
      sent = await this.agentStub(command.threadId).sendMessage({
        clientRequestId: command.clientRequestId,
        content,
        mode: "start",
        ...(command.execution !== undefined ? { execution: command.execution } : {}),
      });
    } catch (error) {
      return mapAgentError(error);
    }
    this.updateRow(row.providerThreadId, {
      lifecycle: "active",
      active_client_request_id: command.clientRequestId,
      active_turn_id: sent.turnId,
      ...(drift === "live" ? { harness_json: snapshotHarness(resolveHarness(this.env)) } : {}),
    });
    return {
      ok: true,
      result: { turnId: sent.turnId, agentInvoked: true, duplicated: sent.duplicated },
    };
  }

  private async steerTurn(
    command: Extract<AdapterCommand, { type: "turn/steer" }>,
  ): Promise<AdapterCommandOutcome> {
    const row = this.rowByProviderThreadId(command.providerThreadId);
    if (row === undefined) {
      return errorOutcome(
        "thread_not_found",
        `unknown provider thread ${command.providerThreadId}`,
      );
    }
    // bb/FAKE parity: the expected provider turn id must match the registry's
    // active turn — the agent DO enforces the rest (terminal/duplicate input).
    if (row.activeTurnId !== command.expectedTurnId) {
      return errorOutcome(
        "steer_no_active_turn",
        `expected active turn ${command.expectedTurnId}, registry holds ${row.activeTurnId ?? "none"}`,
      );
    }
    const content = promptContentOf(command);
    if (content.length === 0) {
      return errorOutcome("invalid_input", "turn/steer carries no input");
    }
    try {
      const sent = await this.agentStub(command.threadId).sendMessage({
        clientRequestId: command.clientRequestId,
        content,
        mode: "steer",
        ...(command.execution !== undefined ? { execution: command.execution } : {}),
      });
      return { ok: true, result: { steered: true, turnId: sent.turnId } };
    } catch (error) {
      return mapAgentError(error);
    }
  }

  private async stopThread(
    command: Extract<AdapterCommand, { type: "thread/stop" }>,
  ): Promise<AdapterCommandOutcome> {
    const row = this.rowByProviderThreadId(command.providerThreadId);
    if (row === undefined) {
      return errorOutcome(
        "thread_not_found",
        `unknown provider thread ${command.providerThreadId}`,
      );
    }
    let interrupted = false;
    if (command.activeTurnId !== null) {
      interrupted = true;
      try {
        await this.agentStub(command.threadId).cancelTurn({
          turnId: command.activeTurnId,
        });
      } catch {
        // The turn may have settled concurrently; the poisoned marking below
        // is registry-level and unaffected (bb/FAKE parity).
      }
      this.updateRow(row.providerThreadId, {
        lifecycle: "ready",
        active_client_request_id: null,
        active_turn_id: null,
        poisoned: 1,
      });
    }
    return { ok: true, result: { stopped: true, interrupted } };
  }

  private discardThread(providerThreadId: string): AdapterCommandOutcome {
    const row = this.rowByProviderThreadId(providerThreadId);
    if (row === undefined) {
      return errorOutcome("thread_not_found", `unknown provider thread ${providerThreadId}`);
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM provider_sessions WHERE provider_thread_id = ?",
      providerThreadId,
    );
    return { ok: true, result: { discarded: true } };
  }

  private setName(providerThreadId: string, title: string): AdapterCommandOutcome {
    const row = this.rowByProviderThreadId(providerThreadId);
    if (row === undefined) {
      return errorOutcome("thread_not_found", `unknown provider thread ${providerThreadId}`);
    }
    this.updateRow(providerThreadId, { title });
    return { ok: true, result: { title } };
  }

  private setArchived(providerThreadId: string, archived: boolean): AdapterCommandOutcome {
    const row = this.rowByProviderThreadId(providerThreadId);
    if (row === undefined) {
      return errorOutcome("thread_not_found", `unknown provider thread ${providerThreadId}`);
    }
    this.updateRow(providerThreadId, { archived: archived ? 1 : 0 });
    return { ok: true, result: { archived } };
  }

  // -------------------------------------------------------------------------
  // Harness application
  // -------------------------------------------------------------------------

  /**
   * Idempotent registration of the resolved relay into the agent DO injection
   * registry (fallback key `*`; tests register exact thread keys above it).
   * Re-registers only when the non-secret relay fingerprint changes. #362:
   * the D1 provider overlay is loaded per registration attempt and its
   * content fingerprint gates the re-registration — a panel-side provider
   * edit hot-applies without a redeploy (co-hosted-isolate topology;
   * composed deployments' agent DO isolates additionally refresh
   * themselves at the turn boundary).
   */
  private async ensureAgentRuntime(): Promise<void> {
    const harness = resolveHarness(this.env);
    const overlay = await loadProviderConfigOverlay(this.env);
    const fingerprint = [
      harness.relay.mode,
      harness.relay.baseUrl,
      harness.relay.model,
      harness.relay.maxTokens,
      harness.relay.contextWindow,
      harness.relay.thinking.type,
      harness.relay.supportsImageInput,
      // #450: the D1 overlay content is the registry identity — a panel
      // provider edit re-registers the providerId-keyed rows.
      overlay?.fingerprint ?? "",
    ].join("|");
    if (this.registeredRelayFingerprint === fingerprint) return;
    // #450: the D1 overlay is the sole directory 正本 — the registry is
    // constructed over it directly (no env seed branch).
    const registry = RelayProviderRegistry.create(
      this.env,
      overlay ?? EMPTY_PROVIDER_OVERLAY,
    );
    setAgentRuntime("*", relayAgentRuntime(registry));
    this.registeredRelayFingerprint = fingerprint;
  }

  /** Row harness snapshot vs current env resolution, via the three-key rules. */
  private classifyRowDrift(row: SessionRow): "unchanged" | "live" | "session" {
    const current = harnessFromSnapshot(row.harnessJson);
    const next = projectHarness(resolveHarness(this.env));
    if (current === null) return "live";
    return classifyHarnessProjection(current, next);
  }

  // -------------------------------------------------------------------------
  // Storage + agent DO access
  // -------------------------------------------------------------------------

  /**
   * The per-thread agent DO, named by the logical thread id (#31): see the
   * class doc for why the fleet-wide DO name must be the threadId.
   */
  private agentStub(threadId: string): DurableObjectStub<AgentDO> {
    return this.env.AGENT_DO.get(
      this.env.AGENT_DO.idFromName(threadId),
    ) as unknown as DurableObjectStub<AgentDO>;
  }

  /**
   * Registry read for the composition seam (#31): the server-side bridge
   * builds turn commands against the bb AdapterCommand vocabulary, which
   * addresses the provider session by its id — this is the one lookup.
   */
  providerSessionFor(threadId: string): {
    providerThreadId: string;
    activeTurnId: string | null;
    poisoned: boolean;
  } | null {
    const row = this.rowByThreadId(threadId);
    if (row === undefined) return null;
    return {
      providerThreadId: row.providerThreadId,
      activeTurnId: row.activeTurnId,
      poisoned: row.poisoned,
    };
  }

  private rowByThreadId(threadId: string): SessionRow | undefined {
    const rows = this.ctx.storage.sql
      .exec<SessionRowDb>("SELECT * FROM provider_sessions WHERE thread_id = ?", threadId)
      .toArray();
    const row = rows[0];
    return row === undefined ? undefined : decodeRow(row);
  }

  private rowByProviderThreadId(providerThreadId: string): SessionRow | undefined {
    const rows = this.ctx.storage.sql
      .exec<SessionRowDb>(
        "SELECT * FROM provider_sessions WHERE provider_thread_id = ?",
        providerThreadId,
      )
      .toArray();
    const row = rows[0];
    return row === undefined ? undefined : decodeRow(row);
  }

  private updateRow(
    providerThreadId: string,
    patch: Partial<
      Pick<
        SessionRowDb,
        | "lifecycle"
        | "title"
        | "active_client_request_id"
        | "active_turn_id"
        | "poisoned"
        | "archived"
        | "harness_json"
      >
    >,
  ): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of Object.entries(patch)) {
      assignments.push(`${column} = ?`);
      values.push(value);
    }
    if (assignments.length === 0) return;
    assignments.push("updated_at = ?");
    values.push(Date.now(), providerThreadId);
    this.ctx.storage.sql.exec(
      `UPDATE provider_sessions SET ${assignments.join(", ")} WHERE provider_thread_id = ?`,
      ...values,
    );
  }

  private withRow(
    providerThreadId: string,
    body: (row: SessionRow) => AdapterCommandOutcome,
  ): AdapterCommandOutcome {
    const row = this.rowByProviderThreadId(providerThreadId);
    if (row === undefined) {
      return errorOutcome("thread_not_found", `unknown provider thread ${providerThreadId}`);
    }
    return body(row);
  }
}
