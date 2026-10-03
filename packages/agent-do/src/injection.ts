import type { ModelProvider } from "./provider.js";
import type { DaemonServiceClient } from "./daemon.js";

/**
 * Runtime injection point for the two outbound seams (model relay, daemon
 * service). Cloudflare bindings cannot carry arbitrary objects into a DO
 * class, and constructor injection is unavailable on workerd-managed DOs, so
 * the deploying worker registers implementations here before traffic starts:
 *
 *   setAgentRuntime("*", { provider: relayProvider, daemon: serviceDoClient })
 *
 * Tests register per-thread mocks the same way. Key `"*"` is the fallback
 * for any thread without an exact registration.
 */

export interface AgentRuntime {
  provider: ModelProvider;
  /** Optional when the DO resolves the service via a binding instead. */
  daemon?: DaemonServiceClient;
}

const runtimes = new Map<string, AgentRuntime>();

export function setAgentRuntime(key: string, runtime: AgentRuntime): void {
  runtimes.set(key, runtime);
}

export function getAgentRuntime(threadId: string): AgentRuntime {
  const exact = runtimes.get(threadId);
  if (exact !== undefined) return exact;
  const fallback = runtimes.get("*");
  if (fallback === undefined) {
    throw new Error(
      `no agent runtime registered for thread ${threadId} (call setAgentRuntime before use)`,
    );
  }
  return fallback;
}

export function clearAgentRuntimes(): void {
  runtimes.clear();
}
