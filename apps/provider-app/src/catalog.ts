import {
  decodeRelayCatalog,
  deriveRelayReasoning,
  type RelayCatalog,
  type RelayCatalogProvider,
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
  imageInput: boolean;
  /** Exactly the running model's row (the model turns actually run). */
  isDefault: boolean;
}

export interface RelayCatalogProviderRow {
  id: string;
  displayName: string;
  /** bb ProviderCapabilities.supportsServiceTier projection. */
  serviceTier: boolean;
  /** OR over the provider's model rows (any image-capable model). */
  imageInput: boolean;
}

export interface RelayCatalogResolution {
  /** True when MODEL_RELAY_CATALOG is set (including the decodeError case). */
  configured: boolean;
  /** True when the env JSON failed the strict decode — a synthesis is served. */
  decodeError: boolean;
  /** The seam default-execution-options reports (catalog default or "omp"). */
  defaultProviderId: string;
  providers: RelayCatalogProviderRow[];
  models: RelayCatalogModelRow[];
  /** The running relay truth (resolveHarness) the default row projects. */
  harness: ResolvedHarness;
}

/** The omp provider seam id (routes/threads.ts thread create). */
const SYNTHETIC_PROVIDER_ID = "omp";

/**
 * The env-only synthesis: one provider "omp" whose only model is the model
 * turns actually run — the M0 directory shape (routes/system.ts before
 * #350), kept as the absent-catalog AND broken-catalog fallback so the
 * picker stays functional while the decode error is reported on the
 * provider-projections catalog row.
 */
function synthesisFromHarness(
  harness: ResolvedHarness,
  configured: boolean,
  decodeError: boolean,
): RelayCatalogResolution {
  const model = harness.relay.model;
  const derived = deriveRelayReasoning({
    thinkingEnabled: harness.relay.thinking.type === "enabled",
  });
  return {
    configured,
    decodeError,
    defaultProviderId: SYNTHETIC_PROVIDER_ID,
    providers: [
      {
        id: SYNTHETIC_PROVIDER_ID,
        displayName: SYNTHETIC_PROVIDER_ID,
        serviceTier: false,
        imageInput: harness.relay.supportsImageInput,
      },
    ],
    models: [
      {
        providerId: SYNTHETIC_PROVIDER_ID,
        id: model,
        model,
        displayName: model,
        description: "",
        reasoningLevels: derived.levels,
        defaultReasoningLevel: derived.defaultLevel,
        contextWindow: harness.relay.contextWindow,
        maxTokens: harness.relay.maxTokens,
        imageInput: harness.relay.supportsImageInput,
        isDefault: true,
      },
    ],
    harness,
  };
}

/**
 * Resolve the catalog directory over the deployment env. Never throws on env
 * content: a broken declaration degrades to the harness synthesis with
 * `decodeError: true` (the web_search decodeError precedent) so turns keep
 * running while the misconfiguration is loudly visible on the read faces.
 */
export function resolveRelayCatalog(env: HarnessEnv): RelayCatalogResolution {
  const harness = resolveHarness(env);
  const raw = env.MODEL_RELAY_CATALOG;
  const configured = raw !== undefined && raw.trim() !== "";
  let catalog: RelayCatalog | null;
  try {
    catalog = decodeRelayCatalog(raw);
  } catch {
    return synthesisFromHarness(harness, configured, true);
  }
  if (catalog === null) {
    return synthesisFromHarness(harness, false, false);
  }

  return projectCatalogDirectory(harness, catalog.providers, {
    configured: true,
    decodeError: false,
    defaultProviderId:
      catalog.defaultProvider ?? Object.keys(catalog.providers)[0] ?? SYNTHETIC_PROVIDER_ID,
  });
}

/**
 * #362 merged resolution: the D1 provider overlay (user-configured rows)
 * rides over the env catalog. Same provider id → the overlay row replaces
 * the env declaration wholesale (the ticket's "同 id D1 覆盖"); new ids are
 * added. A broken env declaration keeps its loud `decodeError: true` flag
 * while the overlay rows still serve (a misconfigured deployment seed must
 * not take user-configured providers down). Zero overlay rows (or no D1 at
 * all — the loader returns null) falls through to the plain env resolution,
 * byte-identical to resolveRelayCatalog.
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
    // Every declared row failed decode and nothing overlays: the synthesis
    // path keeps the loud decodeError semantics of the plain resolution.
    if (decodeError) return synthesisFromHarness(harness, configured, true);
    return synthesisFromHarness(harness, false, false);
  }
  const envDefault = base?.defaultProvider;
  return projectCatalogDirectory(harness, merged, {
    configured: true,
    decodeError,
    defaultProviderId: envDefault ?? Object.keys(merged)[0] ?? SYNTHETIC_PROVIDER_ID,
  });
}

/**
 * The shared projection body: declared provider entries → directory rows.
 * The model turns actually run stays visible regardless of declaration
 * (wire truth beats the declaration) — synthesized under the default
 * provider when no row carries it.
 */
function projectCatalogDirectory(
  harness: ResolvedHarness,
  providers: Record<string, RelayCatalogProvider>,
  flags: { configured: boolean; decodeError: boolean; defaultProviderId: string },
): RelayCatalogResolution {
  const thinkingEnabled = harness.relay.thinking.type === "enabled";
  const providerRows: RelayCatalogProviderRow[] = [];
  const models: RelayCatalogModelRow[] = [];
  let runningRow: RelayCatalogModelRow | undefined;
  for (const [providerId, provider] of Object.entries(providers)) {
    const rows = provider.models.map((entry): RelayCatalogModelRow => {
      const derived = deriveRelayReasoning({
        thinkingEnabled,
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
        imageInput: isRunning
          ? harness.relay.supportsImageInput
          : (entry.input?.includes("image") ?? false),
        isDefault: isRunning,
      };
    });
    runningRow ??= rows.find((row) => row.isDefault);
    models.push(...rows);
    providerRows.push({
      id: providerId,
      displayName: provider.displayName ?? providerId,
      serviceTier: provider.serviceTier ?? false,
      imageInput: rows.some((row) => row.imageInput),
    });
  }

  const defaultProviderId = flags.defaultProviderId;
  if (runningRow === undefined) {
    // The model turns actually run must always be visible on the directory
    // face (wire truth beats the declaration): synthesize its row under the
    // default provider when the declaration omits it.
    const derived = deriveRelayReasoning({ thinkingEnabled });
    runningRow = {
      providerId: defaultProviderId,
      id: harness.relay.model,
      model: harness.relay.model,
      displayName: harness.relay.model,
      description: "",
      reasoningLevels: derived.levels,
      defaultReasoningLevel: derived.defaultLevel,
      contextWindow: harness.relay.contextWindow,
      maxTokens: harness.relay.maxTokens,
      imageInput: harness.relay.supportsImageInput,
      isDefault: true,
    };
    models.unshift(runningRow);
  }
  return {
    configured: flags.configured,
    decodeError: flags.decodeError,
    defaultProviderId,
    providers: providerRows,
    models,
    harness,
  };
}
