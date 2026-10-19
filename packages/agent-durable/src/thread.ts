import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  Harness,
  type AgentEventStream,
  type Conversation,
  type SettledSubmissionRecord,
  type Submission,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { DurableAgentRuntime } from "./types.js";

const context = BACKGROUND_CONTEXT;
const PI_STORAGE_PREFIX = "pi_";

/**
 * One DO owns one Harness and one root conversation. pi-durable stores the
 * durable half; the adapter (server-worker/tools/events) holds no state that
 * cannot be rebuilt from the pi entries.
 */
export class DurableThread {
  readonly #harness: Harness;
  readonly #conversation: Conversation;

  private constructor(harness: Harness, conversation: Conversation) {
    this.#harness = harness;
    this.#conversation = conversation;
  }

  static async open(ctx: DurableObjectState, runtime: DurableAgentRuntime): Promise<DurableThread> {
    const storage = await openDurableObjectSqliteStorage(ctx.storage, {
      prefix: PI_STORAGE_PREFIX,
    });
    const models = typeof runtime.models === "function" ? runtime.models() : runtime.models;
    const harness = await Harness.open(
      storage,
      {
        models,
        registry: runtime.registry,
        now: runtime.now,
        // 1.3.0 arms retention timers in Workers (fixed on main, unreleased);
        // 0 keeps them from pinning the object (see #580).
        settings: {
          contextRetentionMs: 0,
          documentRetentionMs: 0,
          ...runtime.settings,
        },
      },
      context,
    );
    const conversation = await harness.root(context, { agent: runtime.agent });
    return new DurableThread(harness, conversation);
  }

  /** 1.3.0 has no `wake()`; the heartbeat alarm calls this. */
  resume(): void {
    this.#harness.resume();
  }

  async submit(text: string, requestId: string, whenBusy?: "steer" | "followUp"): Promise<void> {
    await this.#conversation.submit(
      {
        type: "input",
        content: text,
        requestId,
        ...(whenBusy === undefined ? {} : { whenBusy }),
      },
      context,
    );
  }

  /**
   * Re-submitting with the same request id is idempotent: after an eviction it
   * reacquires the admitted submission instead of admitting a second one.
   */
  async wait(requestId: string, text: string): Promise<SettledSubmissionRecord> {
    const submission: Submission = await this.#conversation.submit(
      { type: "input", content: text, requestId },
      context,
    );
    return submission.wait(context);
  }

  async abort(): Promise<void> {
    await this.#conversation.abort(context);
  }

  async compact(): Promise<string> {
    return String(await this.#conversation.compact(undefined, context));
  }

  async configure(agent: {
    model: { provider: string; modelId: string };
    thinkingLevel?: ModelThinkingLevel;
  }): Promise<void> {
    await this.#conversation.configure(agent, context);
  }

  conversation(): Conversation {
    return this.#conversation;
  }

  async watch(): Promise<AgentEventStream> {
    return watchEvents(this.#harness, this.#conversation.id, context);
  }

  async close(): Promise<void> {
    await this.#harness.close(context);
  }
}
