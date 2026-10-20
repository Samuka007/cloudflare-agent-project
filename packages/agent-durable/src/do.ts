import { DurableObject } from "cloudflare:workers";
import type { DaemonThreadEventInput, PromptContent, ThreadEventEnvelope } from "@cap/protocol";
import type { Conversation, SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { PiEventBridge } from "./events";
import { resolveDurableAgentRuntime } from "./injection";
import { DurableEventSink } from "./journal";
import { foldPendingBadge, type PendingBadgeState } from "./pending";
import { DurableThread } from "./thread";
import type { HostExecutionUpdate } from "./tools";
import type { DurableAgentRuntime } from "./types";
import { foldCapRung } from "./provider";

export const HEARTBEAT_MS = 60_000;

/**
 * Journal sink that re-derives the pending badge state after every append
 * (#591 T8): interaction flips can land through any append path (the pi
 * bridge today, the ask channel's rows later), so the fold trigger rides the
 * sink instead of each call site.
 */
class PendingWatchSink extends DurableEventSink {
  readonly #onAppend: () => void;

  constructor(storage: DurableObjectStorage, threadId: string, onAppend: () => void) {
    super(storage, threadId);
    this.#onAppend = onAppend;
  }

  override async append(input: DaemonThreadEventInput): Promise<ThreadEventEnvelope> {
    const envelope = await super.append(input);
    this.#onAppend();
    return envelope;
  }
}

export type DurableAgentEnv = Record<string, unknown> & {
  readonly HUB?: DurableObjectNamespace;
};

export interface DurableExecutionSelection {
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
}

function promptText(content: readonly PromptContent[]): string {
  const parts: string[] = [];
  let omitted = 0;
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
    } else {
      omitted += 1;
    }
  }
  // The durable Harness takes text. The full union still lands in the
  // journal (userMessage content); the model-facing leg names the omission
  // instead of silently pretending the attachment was read.
  if (omitted > 0) {
    parts.push(`[${String(omitted)} non-text attachment(s) omitted: this runtime is text-only]`);
  }
  return parts.join("\n");
}

/**
 * The one agent runtime: one DO = one thread's pi-durable Harness. The
 * legacy AgentDO, provider manager, and host orchestrator are deleted.
 */
export class DurableAgentDO extends DurableObject<DurableAgentEnv> {
  #thread!: DurableThread;
  #runtime!: DurableAgentRuntime;
  #sink: DurableEventSink | undefined;
  #bridge: PiEventBridge | undefined;
  #hub: DurableObjectNamespace | undefined;
  #threadId: string | undefined;
  #watchStarted = false;
  #watchReady: Promise<void> | undefined;
  #turnOrdinal = 0;
  #currentTurnId: string | undefined;
  #created = false;
  #pendingBadge: PendingBadgeState | undefined;

  constructor(ctx: DurableObjectState, env: DurableAgentEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      // Fallback before anything can throw: an object whose open fails is started again.
      await ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
      this.#runtime = await this.createRuntime(env, ctx);
      this.#hub = env.HUB;
      this.#thread = await DurableThread.open(ctx, this.#runtime);
      this.#turnOrdinal = ctx.storage.kv.get<number>("turnOrdinal") ?? 0;
      this.#currentTurnId = ctx.storage.kv.get<string>("currentTurnId");
      this.#created = ctx.storage.kv.get<boolean>("threadCreated") ?? false;
      const threadId = ctx.storage.kv.get<string>("threadId");
      if (threadId !== undefined) this.#journal(threadId);
      await this.#watchReady;
      this.#thread.resume();
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    this.#thread.resume();
  }

  /**
   * Subclass seam (#623): the runtime caches the provider catalog built at DO
   * init; a row write must reach the next dispatch. The production override
   * fingerprints the D1 catalog and calls `swapRuntime` on a mismatch —
   * synchronously inside the dispatching RPC, so a PATCH followed by an
   * immediate send observes the new projection (or fails loudly while the
   * catalog is unreadable, never silently routes the old one).
   */
  protected async refreshRuntimeBeforeDispatch(
    _env: DurableAgentEnv,
    _ctx: DurableObjectState,
  ): Promise<void> {
    // Default deployments own their catalog for the DO's lifetime; only
    // overlay-backed deployments override this. Non-empty keeps lint honest.
    return Promise.resolve();
  }

