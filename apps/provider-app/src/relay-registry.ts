/**
 * The #351 relay provider registry — the providerId-keyed dispatch half of
 * the catalog layer (roadmap §4.4: "目录 JSON 多 provider 行 + relay 注册表
 * 按 providerId 键控"). Multi-provider = registry rows of the same schema
 * family (the row's declared api face); each row's wire scalars
 * (model/maxTokens/thinking/contextWindow/imageInput) walk with the
 * SELECTED model row, not with the deployment default.
 *
 * Division of labor:
 * - packages/agent-do provider-catalog.ts owns the selection grammar
 *   (resolveRelaySelection) — fail-closed, named errors;
 * - this module owns the D1-side construction (#450: the provider-config
 *   正本 is the ONLY directory source — no env branch survives), the
 *   per-row credential fold (keys live in the row's decrypted slot, never
 *   in any public face), the RelayConfig fold, and the per-selection
 *   provider instance cache. #434 (point ⑦): a row without a usable key
 *   FAILS dispatch with the named error — no row-level mock degradation.
 *
 * Every registration site (ComposedAgentDO, ManagerDo, dev rigs) installs
 * the runtime this module returns — one registry, no per-site second source.
 */

import {
  AnthropicRelayProvider,
  CompletionsRelayProvider,
  DEFAULT_IMAGE_TIMEOUT_SECONDS,
  DEFAULT_RELAY_API,
  IMAGE_SOURCE_API_FAMILY,
  isImageSourceProvider,
  ResponsesRelayProvider,
  resolveRelaySelection,
  relayAnthropicThinking,
  relayResponsesWireEffort,
  relayWireModelId,
  relayApiConsumesEffortMap,
  type AgentRuntime,
  type GenerateImageConfig,
  type ModelProvider,
  type RelayCatalogProvider,
  type RelayConfig,
  type RelayModelCost,
  type RelayReasoningLevel,
  type RelaySelection,
  type ResponsesEffort,
} from "@cap/agent-do";
import type { RelayCatalogResolution } from "./catalog.js";
import { resolveOverlayCatalog } from "./catalog.js";
import {
  RELAY_FALLBACK_CONTEXT_WINDOW,
  RELAY_FALLBACK_MAX_TOKENS,
} from "./execution-posture.js";

/** One provider's credential slot (decrypted D1 row secret — never a face). */
export interface RelayProviderCredential {
  apiKey?: string;
  baseUrl?: string;
}

export type RelayProviderCredentialMap = Record<string, RelayProviderCredential>;

export interface RelayProviderRegistryResolution {
  providerId: string;
  modelId: string;
  reasoningLevel: RelayReasoningLevel;
  /** The wire config the selection dispatches under. */
  config: RelayConfig;
}

/**
 * #448 the explicit image source. The panel's 产图源 seat
 * (`overlay.imageSourceProviderId`, D1 image_source) names the
 * api=openai-images provider row that IS the generate_image switch + source
 * config — the seat is the user opt-in (no separate gate seat, #450: no env
 * fallback), and the row's baseUrl + decrypted key + first model row are the
 * source. null (no seat) or a seat naming a missing/non-image row resolves
 * to null — generate_image is simply not configured. A seat on an
 * incomplete row resolves with empty-string baseUrl/model — the executor
 * answers honestly that the source is not usable (never a guessed default).
 */
export function imageGenerationSourceFromOverlay(
  overlay: RelayProviderOverlay | null,
): GenerateImageConfig | null {
  if (overlay === null) return null;
  const seat = overlay.imageSourceProviderId;
  if (seat === null) return null;
  const provider = overlay.providers[seat];
  if (provider?.api !== IMAGE_SOURCE_API_FAMILY) return null;
  return {
    baseUrl: provider.baseUrl?.replace(/\/+$/, "") ?? "",
    apiKey: overlay.credentials[seat]?.apiKey ?? "",
    model: provider.models[0]?.id ?? "",
    timeoutSeconds: DEFAULT_IMAGE_TIMEOUT_SECONDS,
  };
}

/**
 * #362/#450 the D1 provider overlay: user-configured rows (provider_configs)
 * decoded by the server's config loader. `providers` carries the validated
 * catalog declarations — the ENTIRE directory (no env seed to ride over
 * since #450); `credentials` the DECRYPTED per-row wire slots. Every
 * overlay row is credential-standalone: its wire identity is row-owned and
 * never falls back to a deployment relay slot, because a user-authored
 * baseUrl must never be hit with a shared deployment key (leak vector).
 */
