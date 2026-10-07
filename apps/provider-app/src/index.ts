/**
 * @cap/provider-app — the provider application (ticket #28): manager DO
 * (durable session registry + D1 relay registry), the edge-agent
 * ProviderAdapter over the #27 seam, and per-thread agent DO orchestration.
 */

export { ManagerDo, type ManagerDoBindings } from "./manager-do.js";
export {
  EdgeAgentProviderAdapter,
  classifyExecutionSettingsChange,
  type ManagerFacade,
} from "./adapter.js";
export {
  RELAY_FALLBACK_CONTEXT_WINDOW,
  RELAY_FALLBACK_MAX_TOKENS,
  defaultExecutionOptions,
  permissionPolicyOf,
} from "./execution-posture.js";
export {
  resolveOverlayCatalog,
  type RelayCatalogModelRow,
  type RelayCatalogProviderRow,
  type RelayCatalogResolution,
} from "./catalog.js";
export {
  RelayProviderRegistry,
  EMPTY_PROVIDER_OVERLAY,
  imageGenerationSourceFromOverlay,
  relayAgentRuntime,
  type RelayProviderOverlay,
  type RelayProviderCredential,
  type RelayProviderCredentialMap,
  type RelayProviderRegistryResolution,
} from "./relay-registry.js";
export {
  isValidProviderConfigId,
  loadProviderConfigCatalogOverlay,
  loadProviderConfigOverlay,
  type ProviderConfigCatalogOverlay,
  type ProviderConfigEnv,
  type ProviderConfigFullOverlay,
  type ProviderConfigLoad,
  type ProviderConfigRecord,
  type ToolCapabilitiesOverlayRow,
  type WebSearchFaceEngines,
  type WebSearchOverlayRow,
  type WebSearchSecretsMeta,
  type WebSearchStoredEngines,
  type WebSearchStoredSecrets,
} from "./provider-configs.js";
export { decryptProviderSecret, encryptProviderSecret } from "./provider-config-crypto.js";
export {
  ModelsYmlImportError,
  OMP_API_VOCABULARY,
  OMP_UNADMITTED_API_VALUES,
  parseModelsYml,
  type ModelsYmlImportParse,
  type ModelsYmlProviderCandidate,
  type ModelsYmlProviderSkip,
} from "./models-yml-import.js";
export { flattenPromptInputGroups } from "./flatten-input.js";

import type { ManagerFacade } from "./adapter.js";
import { EdgeAgentProviderAdapter } from "./adapter.js";

/**
 * Wiring seam for the daemon worker's `setProviderAdapter` injection: the
 * adapter delegates every stateful command to the caller's MANAGER binding.
 * The harness is resolved from the same env the binding came from, so relay
 * config, host binding, and execution defaults stay one resolution.
 */
export function createEdgeAgentAdapter(
  bindings: { MANAGER: DurableObjectNamespace },
): EdgeAgentProviderAdapter {
  const manager = bindings.MANAGER.get(
    bindings.MANAGER.idFromName("manager"),
  ) as unknown as ManagerFacade;
  return new EdgeAgentProviderAdapter(manager);
}
