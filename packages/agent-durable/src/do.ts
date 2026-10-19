import { DurableObject } from "cloudflare:workers";
import type { Conversation, SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { resolveDurableAgentRuntime } from "./injection.js";
import { DurableThread } from "./thread.js";

export const HEARTBEAT_MS = 60_000;

export type DurableAgentEnv = Record<string, unknown>;

/**
 * Additive runtime (#581): one DO = one thread's Harness. The legacy
 * `packages/agent-do` DO stays in service; new threads route here behind
 * `AGENT_RUNTIME=durable` once the server-worker lane lands.
 */
export class DurableAgentDO extends DurableObject<DurableAgentEnv> {
  #thread!: DurableThread;

  constructor(ctx: DurableObjectState, env: DurableAgentEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      // Fallback before anything can throw: an object whose open fails is started again.
      await ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
      const runtime = await resolveDurableAgentRuntime(env, ctx);
      this.#thread = await DurableThread.open(ctx, runtime);
      this.#thread.resume();
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    this.#thread.resume();
  }

  /** Arm before admitting work: a process that dies after the commit is still woken. */
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
}
