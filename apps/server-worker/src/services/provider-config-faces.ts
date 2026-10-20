import {
  assembleProviderConfigLoad,
  type ProviderConfigCatalogOverlay,
  type ProviderConfigRecord,
  type ProviderConfigRawLoad,
  type ProviderConfigRawRow,
  type WebSearchDecodedHalf,
} from "@cap/provider-app";
import { createProviderConfigsRepository, createSettingsRepository } from "../db/repositories";
import type { Env } from "../env";

/**
 * The T6 route-face loader (#598, db campaign): the drizzle-era successor of
 * provider-app's D1 overlay loader for the /system provider+settings faces.
 * It composes the T4 repositories (env.DB_V2) and feeds the shared
 * provider-app assembler — the ONE decode home for row records, the effective
 * catalog, the web-search halves, and the content fingerprint — so the route
 * faces see exactly the shapes the legacy loader served, minus anything only
 * the dispatch half needs:
 *
 * - zero ciphertext crosses this seam (hasCredential presence only), so the
 *   catalog faces stay zero-secret by construction;
 * - `webSearchConfig` stays null (the decrypt-half config): the web-search
 *   PUT merges from the RAW decoded half instead — the stored row passed the
 *   same resolveWebSearchConfig validation, so raw values are the resolved
 *   ones;
 * - web-search row `updatedAt` is unknown at the seam (the repository state
 *   carries no timestamp), so the fingerprint's web-search leg pins 0 — the
 *   fingerprint is a change signal, never a cross-path comparable value.
 *
 * The AGENT DO's dispatch half (provider credentials, decrypted engine
 * config) keeps reading the legacy loader until the typed-client cutover
 * (#599, T7); the legacy module itself retires with the old tables (T9).
 */

/** The route faces' slice of a load: CRUD rows + catalog overlay. */
export interface ProviderConfigFacesLoad {
  rows: ProviderConfigRecord[];
  catalog: ProviderConfigCatalogOverlay;
  /**
   * The decoded web-search half the PUT's tri-state merge reads (absent =
   * null; the loud decodeError posture is visible on catalog.webSearch).
   */
  webSearchHalf: ProviderConfigFacesWebSearchHalf | null;
  warnings: string[];
}

/** The raw web-search half the PUT's tri-state merge reads (may be null). */
export type ProviderConfigFacesWebSearchHalf = WebSearchDecodedHalf;

/** Read + assemble everything the /system provider+settings faces need. */
export async function loadProviderConfigFaces(env: Env): Promise<ProviderConfigFacesLoad> {
  const settings = createSettingsRepository(env.DB_V2, env.PROVIDER_CONFIG_MASTER_KEY);
  const configs = createProviderConfigsRepository(env.DB_V2, env.PROVIDER_CONFIG_MASTER_KEY);
  const [storedRows, imageSourceProviderId, toolCapabilities, webSearchState] = await Promise.all([
    configs.list(),
    settings.getImageSourceProviderId(),
    settings.getToolCapabilities(),
    settings.getWebSearchConfig(),
  ]);
  const rawRows: ProviderConfigRawRow[] = storedRows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    api: row.api,
    serviceTier: row.serviceTier,
    hasCredential: row.hasCredential,
    models: row.models,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  // Absent half (configured:false) = the ruled-default posture; a decode
  // error rides the half and the assembler serves the loud posture.
  const webSearch: WebSearchDecodedHalf | null = webSearchState.configured
    ? {
        configured: true,
        decodeError: webSearchState.decodeError,
        chain: webSearchState.chain,
        timeoutSeconds: webSearchState.timeoutSeconds,
        engines: webSearchState.engines,
        secrets: webSearchState.secrets,
        secretsMeta: webSearchState.secretsMeta,
        updatedAt: 0,
      }
    : null;
  const raw: ProviderConfigRawLoad = {
    rows: rawRows,
    imageSourceProviderId,
    toolCapabilities,
    webSearch,
  };
  const load = await assembleProviderConfigLoad(raw, {
    decrypt: false,
    masterKey: env.PROVIDER_CONFIG_MASTER_KEY,
  });
  return {
    rows: load.rows,
    catalog: load.catalog,
    webSearchHalf: webSearch,
    warnings: load.warnings,
  };
}
