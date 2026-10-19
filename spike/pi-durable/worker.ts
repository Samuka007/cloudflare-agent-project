// Spike #580: pi-durable 1.3.0 in a Durable Object, with a hanging tool that
// must NOT rerun after eviction. Adapted from pi-durable's test-workers/worker.ts
// (MIT) and extended with the marker tool.
import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
  Type,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

const context = BACKGROUND_CONTEXT;

/** Script steps are strict JSON so they survive eviction. */
type ScriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; id: string }
  | { kind: "hang" };
type Script = { steps: ScriptStep[]; next: number };

export const HEARTBEAT_MS = 60_000;

export class SpikeSession extends DurableObject {
  readonly #state: DurableObjectState;
  #harness!: Harness;
  /** Resolves when this instance's model request starts and hangs. */
  readonly hanging = Promise.withResolvers<void>();
  /** Resolves when the marker tool starts executing. */
  readonly toolStarted = Promise.withResolvers<void>();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#state = ctx;
    void ctx.blockConcurrencyWhile(async () => {
      // A fallback before anything can throw: an object whose open or recovery fails is started again.
      const fallback = Date.now() + HEARTBEAT_MS;
      const current = await ctx.storage.getAlarm();
      if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);

      const faux = fauxProvider();
      faux.setResponses(Array.from({ length: 8 }, () => this.#step()));
      const models = createModels();
      models.setProvider(faux.provider);

      const marker = defineTool({
        name: "marker",
        description: "Write a durable marker row and then hang until the process dies.",
        parameters: Type.Object({ label: Type.String() }),
        replay: "unsafe",
        execute: async (args, _api, _ctx) => {
          const count = this.#state.storage.kv.get<number>("markerCount") ?? 0;
          this.#state.storage.kv.put("markerCount", count + 1);
          this.#state.storage.kv.put("lastMarker", args.label);
          this.toolStarted.resolve();
          const { promise } = Promise.withResolvers<never>();
          await promise;
          return {};
        },
      });

      const registry = createRegistry();
      registry.install(defineExtension({ name: "spike", tools: [marker] }));

      this.#harness = await Harness.open(
        await openDurableObjectSqliteStorage(ctx.storage),
        {
          models,
          registry,
          // 1.3.0 arms retention timers in Workers (fixed on main, unreleased);
          // 0 keeps them from pinning the object so eviction can be tested.
          settings: { contextRetentionMs: 0, documentRetentionMs: 0 },
        },
        context,
      );
      await this.arm();
      this.#harness.resume();
    });
  }

  get harness(): Harness {
    return this.#harness;
  }

  script(steps: ScriptStep[]): void {
    this.#state.storage.kv.put("script", { steps, next: 0 } satisfies Script);
  }

  markerCount(): number {
    return this.#state.storage.kv.get<number>("markerCount") ?? 0;
  }

  async alarm(): Promise<void> {
    await this.arm();
    this.#harness.resume();
  }

  /** pi-durable 1.3.0 has no `wake()`; keep a recovery heartbeat while work may run. */
  async arm(): Promise<void> {
    await this.#state.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  async root(): Promise<Conversation> {
    return this.#harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  }

  async submit(text: string, requestId: string): Promise<void> {
    // Arm before admitting work: a process that dies after the commit is still woken.
    await this.arm();
    await (await this.root()).submit({ type: "input", content: text, requestId }, context);
  }

  /** The next scripted response; the script position is stored before the response is used. */
  #step(): FauxResponseStep {
    return (_request, options) => {
      const script = this.#state.storage.kv.get<Script>("script") ?? { steps: [], next: 0 };
      const step = script.steps[script.next];
      this.#state.storage.kv.put("script", { ...script, next: script.next + 1 });
      if (step === undefined) return fauxAssistantMessage("unscripted");
      if (step.kind === "text") return fauxAssistantMessage(step.text);
      if (step.kind === "tool") {
        return fauxAssistantMessage([fauxToolCall(step.name, step.args, { id: step.id })], {
          stopReason: "toolUse",
        });
      }
      this.hanging.resolve();
      const { promise, reject } = Promise.withResolvers<never>();
      const abort = () => reject(new DOMException("Request interrupted", "AbortError"));
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
      return promise;
    };
  }
}

export default {
  fetch: () => new Response("pi-durable spike"),
};
