import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { HarnessOptions, Registry } from "@earendil-works/pi-durable";
import type { PendingBadgePush } from "./pending";
import type { HostExecutionUpdate } from "./tools";

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
  /** Host-tool update sink (#586); the DO forwards daemon frames here. */
  hostTools?: { onUpdate(update: HostExecutionUpdate): void };
  /**
   * #591 db campaign T8: the control-plane pending-badge push seam. The DO
   * folds its journal's interaction rows and pushes flips; the server side
   * applies the monotonic CAS (a replayed fold lands nowhere). Runtimes
   * without a control-plane badge (unit harnesses) omit it and the DO never
   * pushes.
   */
  pendingState?: { push(push: PendingBadgePush): Promise<void> };
}

export type DurableAgentRuntimeFactory = (
  env: unknown,
  ctx: DurableObjectState,
) => DurableAgentRuntime | Promise<DurableAgentRuntime>;
