import {
  decodeRelayCatalog,
  deriveRelayReasoning,
  DEFAULT_RELAY_API,
  IMAGE_SOURCE_API_FAMILY,
  type RelayApi,
  type RelayCatalog,
  type RelayCatalogModel,
  type RelayCatalogProvider,
  type ResponsesEffort,
  type RelayReasoningLevel,
} from "@cap/agent-do";
import { resolveHarness, type HarnessEnv, type ResolvedHarness } from "./harness.js";

/**
 * Relay catalog resolution (#350) — the MODEL_RELAY_CATALOG declaration
 * (packages/agent-do/src/provider-catalog.ts) projected into the read faces:
 * GET /system/execution-options (server routes/system.ts), the
 * provider-projections catalog row, and the project execution defaults
 * (routes/projects.ts). One resolution, several projections — the #319
 * dual-face pattern generalized to the catalog layer (roadmap §0.1/§2.3).
 *
 * Same-source by construction: the resolution runs resolveHarness and the
 * running model's directory row is folded FROM the harness output (model,
 * maxTokens, contextWindow, image input, thinking ladder default) — the
 * picker face and the turns-actually-run truth cannot disagree, which is
 * exactly the assertion the ticket pins ("harness 与目录对同一 env 求值一致").
 *
 * #434: the resolution is a pure projection of the declaration. Absent or
 * broken declarations serve zero rows (`decodeError` marks the broken case);
 * nothing is synthesized, no first-key default is guessed, and a selection
 * without an explicit provider fails closed at the resolver.
 */

export interface RelayCatalogModelRow {
  /** Owning provider id (directory grouping; #351 dispatch key). */
  providerId: string;
  id: string;
  model: string;
  displayName: string;
  description: string;
  reasoningLevels: RelayReasoningLevel[];
  defaultReasoningLevel: RelayReasoningLevel;
  /**
   * Context window the row stands for. The running row carries the
   * harness-resolved value (explicit env override + defaults folded);
   * non-running rows carry their declaration, null when undeclared.
   */
  contextWindow: number | null;
  maxTokens: number | null;
  /**
   * The row's effective thinking budget (#362): the model-declared
   * thinkingBudgetTokens winning over the deployment scalar; null when the
   * row runs budget-off. The dispatch half (relay-registry) reads this so a
   * panel budget edit rides the overlay without a redeploy.
   */
  thinkingBudgetTokens: number | null;
  imageInput: boolean;
  /** #361: the row's protocol face (model api ?? provider api ?? default). */
  api: RelayApi;
  /** #361: the row's per-model effort map (responses face consumption). */
  reasoningEffortMap?: Partial<Record<RelayReasoningLevel, ResponsesEffort>>;
  /** Exactly the running model's row (the model turns actually run). */
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
  /** True when MODEL_RELAY_CATALOG is set (including the decodeError case). */
  configured: boolean;
  /** True when the env JSON failed the strict decode — no rows are served. */
  decodeError: boolean;
  /**
   * The declaration's defaultProvider; null when the declaration names none
   * or no usable declaration exists (#434: no first-key fill, no seam — an
   * absent default fails closed at selection instead).
   */
  defaultProviderId: string | null;
  providers: RelayCatalogProviderRow[];
  models: RelayCatalogModelRow[];
  /** The running relay truth (resolveHarness) the default row projects. */
  harness: ResolvedHarness;
}

/** The empty resolution face: no usable declaration, nothing synthesized. */
function emptyResolution(
  harness: ResolvedHarness,
  configured: boolean,
  decodeError: boolean,
): RelayCatalogResolution {
  return {
    configured,
    decodeError,
    defaultProviderId: null,
    providers: [],
    models: [],
    harness,
  };
}

/**
 * Resolve the catalog directory over the deployment env. Never throws on env
 * content: absent or broken declarations serve NO directory rows
 * (#434 — no env-only synthesis; the deployment channel inside
 * `harness` is untouched), with `decodeError: true` marking the broken case
 * (the web_search decodeError precedent) so the misconfiguration stays
 * loudly visible on the read faces.
 */
