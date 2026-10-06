/**
 * @cap/provider-app — the provider application (ticket #28): manager DO
 * (durable session registry + harness minimal three keys), the edge-agent
 * ProviderAdapter over the #27 seam, and per-thread agent DO orchestration.
 */

export { ManagerDo, type ManagerDoBindings } from "./manager-do.js";
export {
  EdgeAgentProviderAdapter,
  classifyExecutionSettingsChange,
  type ManagerFacade,
} from "./adapter.js";
export {
  FixedReplyProvider,
  HARNESS_DEFAULTS,
  classifyHarnessProjection,
  harnessFromSnapshot,
  projectHarness,
  relayProviderFrom,
  resolveHarness,
  snapshotHarness,
} from "./harness.js";
export type { HarnessEnv, HarnessProjection, ResolvedHarness, ThinkingConfig } from "./harness.js";
export {
  resolveRelayCatalog,
  resolveRelayCatalogWithOverlay,
  type RelayCatalogModelRow,
  type RelayCatalogProviderRow,
  type RelayCatalogResolution,
} from "./catalog.js";
export {
  RelayProviderRegistry,
  decodeRelayProviderCredentials,
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
} from "./provider-configs.js";
export {
  decryptProviderSecret,
  encryptProviderSecret,
} from "./provider-config-crypto.js";
export { flattenPromptInputGroups } from "./flatten-input.js";

import type { ManagerDoBindings } from "./manager-do.js";
import type { ManagerFacade } from "./adapter.js";
import { EdgeAgentProviderAdapter } from "./adapter.js";
import { resolveHarness } from "./harness.js";

/**
 * Wiring seam for the daemon worker's `setProviderAdapter` injection: the
 * adapter delegates every stateful command to the caller's MANAGER binding.
 * The harness is resolved from the same env the binding came from, so relay
 * config, host binding, and execution defaults stay one resolution.
 */
export function createEdgeAgentAdapter(
  bindings: ManagerDoBindings & { MANAGER: DurableObjectNamespace },
): EdgeAgentProviderAdapter {
  const manager = bindings.MANAGER.get(
    bindings.MANAGER.idFromName("manager"),
  ) as unknown as ManagerFacade;
  return new EdgeAgentProviderAdapter(manager, resolveHarness(bindings));
}
