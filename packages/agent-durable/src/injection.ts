import type { DurableAgentRuntime, DurableAgentRuntimeFactory } from "./types";

let factory: DurableAgentRuntimeFactory | undefined;

/** Test/entrypoint injection; production wiring lands with the server-worker route (#588). */
export function setDurableAgentRuntimeFactory(next: DurableAgentRuntimeFactory): void {
  factory = next;
}

export function resetDurableAgentRuntimeFactory(): void {
  factory = undefined;
}

/** Production default. Implemented by the provider/tool lanes; throws until then. */
export function createDurableAgentRuntime(
  _env: unknown,
  _ctx: DurableObjectState,
): Promise<DurableAgentRuntime> {
  return Promise.reject(new Error("agent-durable runtime not configured"));
}

export async function resolveDurableAgentRuntime(
  env: unknown,
  ctx: DurableObjectState,
): Promise<DurableAgentRuntime> {
  return factory === undefined ? createDurableAgentRuntime(env, ctx) : factory(env, ctx);
}
