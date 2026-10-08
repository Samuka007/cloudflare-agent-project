import {
  DEFAULT_RELAY_API,
  IMAGE_SOURCE_API_FAMILY,
  type RelayApi,
  type RelayCatalogProvider,
  relayReasoningLadder,
  type RelayModelThinking,
  type RelayReasoningLevel,
} from "@cap/agent-do";

/**
 * Relay catalog resolution (#350 → #450) — the D1 provider-config 正本
 * (provider_configs rows, the panel's CRUD face) projected into the read
 * faces: GET /system/execution-options (server routes/system.ts), the
 * provider-projections catalog row, and the project execution defaults
 * (routes/projects.ts). One resolution, several projections — the #319
 * dual-face pattern generalized to the catalog layer (roadmap §0.1/§2.3).
 *
 * Same-source stays by construction: the resolution is a pure projection of
 * the same D1 rows the dispatch registry resolves against — the picker face
 * and the turns-actually-run truth cannot disagree. #500: the deployment
 * channel (env scalars folded into a "running model" row) is deleted with
 * the MODEL_RELAY_* family; every row carries its own declaration
 * (maxTokens/contextWindow/input/thinking/api) and no row is a
 * synthesized default.
 *
 * #450 (user ruling 2026-10-07): the env seed is GONE. There is no env
 * branch anywhere on the provider-selection path — the D1 rows are the sole
 * 正本. The resolution is a pure projection of those rows (#434): nothing is
 * synthesized, no first-key default is guessed, and a selection without an
 * explicit provider fails closed at the resolver. Schema-invalid D1 rows
 * never reach this projection — the loader drops them with a loud
 * per-row warning on the CRUD face (skip-with-warning), so the
 * catalog-level `decodeError` state of the env era cannot arise.
 */

export interface RelayCatalogModelRow {
  /** Owning provider id (directory grouping; #351 dispatch key). */
  providerId: string;
  id: string;
  model: string;
  displayName: string;
  description: string;
  /** The pi capability bit (the ladder gate input, projected verbatim). */
  reasoning: boolean;
  reasoningLevels: RelayReasoningLevel[];
  defaultReasoningLevel: RelayReasoningLevel;
  /**
   * Context window the row declares, null when undeclared (the dispatch
   * half keeps a wire-safety fallback constant for the usage denominator).
   */
  contextWindow: number | null;
  maxTokens: number | null;
  /**
   * #534 the pi thinking seat verbatim (relay-registry reads the wire
   * transports off it; the ladder above is its capability projection).
   * Absent = no controllable thinking surface.
   */
  thinking?: RelayModelThinking;
  imageInput: boolean;
  /** #361: the row's protocol face (model api ?? provider api ?? default). */
  api: RelayApi;
  /**
   * The picker's default row. Constantly false since #500: the deployment
   * names no running model anymore (#434/#450: no first-key fill; legacy
   * "running" rows do not exist) — kept as a wire-shape field.
   */
  isDefault: boolean;
}

export interface RelayCatalogProviderRow {
  id: string;
  displayName: string;
  /** bb ProviderCapabilities.supportsServiceTier projection. */
  serviceTier: boolean;
  /** #361: the provider-level protocol face (model rows may override). */
  api?: RelayApi;
  /** OR over the provider's model rows (any image-capable model). */
  imageInput: boolean;
}

export interface RelayCatalogResolution {
  /** True when at least one D1 provider row projects into the directory. */
  configured: boolean;
  /**
   * Retired with the env seed (#450): a catalog-level decode error cannot
   * arise when there is no env JSON to decode — D1 rows carry per-row
   * schema warnings on the CRUD face instead (skip-with-warning) and the
   * directory simply drops them. Constantly false, contract shape kept.
   */
  decodeError: boolean;
  /**
   * Null forever: D1 rows carry no deployment-wide default declaration
   * (#434: no first-key fill — a selection without an explicit provider
   * fails closed at the resolver). The picker always sends an explicit
   * selection; legacy journals replay against it and 422 honestly.
   */
  defaultProviderId: string | null;
  providers: RelayCatalogProviderRow[];
  models: RelayCatalogModelRow[];
}

/**
 * The D1 overlay resolution (sole 正本, #450): the provider-config rows the
 * panel CRUD face curates are the entire directory. Zero-config (no rows)
 * serves the empty resolution — the picker is honestly empty and a
 * selection without rows fails closed at the resolver. Nothing is
 * synthesized: no default row, no running-model stand-in.
 */
export function resolveOverlayCatalog(
  overlayProviders: Record<string, RelayCatalogProvider>,
): RelayCatalogResolution {
  if (Object.keys(overlayProviders).length === 0) {
    // The empty resolution face: no configured rows, nothing synthesized.
    return {
      configured: false,
      decodeError: false,
      defaultProviderId: null,
      providers: [],
      models: [],
    };
  }
  return projectCatalogDirectory(overlayProviders, {
    configured: true,
    decodeError: false,
    defaultProviderId: null,
  });
}

/**
 * The shared projection body: configured provider entries → directory rows.
 * Only configured rows are projected (#434): a directory that omits the
 * running model simply has no default row on the directory face — the
 * omission is configuration, never papered over with a synthesized row.
 */
function projectCatalogDirectory(
  providers: Record<string, RelayCatalogProvider>,
  flags: { configured: boolean; decodeError: boolean; defaultProviderId: string | null },
): RelayCatalogResolution {
  const providerRows: RelayCatalogProviderRow[] = [];
  const models: RelayCatalogModelRow[] = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    // #362 scope absorption ②: `api: "openai-images"` rows are IMAGE
    // sources (the generate_image tool reads them through the registry),
    // not LLM chat providers — they never enter the selectable LLM
    // directory (fail-closed selection vocabulary stays honest) and ride
    // the Configured panel CRUD face instead.
    const providerApi = provider.api;
    if (providerApi === IMAGE_SOURCE_API_FAMILY) continue;
    const rows = provider.models.map((entry): RelayCatalogModelRow => {
      // #534: the ladder is the pi capability projection (getSupportedEfforts
      // / defaultSupportedEffort through relayReasoningLadder) — no
      // load-bearing budget field anywhere. A re-imported list re-derives
      // the same ladder from the declaration, never from a hand-set scalar.
      const derived = relayReasoningLadder(entry);
      return {
        providerId,
        id: entry.id,
        model: entry.id,
        displayName: entry.name ?? entry.id,
        description: entry.description ?? "",
        reasoning: entry.reasoning === true,
        reasoningLevels: derived.levels,
        defaultReasoningLevel: derived.defaultLevel,
        // Every row advertises exactly its own declaration — the picker
        // shows what turns actually run, with no deployment fold.
        contextWindow: entry.contextWindow ?? null,
        maxTokens: entry.maxTokens ?? null,
        thinking: entry.thinking,
        imageInput: entry.input?.includes("image") ?? false,
        // #361: the face this row dispatches under — model declaration,
        // then the provider's, then the incumbent anthropic face.
        api: entry.api ?? providerApi ?? DEFAULT_RELAY_API,
        // #500: the deployment names no running model — no row is a default.
        isDefault: false,
      };
    });
    models.push(...rows);
    providerRows.push({
      id: providerId,
      displayName: provider.displayName ?? providerId,
      api: providerApi,
      serviceTier: provider.serviceTier ?? false,
      imageInput: rows.some((row) => row.imageInput),
    });
  }

  return {
    configured: flags.configured,
    decodeError: flags.decodeError,
    defaultProviderId: flags.defaultProviderId,
    providers: providerRows,
    models,
  };
}