export function resolveRelayCatalog(env: HarnessEnv): RelayCatalogResolution {
  const harness = resolveHarness(env);
  const raw = env.MODEL_RELAY_CATALOG;
  const configured = raw !== undefined && raw.trim() !== "";
  let catalog: RelayCatalog | null;
  try {
    catalog = decodeRelayCatalog(raw);
  } catch {
    return emptyResolution(harness, configured, true);
  }
  if (catalog === null) {
    return emptyResolution(harness, false, false);
  }

  return projectCatalogDirectory(harness, catalog.providers, {
    configured: true,
    decodeError: false,
    defaultProviderId: catalog.defaultProvider ?? null,
  });
}

/**
 * #362 merged resolution: the D1 provider overlay (user-configured rows)
 * rides over the env catalog. Same provider id → the overlay row replaces
 * the env declaration wholesale (the ticket's "同 id D1 覆盖"); new ids are
 * added. A broken env declaration keeps its loud `decodeError: true` flag
 * while the overlay rows still serve (a misconfigured deployment seed must
 * not take user-configured providers down). Zero rows overall (no usable
 * declaration and no overlay) serves the empty resolution — #434: nothing
 * is synthesized.
 */
export function resolveRelayCatalogWithOverlay(
  env: HarnessEnv,
  overlayProviders: Record<string, RelayCatalogProvider>,
): RelayCatalogResolution {
  const harness = resolveHarness(env);
  const raw = env.MODEL_RELAY_CATALOG;
  const configured = raw !== undefined && raw.trim() !== "";
  let base: RelayCatalog | null;
  let decodeError = false;
  try {
    base = decodeRelayCatalog(raw);
  } catch {
    base = null;
    decodeError = true;
  }
  const merged: Record<string, RelayCatalogProvider> = { ...(base?.providers ?? {}) };
  for (const [providerId, provider] of Object.entries(overlayProviders)) {
    merged[providerId] = provider;
  }
  if (Object.keys(merged).length === 0) {
    // Every declared row failed decode and nothing overlays: the empty
    // resolution keeps the loud decodeError semantics of the plain one.
    return emptyResolution(harness, configured, decodeError);
  }
  const envDefault = base?.defaultProvider;
  return projectCatalogDirectory(harness, merged, {
    configured: true,
    decodeError,
    defaultProviderId: envDefault ?? null,
  });
}

/**
 * The shared projection body: declared provider entries → directory rows.
 * Only declared rows are projected (#434): a declaration that omits the
 * running model simply has no default row on the directory face — the
 * omission is configuration, never papered over with a synthesized row.
 */
function projectCatalogDirectory(
  harness: ResolvedHarness,
  providers: Record<string, RelayCatalogProvider>,
  flags: { configured: boolean; decodeError: boolean; defaultProviderId: string | null },
): RelayCatalogResolution {
  const globalBudget =
    harness.relay.thinking.type === "enabled" ? harness.relay.thinking.budget_tokens : null;
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
    const rowBudgetOf = (entry: RelayCatalogModel): number | null =>
      entry.thinkingBudgetTokens ?? globalBudget;
    const rows = provider.models.map((entry): RelayCatalogModelRow => {
      const rowBudget = rowBudgetOf(entry);
      const derived = deriveRelayReasoning({
        thinkingEnabled: rowBudget !== null,
        declaredLevels: entry.reasoningLevels,
        declaredDefault: entry.defaultReasoningLevel,
      });
      const isRunning = entry.id === harness.relay.model;
      return {
        providerId,
        id: entry.id,
        model: entry.id,
        displayName: entry.name ?? entry.id,
        description: entry.description ?? "",
        reasoningLevels: derived.levels,
        defaultReasoningLevel: derived.defaultLevel,
        // The running row advertises the harness-resolved scalars (env
        // overrides and defaults already folded) — the picker shows what
        // turns actually run, not two parallel answers.
        contextWindow: isRunning ? harness.relay.contextWindow : (entry.contextWindow ?? null),
        maxTokens: isRunning ? harness.relay.maxTokens : (entry.maxTokens ?? null),
        thinkingBudgetTokens: rowBudget,
        imageInput: isRunning
          ? harness.relay.supportsImageInput
          : (entry.input?.includes("image") ?? false),
        // #361: the face this row dispatches under — model declaration,
        // then the provider's, then the incumbent anthropic face.
        api: entry.api ?? providerApi ?? DEFAULT_RELAY_API,
        reasoningEffortMap: entry.reasoningEffortMap,
        isDefault: isRunning,
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
    harness,
  };
}
