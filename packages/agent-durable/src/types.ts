import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { HarnessOptions, Registry } from "@earendil-works/pi-durable";

/** Everything the DO needs from the application layer; lanes B/C/D fill this in. */
export interface DurableAgentRuntime {
  /** Hot-reloadable model collection. */
  models: Models | (() => Models);
  /** Per-runtime tool registry (the cap tool set plus extensions). */
  registry: Registry;
  /** Root conversation's initial agent selection. */
  agent: {
    model: { provider: string; modelId: string };
    thinkingLevel?: ModelThinkingLevel;
  };
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Harness settings; retention defaults to 0 for 1.3.0 (see #580). */
  settings?: HarnessOptions["settings"];
}

export type DurableAgentRuntimeFactory = (
  env: unknown,
  ctx: DurableObjectState,
) => DurableAgentRuntime | Promise<DurableAgentRuntime>;
