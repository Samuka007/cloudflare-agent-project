import type { AgentRuntime } from "../injection.js";
import { SYNTHETIC_RELAY_PROVIDER_ID } from "../provider-catalog.js";
import type { ModelProvider } from "../provider.js";

/**
 * #496 runtime shape for mock rigs: dispatch always goes through the
 * resolver (the deployment-default `provider` registration member is
 * retired), and the legacy materializer hands out the mock row so a send
 * without an explicit ride still journals a selection. The resolver ignores
 * the selection — single-provider rigs dispatch everything through the mock.
 */
export function mockAgentRuntime(provider: ModelProvider): AgentRuntime {
  return {
    resolveExecutionProvider: () => provider,
    materializeLegacySelection: () => ({
      providerId: SYNTHETIC_RELAY_PROVIDER_ID,
      model: "mock-model",
    }),
  };
}
