import type { ModelProvider } from "./provider.js";
import type { DaemonServiceClient } from "./daemon.js";
import type { RelaySelection } from "./provider-catalog.js";

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
  /**
   * #351 journal-selection dispatch: resolves a thread/turn's explicit
   * execution selection (providerId/model/reasoningLevel) onto the
   * providerId-keyed relay registry the deploying worker built. Absent
   * (single-provider deployments, test rigs) → every turn dispatches
   * `provider`, exactly the pre-#351 single-line registration posture.
   * Resolvers MUST fail closed (RelaySelectionError) on catalog drift —
   * never silently re-route onto another row.
   */
  resolveExecutionProvider?: (selection: RelaySelection) => ModelProvider;
  /**
   * #362 hot-reload seam: the deploying worker may re-read mutable provider
   * configuration (the D1 provider overlay) at the turn boundary — the DO
   * awaits it once per driveTurn before the first dispatch. Optional and
   * best-effort: a failed refresh leaves the last-known registration in
   * place (a config read must never kill a turn).
   */
  refreshRuntime?: () => Promise<void>;
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