export interface RelayProviderOverlay {
  providers: Record<string, RelayCatalogProvider>;
  /** #448 the panel-selected image-source row id; null = none selected. */
  imageSourceProviderId: string | null;
  credentials: RelayProviderCredentialMap;
}

/** The honest zero-config overlay: no rows, no seat, no credentials. */
export const EMPTY_PROVIDER_OVERLAY: RelayProviderOverlay = {
  providers: {},
  imageSourceProviderId: null,
  credentials: {},
};

/** Selection-key → provider-instance cache key (one wire client per row+rung). */
function instanceKey(resolution: RelayProviderRegistryResolution): string {
  return `${resolution.providerId} ${resolution.modelId} ${resolution.reasoningLevel}`;
}

export class RelayProviderRegistry {
  private readonly instances = new Map<string, ModelProvider>();
  private catalogResolution: RelayCatalogResolution;
  private overlay: RelayProviderOverlay;

  private constructor(overlay: RelayProviderOverlay) {
    this.overlay = overlay;
    this.catalogResolution = resolveOverlayCatalog(overlay.providers);
  }

  /**
   * D1-only construction (#450, #500): the overlay is the sole directory
   * 正本 — no deployment env is read at all (the MODEL_RELAY_* scalars are
   * deleted). A zero-config deployment passes EMPTY_PROVIDER_OVERLAY —
   * every face serves the empty directory and every selection fails closed
   * until the panel rows land (the per-turn refresh hot-applies them).
   */
  static create(overlay: RelayProviderOverlay = EMPTY_PROVIDER_OVERLAY): RelayProviderRegistry {
    return new RelayProviderRegistry(overlay);
  }

  /**
   * Hot-reload: swap the D1 overlay in place (the registration closure
   * holds the instance). The instance cache is cleared — stale wire clients
   * must not survive a key rotation or a baseUrl edit.
   */
  applyOverlay(overlay: RelayProviderOverlay): void {
    this.overlay = overlay;
    this.catalogResolution = resolveOverlayCatalog(overlay.providers);
    this.instances.clear();
  }

  /**
   * Resolve one selection to its wire config. Throws RelaySelectionError
   * (fail-closed — the ROADMAP red line: never silently relax onto another
   * row) when the selection is not in the configured directory or the rung
   * is outside the row's runnable ladder.
   */
  resolve(selection: RelaySelection): RelayProviderRegistryResolution {
    const resolved = resolveRelaySelection(
      {
        rows: this.catalogResolution.models,
        defaultProviderId: this.catalogResolution.defaultProviderId,
        // #500/#534: the deployment names no running model — a model-less
        // selection fails closed (named 422), and each row's ladder is its
        // own pi capability projection.
        defaultModelId: "",
      },
      selection,
    );
    const row = this.catalogResolution.models.find(
      (candidate) =>
        candidate.providerId === resolved.providerId && candidate.id === resolved.modelId,
    );
    // #361: the selection's protocol face — the row's api fold (model ??
    // provider ?? incumbent anthropic face), resolved with the same
    // precedence the catalog rows were built under.
    const api = row?.api ?? DEFAULT_RELAY_API;
    // #361/#363: the rung → OpenAI effort fold (the row's thinking.effortMap
    // remap, then identity — the projected ladder cannot offer a rung the
    // official vocabulary cannot express). An anthropic-face row keeps its
    // budget/adaptive semantics — no effort fold.
    let reasoningEffort: ResponsesEffort = "none";
    if (relayApiConsumesEffortMap(api)) {
      reasoningEffort = relayResponsesWireEffort(resolved.reasoningLevel, row?.thinking);
    }
    // #450: every row is D1-standalone — the wire identity is the user's
    // row (baseUrl + decrypted apiKeyEnc); deployment channel scalars are
    // NOT a fallback (a user-authored baseUrl hit with the deployment key
    // would exfiltrate it). Missing pieces degrade to the empty string and
    // providerFor refuses dispatch.
    const rowApiKey = this.overlay.credentials[resolved.providerId]?.apiKey ?? "";
    const rowBaseUrl =
      this.overlay.credentials[resolved.providerId]?.baseUrl ??
      this.overlay.providers[resolved.providerId]?.baseUrl ??
      "";
    // #534: the wire thinking rides the row's pi transports — the rung
    // picks disabled / budget / adaptive(+effort); the pi model id routing
    // (effortRouting) names the upstream wire id when the row declares it.
    const anthropicThinking =
      api === "anthropic-messages"
        ? relayAnthropicThinking(
            { id: resolved.modelId, reasoning: row?.reasoning, thinking: row?.thinking },
            resolved.reasoningLevel,
          )
        : undefined;
    return {
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      reasoningLevel: resolved.reasoningLevel,
      config: {
        baseUrl: rowBaseUrl,
        apiKey: rowApiKey,
        model: relayWireModelId(
          { id: resolved.modelId, reasoning: row?.reasoning, thinking: row?.thinking },
          resolved.reasoningLevel,
        ),
        // Wire-safety fallbacks when the row declares none (#496 ruling):
        // a wrong budget clamps a reply, a wrong window skews a usage
        // percentage — neither routes a turn.
        maxTokens: row?.maxTokens ?? RELAY_FALLBACK_MAX_TOKENS,
        contextWindow: row?.contextWindow ?? RELAY_FALLBACK_CONTEXT_WINDOW,
        thinking: anthropicThinking?.thinking ?? { type: "disabled" },
        outputConfig: anthropicThinking?.outputConfig,
        supportsImageInput: row?.imageInput ?? false,
        api,
        reasoningEffort,
      },
    };
  }

