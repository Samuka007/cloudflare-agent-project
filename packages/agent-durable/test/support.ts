import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  type JsonObject,
} from "@earendil-works/pi-durable";
import type { PendingBadgePush } from "../src/pending";
import type { DurableAgentRuntime } from "../src/types";

export type TestScriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: JsonObject; id: string }
  | { kind: "hang" };

interface TestScript {
  steps: TestScriptStep[];
  next: number;
}

export interface TestState {
  markerCount: number;
  toolStarted: boolean;
  hanging: boolean;
}

export const TEST_KEYS = {
  script: "testScript",
  markerCount: "markerCount",
  toolStarted: "toolStarted",
  hanging: "testHanging",
  pendingPushes: "testPendingPushes",
} as const;

export function writeScript(ctx: DurableObjectState, steps: TestScriptStep[]): void {
  ctx.storage.kv.put(TEST_KEYS.script, { steps, next: 0 } satisfies TestScript);
}

function readMarkerCount(ctx: DurableObjectState): number {
  return ctx.storage.kv.get<number>(TEST_KEYS.markerCount) ?? 0;
}

function markerStarted(ctx: DurableObjectState): boolean {
  return ctx.storage.kv.get<boolean>(TEST_KEYS.toolStarted) ?? false;
}

function requestHanging(ctx: DurableObjectState): boolean {
  return ctx.storage.kv.get<boolean>(TEST_KEYS.hanging) ?? false;
}

/** Pending-badge pushes recorded by the test runtime's push seam (kv-backed,
 * so the log survives an eviction and reads after the replay). */
export function readPendingPushes(ctx: DurableObjectState): PendingBadgePush[] {
  return ctx.storage.kv.get<PendingBadgePush[]>(TEST_KEYS.pendingPushes) ?? [];
}

export function readTestState(ctx: DurableObjectState): TestState {
  return {
    markerCount: readMarkerCount(ctx),
    toolStarted: markerStarted(ctx),
    hanging: requestHanging(ctx),
  };
}

function nextStep(ctx: DurableObjectState): FauxResponseStep {
  return (_request, options) => {
    const script = ctx.storage.kv.get<TestScript>(TEST_KEYS.script) ?? { steps: [], next: 0 };
    const step = script.steps[script.next];
    ctx.storage.kv.put(TEST_KEYS.script, { ...script, next: script.next + 1 });
    if (step === undefined) return fauxAssistantMessage("unscripted");
    if (step.kind === "text") return fauxAssistantMessage(step.text);
    if (step.kind === "tool") {
      return fauxAssistantMessage([fauxToolCall(step.name, step.args, { id: step.id })], {
        stopReason: "toolUse",
      });
    }
    ctx.storage.kv.put(TEST_KEYS.hanging, true);
    const { promise, reject } = Promise.withResolvers<never>();
    const abort = () => {
      reject(new DOMException("Request interrupted", "AbortError"));
    };
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    return promise;
  };
}

export function createTestRuntime(ctx: DurableObjectState): DurableAgentRuntime {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 16 }, () => nextStep(ctx)));
  const models = createModels();
  models.setProvider(faux.provider);

  const marker = defineTool({
    name: "marker",
    description: "Write a durable marker row and then hang until the process dies.",
    parameters: Type.Object({ label: Type.String() }),
    replay: "unsafe",
    execute: async () => {
      const count = readMarkerCount(ctx);
      ctx.storage.kv.put(TEST_KEYS.markerCount, count + 1);
      ctx.storage.kv.put(TEST_KEYS.toolStarted, true);
      const { promise } = Promise.withResolvers<never>();
      await promise;
      return {};
    },
  });

  const registry = createRegistry();
  registry.install(defineExtension({ name: "test", tools: [marker] }));
  // Concurrent pushes (registered + resolved inside one turn) serialize here
  // so the kv log records them in flip order instead of racing a
  // read-modify-write.
  let pushChain: Promise<void> = Promise.resolve();

  return {
    models,
    registry,
    agent: { model: { provider: "faux", modelId: "faux-1" } },
    pendingState: {
      push: (push: PendingBadgePush) => {
        pushChain = pushChain.then(() => {
          const log = readPendingPushes(ctx);
          log.push(push);
          ctx.storage.kv.put(TEST_KEYS.pendingPushes, log);
        });
        return pushChain;
      },
    },
  };
}
