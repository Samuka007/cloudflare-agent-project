import type { AgentRuntime } from "../injection.js";
import type { ModelProvider } from "../provider.js";

/**
 * #496 runtime shape for mock rigs: dispatch always goes through the
 * resolver (the deployment-default `provider` registration member is
 * retired, and the DO never materializes a selection — rigs pin their row
 * explicitly at create, e.g. via the test rig helper). The resolver ignores
 * the selection — single-provider rigs dispatch everything through the mock.
 */
export function mockAgentRuntime(provider: ModelProvider): AgentRuntime {
  return {
    resolveExecutionProvider: () => provider,
  };
}