  /**
   * The ModelProvider a selection dispatches through. Cache key =
   * provider+model+rung (the rung decides `thinking`, so it is part of the
   * wire identity). A row whose resolved apiKey or baseUrl is empty throws
   * the named credential error (#434 point ⑦ — fail-closed, never a
   * fixed-reply mock).
   */
  providerFor(selection: RelaySelection): ModelProvider {
    const resolution = this.resolve(selection);
    const key = instanceKey(resolution);
    const existing = this.instances.get(key);
    if (existing !== undefined) return existing;
    // #434 (point ⑦): no row-level mock degradation. A credential gap used
    // to serve the fixed-reply mock as a product mode; that was an implicit
    // default masquerading as the declared row — dispatch now fails with the
    // named remedy instead. #496/#500: the deployment-channel mock provider
    // is gone with the channel itself — no face reports one.
    if (resolution.config.apiKey === "" || resolution.config.baseUrl === "") {
      throw new Error(
        `relay provider "${resolution.providerId}" (${resolution.modelId}) has no usable credential` +
          " — the provider-config row lacks a usable key/baseUrl; set the row's apiKey/baseUrl" +
          " in the panel (fail-closed, #434)",
      );
    }
    const created: ModelProvider =
      resolution.config.api === "openai-responses"
        ? new ResponsesRelayProvider(resolution.config)
        : resolution.config.api === "openai-completions"
          ? new CompletionsRelayProvider(resolution.config)
          : new AnthropicRelayProvider(resolution.config);
    this.instances.set(key, created);
    return created;
  }

  /** The configured providers (diagnostic face; no secret values). */
  providerIds(): string[] {
    return [...new Set(this.catalogResolution.models.map((row) => row.providerId))];
  }

  /**
   * The resolved row's declared per-token cost, when it declares one (#523
   * find judge footer pricing) — read from the overlay's chat-branch model
   * entries (the directory rows carry no pricing; the overlay is the D1
   * 正本). Same fail-closed selection resolution as providerFor.
   */
  rowCost(selection: RelaySelection): RelayModelCost | undefined {
    const resolved = resolveRelaySelection(
      {
        rows: this.catalogResolution.models,
        defaultProviderId: this.catalogResolution.defaultProviderId,
        defaultModelId: "",
      },
      selection,
    );
    const provider = this.overlay.providers[resolved.providerId];
    if (provider === undefined || isImageSourceProvider(provider)) return undefined;
    return provider.models.find((entry) => entry.id === resolved.modelId)?.cost;
  }
}

/**
 * The composed AgentRuntime registration (#496): the registry resolver every
 * journal-selection dispatch goes through (the deployment-default provider
 * member is retired). This is the one registration shape the composed worker
 * and the manager install.
 */
export function relayAgentRuntime(registry: RelayProviderRegistry): AgentRuntime {
  return {
    resolveExecutionProvider: (selection: RelaySelection): ModelProvider =>
      registry.providerFor(selection),
    // #523: the judge leg prices its footer from the row's declared cost.
    resolveExecutionModel: (selection: RelaySelection) => {
      return {
        provider: registry.providerFor(selection),
        cost: registry.rowCost(selection),
      };
    },
  };
}
