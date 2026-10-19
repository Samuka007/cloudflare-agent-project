import { DurableObject } from "cloudflare:workers";
import type { PromptContent, ThreadEventEnvelope } from "@cap/protocol";
import type { Conversation, SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { PiEventBridge } from "./events.js";
import { resolveDurableAgentRuntime } from "./injection.js";
import { DurableEventSink } from "./journal.js";
import { DurableThread } from "./thread.js";
import type { HostExecutionUpdate } from "./tools.js";
import type { DurableAgentRuntime } from "./types.js";
import { foldCapRung } from "./provider.js";

export const HEARTBEAT_MS = 60_000;

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
  for (const part of content) {
    if (part.type !== "text") {
      throw new Error(
        `unsupported_prompt_content: durable runtime accepts text only (${part.type})`,
      );
    }
    parts.push(part.text);
  }
  return parts.join("\n");
}

/**
 * Additive runtime (#581): one DO = one thread's Harness. The legacy
 * `packages/agent-do` DO stays in service; new threads route here behind
 * `AGENT_RUNTIME=durable` once the server-worker lane lands.
 */
export class DurableAgentDO extends DurableObject<DurableAgentEnv> {
  #thread!: DurableThread;
  #runtime!: DurableAgentRuntime;
  #sink: DurableEventSink | undefined;
  #bridge: PiEventBridge | undefined;
  #hub: DurableObjectNamespace | undefined;
  #threadId: string | undefined;
  #watchStarted = false;
  #turnOrdinal = 0;
  #currentTurnId: string | undefined;
  #created = false;

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
      this.#thread.resume();
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    this.#thread.resume();
  }

  async createThread(args: {
    threadId: string;
    title: string;
    machineId?: string;
    execution?: DurableExecutionSelection;
  }): Promise<{ threadId: string; duplicated: boolean }> {
    const duplicated = this.#created;
    if (!duplicated) {
      this.#journal(args.threadId);
      this.ctx.storage.kv.put("threadId", args.threadId);
      this.ctx.storage.kv.put("machineId", args.machineId ?? "");
      const sink = this.#sink;
      if (sink === undefined) throw new Error("journal not initialized");
      await sink.append({
        id: `thread-start-${args.threadId}`,
        threadId: args.threadId,
        type: "client/thread/start",
        data: { title: args.title },
        createdAt: Date.now(),
      });
      this.#created = true;
      this.ctx.storage.kv.put("threadCreated", true);
    }
    await this.#applyExecution(args.execution);
    return { threadId: args.threadId, duplicated };
  }

  rebindThread(args: { machineId: string; environmentId?: string }): Promise<{
    machineId: string;
    duplicated: boolean;
  }> {
    return Promise.resolve({ machineId: args.machineId, duplicated: false });
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
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    await this.#applyExecution(args.execution);
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
  }): Promise<{ events: ThreadEventEnvelope[]; latestSeq: number }> {
    const sink = this.#sink;
    if (sink === undefined) return Promise.resolve({ events: [], latestSeq: 0 });
    return Promise.resolve({
      events: sink.read(args.sinceSeq, args.limit ?? 1000),
      latestSeq: sink.latestSeq(),
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
    this.#sink = new DurableEventSink(this.ctx.storage.sql, threadId);
    this.#bridge = new PiEventBridge({ threadId, sink: this.#sink });
    this.#attachWatcher();
  }

  #attachWatcher(): void {
    if (this.#watchStarted) return;
    this.#watchStarted = true;
    void this.#thread
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