  /** Rebuild the runtime and reopen the thread over the same storage. */
  protected async swapRuntime(env: DurableAgentEnv, ctx: DurableObjectState): Promise<void> {
    // Release the old harness's storage writer first: two live harnesses over
    // one sqlite backend collide on entry ids.
    await this.#thread.close();
    this.#runtime = await this.createRuntime(env, ctx);
    this.#thread = await DurableThread.open(ctx, this.#runtime);
    // The journal watcher is bound to the old harness's event stream; the
    // sink/bridge are storage-backed and carry over untouched. Re-attach the
    // watch to the new thread and resume its pending work.
    this.#watchStarted = false;
    this.#watchReady = undefined;
    if (this.#threadId !== undefined) {
      this.#watchReady = this.#attachWatcher();
      await this.#watchReady;
      this.#thread.resume();
    }
  }

  async createThread(args: {
    threadId: string;
    title: string;
    machineId?: string;
    execution?: DurableExecutionSelection;
  }): Promise<{ threadId: string; duplicated: boolean }> {
    await this.refreshRuntimeBeforeDispatch(this.env, this.ctx);
    const duplicated = this.#created;
    if (!duplicated) {
      this.#journal(args.threadId);
      await this.#watchReady;
      this.ctx.storage.kv.put("threadId", args.threadId);
      this.ctx.storage.kv.put("machineId", args.machineId ?? "");
      const sink = this.#sink;
      if (sink === undefined) throw new Error("journal not initialized");
      await sink.append({
        id: `thread-start-${args.threadId}`,
        threadId: args.threadId,
        type: "client/thread/start",
        data: {
          title: args.title,
          ...(args.machineId === undefined ? {} : { machineId: args.machineId }),
          ...(args.execution === undefined ? {} : { execution: args.execution }),
        },
        createdAt: Date.now(),
      });
      this.#created = true;
      this.ctx.storage.kv.put("threadCreated", true);
    }
    await this.#applyExecution(args.execution);
    return { threadId: args.threadId, duplicated };
  }

  async rebindThread(args: { machineId: string; environmentId?: string }): Promise<{
    machineId: string;
    duplicated: boolean;
  }> {
    const previous = this.ctx.storage.kv.get<string>("machineId");
    this.ctx.storage.kv.put("machineId", args.machineId);
    if (args.environmentId !== undefined) {
      this.ctx.storage.kv.put("environmentId", args.environmentId);
    }
    const threadId = this.ctx.storage.kv.get<string>("threadId");
    const sink = this.#sink;
    if (threadId !== undefined && sink !== undefined && previous !== args.machineId) {
      await sink.append({
        id: `thread-rebound-${threadId}-${args.machineId}`,
        threadId,
        type: "thread/rebound",
        data: {
          machineId: args.machineId,
          ...(args.environmentId === undefined ? {} : { environmentId: args.environmentId }),
        },
        createdAt: Date.now(),
      });
    }
    return { machineId: args.machineId, duplicated: previous === args.machineId };
  }

