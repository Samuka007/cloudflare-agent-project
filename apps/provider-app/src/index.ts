/**
 * @cap/provider-app — provider configuration domain: the D1
 * provider_configs overlay loader, catalog projection, models.yml import,
 * and the crypto seam. The legacy provider session manager / relay registry
 * is deleted; model dispatch belongs to the pi-durable runtime.
 */

export {
  resolveOverlayCatalog,
  type RelayCatalogModelRow,
  type RelayCatalogProviderRow,
  type RelayCatalogResolution,
} from "./catalog";
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
} from "./provider-configs";
export { decryptProviderSecret, encryptProviderSecret } from "./provider-config-crypto";
export {
  ModelsYmlImportError,
  OMP_API_VOCABULARY,
  OMP_UNADMITTED_API_VALUES,
  parseModelsYml,
  type ModelsYmlImportParse,
  type ModelsYmlProviderCandidate,
  type ModelsYmlProviderSkip,
} from "./models-yml-import";