  async sendMessage(args: {
    clientRequestId: string;
    content: readonly PromptContent[];
    mode: "auto" | "start" | "steer";
    execution?: DurableExecutionSelection;
  }): Promise<{ turnId: string; steer: boolean; duplicated: boolean }> {
    const threadId = this.ctx.storage.kv.get<string>("threadId");
    if (threadId === undefined) throw new Error("thread_not_created");
    const existing = this.ctx.storage.kv.get<string>(`request:${args.clientRequestId}`);
    if (existing !== undefined) {
      return { turnId: existing, steer: args.mode === "steer", duplicated: true };
    }
    await this.refreshRuntimeBeforeDispatch(this.env, this.ctx);
    const steer = args.mode === "steer";
    let turnId = this.#currentTurnId;
    if (!steer) {
      this.#turnOrdinal += 1;
      turnId = `turn-${threadId}-${this.#turnOrdinal}`;
      this.#currentTurnId = turnId;
      this.ctx.storage.kv.put("turnOrdinal", this.#turnOrdinal);
      this.ctx.storage.kv.put("currentTurnId", turnId);
    }
    if (turnId === undefined) throw new Error("steer_without_active_turn");
    await this.#watchReady;
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    await this.#applyExecution(args.execution);
    const sink = this.#sink;
    if (sink === undefined) throw new Error("journal not initialized");
    await sink.append({
      id: `pi-user-${args.clientRequestId}`,
      threadId,
      type: "item/started",
      data: {
        turnId,
        item: {
          type: "userMessage",
          id: `itm-um-${args.clientRequestId}`,
          content: args.content,
        },
      },
      createdAt: Date.now(),
    });
    await this.#thread.submit(
      promptText(args.content),
      args.clientRequestId,
      steer ? "steer" : undefined,
    );
    this.ctx.storage.kv.put(`request:${args.clientRequestId}`, turnId);
    return { turnId, steer, duplicated: false };
  }

  getEvents(args: {
    sinceSeq: number;
    limit?: number;
    project?: "raw" | "ux";
    window?: { beforeSeq?: number };
  }): Promise<{
    events: ThreadEventEnvelope[];
    latestSeq: number;
    window?: {
      windowStartSeq: number;
      floorSeq: number;
      dataBytes: number;
      hasOlderRows: boolean;
    };
  }> {
    const sink = this.#sink;
    if (sink === undefined) return Promise.resolve({ events: [], latestSeq: 0 });
    const limit = args.limit ?? 1000;
    const events =
      args.window?.beforeSeq === undefined
        ? sink.read(args.sinceSeq, limit)
        : sink.readBefore(args.window.beforeSeq, limit);
    const firstSeq = events[0]?.seq ?? 0;
    return Promise.resolve({
      events,
      latestSeq: sink.latestSeq(),
      window: {
        windowStartSeq: firstSeq,
        floorSeq: firstSeq,
        dataBytes: events.reduce((total, event) => total + JSON.stringify(event.data).length, 0),
        hasOlderRows: firstSeq > 1,
      },
    });
  }

  listInteractions(): Promise<{ interactions: [] }> {
    return Promise.resolve({ interactions: [] });
  }

  resolveInteraction(_args: {
    interactionId: string;
    resolution: unknown;
  }): Promise<{ accepted: boolean; duplicated: boolean }> {
    return Promise.resolve({ accepted: false, duplicated: false });
  }

  async cancelTurn(_args: { turnId: string }): Promise<{ accepted: boolean }> {
    await this.#thread.abort();
    return { accepted: true };
  }

  async compactThread(_args: {
    clientRequestId?: string;
    mode?: "soft" | "remote" | "snap";
    remote?: { providerId: string; model: string };
  }): Promise<{ turnId: string; duplicated: boolean }> {
    return { turnId: await this.#thread.compact(), duplicated: false };
  }

  async submit(text: string, requestId: string, whenBusy?: "steer" | "followUp"): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    await this.#thread.submit(text, requestId, whenBusy);
  }

  async wait(requestId: string, text: string): Promise<SettledSubmissionRecord> {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    return this.#thread.wait(requestId, text);
  }

  async abort(): Promise<void> {
    return this.#thread.abort();
  }

  root(): Conversation {
    return this.#thread.conversation();
  }

  onExecutionUpdate(update: {
    executionId: string;
    kind: "started" | "output" | "exited";
    [key: string]: unknown;
  }): Promise<{ duplicate: boolean; acked: boolean }> {
    this.#runtime.hostTools?.onUpdate(update as unknown as HostExecutionUpdate);
    return Promise.resolve({ duplicate: false, acked: false });
  }

  /** Production subclass hook; tests inject through the module factory. */
  protected async createRuntime(
    env: DurableAgentEnv,
    ctx: DurableObjectState,
  ): Promise<DurableAgentRuntime> {
    return resolveDurableAgentRuntime(env, ctx);
  }

  /**
   * Direct journal append for rows whose producers arrive with later tickets
   * (the ask channel's interaction flips). Goes through the same sink as
   * every other append, so the badge fold sees it.
   */
  protected async appendJournalRow(
    input: Omit<DaemonThreadEventInput, "threadId">,
  ): Promise<ThreadEventEnvelope> {
    const sink = this.#sink;
    const threadId = this.#threadId;
    if (sink === undefined || threadId === undefined) throw new Error("journal not initialized");
    return sink.append({ ...input, threadId });
  }

  async #applyExecution(execution: DurableExecutionSelection | undefined): Promise<void> {
    if (execution?.providerId === undefined || execution.model === undefined) return;
    const thinkingLevel =
      execution.reasoningLevel === undefined ? undefined : foldCapRung(execution.reasoningLevel);
    await this.#thread.configure({
      model: { provider: execution.providerId, modelId: execution.model },
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    });
  }

  #journal(threadId: string): void {
    if (this.#sink !== undefined) return;
    this.#threadId = threadId;
    this.#sink = new PendingWatchSink(this.ctx.storage, threadId, () => {
      this.#syncPendingBadge();
    });
    this.#bridge = new PiEventBridge({
      threadId,
      sink: this.#sink,
      initialTurnOrdinal: this.#turnOrdinal,
      ...(this.#currentTurnId === undefined ? {} : { initialTurnId: this.#currentTurnId }),
    });
    this.#watchReady = this.#attachWatcher();
    // Rehydrate fold: a replayed journal re-derives the same badge state; the
    // control-plane CAS turns the re-push into a no-op.
    this.#syncPendingBadge();
  }

  /**
   * #591 T8 pending push-write: fold the journal's interaction rows and push
   * the badge state through the typed runtime seam. The in-memory watermark
   * skips re-pushes of an already-pushed fold position; a push that does
   * leave (DO replay after eviction) re-derives the identical
   * (pendingSince, foldSeq) pair and the control-plane monotonic CAS lands
   * it nowhere — a replay never rewrites the threads row. Best-effort: a
   * failed push never fails the append that triggered it.
   */
  #syncPendingBadge(): void {
    const sink = this.#sink;
    const threadId = this.#threadId;
    const pusher = this.#runtime.pendingState;
    if (sink === undefined || threadId === undefined || pusher === undefined) return;
    const next = foldPendingBadge(sink.readInteractionRows());
    if (next === null || next.foldSeq === this.#pendingBadge?.foldSeq) return;
    this.#pendingBadge = next;
    this.ctx.waitUntil(
      pusher
        .push({ threadId, pendingSince: next.pendingSince, foldSeq: next.foldSeq })
        .catch((error: unknown) => {
          console.error("pending badge push failed", error);
        }),
    );
  }

  #attachWatcher(): Promise<void> {
    if (this.#watchStarted) return this.#watchReady ?? Promise.resolve();
    this.#watchStarted = true;
    return this.#thread
      .watch()
      .then((stream) => {
        stream.start(async (events) => {
          try {
            const appended = await this.#bridge?.ingest(events);
            if (appended !== undefined && appended.length > 0) this.#notifyHub(appended);
          } catch (error) {
            console.error("pi event bridge failed", error);
          }
        });
      })
      .catch((error: unknown) => {
        console.error("watchEvents failed", error);
      });
  }

  #notifyHub(appended: readonly ThreadEventEnvelope[]): void {
    const hub = this.#hub;
    const threadId = this.#threadId;
    if (hub === undefined || threadId === undefined) return;
    const latestSeq = appended[appended.length - 1]?.seq ?? 0;
    const eventTypes = [...new Set(appended.map((event) => event.type))];
    const stub = hub.get(hub.idFromName("hub")) as unknown as {
      notifyThread(
        threadId: string,
        changes: string[],
        metadata?: { latestSeq?: number; eventTypes?: string[] },
      ): Promise<void>;
    };
    this.ctx.waitUntil(
      stub
        .notifyThread(threadId, ["events-appended"], { latestSeq, eventTypes })
        .catch((error: unknown) => {
          console.error("durable hub notify failed", error);
        }),
    );
  }
}
