/**
 * The #351 relay provider registry — the providerId-keyed dispatch half of
 * the catalog layer (roadmap §4.4: "目录 JSON 多 provider 行 + relay 注册表
 * 按 providerId 键控"). Multi-provider = registry rows of the same schema
 * (same Anthropic Messages shape, multiple upstreams); each row's wire
 * scalars (model/maxTokens/thinking/contextWindow/imageInput) walk with the
 * SELECTED model row, not with the deployment default.
 *
 * Division of labor:
 * - packages/agent-do provider-catalog.ts owns the selection grammar
 *   (resolveRelaySelection) — fail-closed, named errors;
 * - this module owns the env-side construction: the catalog resolution
 *   (#350 projection), the per-provider credential slots (#255 ruling C —
 *   keys live here, never in the public catalog), the RelayConfig fold, and
 *   the per-selection provider instance cache. #434 (point ⑦): a row whose
 *   credential slot never got a key FAILS dispatch with the named error —
 *   no row-level mock degradation.
 *
 * Every registration site (ComposedAgentDO, ManagerDo, dev rigs) installs
 * the runtime this module returns — one registry, no per-site second source.
 */

import {
  AnthropicRelayProvider,
  CompletionsRelayProvider,
  DEFAULT_IMAGE_TIMEOUT_SECONDS,
  IMAGE_SOURCE_API_FAMILY,
  ResponsesRelayProvider,
  resolveRelaySelection,
  RelaySelectionError,
  RelayEffortMapError,
  resolveResponsesEffort,
  relayApiConsumesEffortMap,
  type AgentRuntime,
  type GenerateImageConfig,
  type ModelProvider,
  type RelayCatalogProvider,
  type RelayConfig,
  type RelayReasoningLevel,
  type RelaySelection,
} from "@cap/agent-do";
import type { RelayCatalogResolution } from "./catalog.js";
import { resolveRelayCatalog, resolveRelayCatalogWithOverlay } from "./catalog.js";
import {
  FixedReplyProvider,
  relayProviderFrom,
  resolveHarness,
  type HarnessEnv,
  type ThinkingConfig,
} from "./harness.js";

/** One provider's credential slot (secret env, #255 C — never the catalog). */
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
 * #362 scope absorption ②: the panel-resolved image source. A provider row
 * with `api: "openai-images"` IS the generate_image switch + source config —
 * row presence is the user opt-in (no separate gate seat), the row's baseUrl
 * + decrypted key + first model row are the source. The env
 * AGENT_DO_GENERATE_IMAGE/AGENT_DO_IMAGE_SOURCE pair is the fallback the DO
 * applies when this returns null. Returns null with an empty-string
 * baseUrl/model when the row is incomplete — the executor answers honestly
 * that the source is not configured (never a guessed default).
 */
export function imageGenerationSourceFromOverlay(
  overlay: RelayProviderOverlay | null,
): GenerateImageConfig | null {
  if (overlay === null) return null;
  const entry = Object.entries(overlay.providers).find(
    ([, provider]) => provider.api === IMAGE_SOURCE_API_FAMILY,
  );
  if (entry === undefined) return null;
  const [id, provider] = entry;
  return {
    baseUrl: provider.baseUrl?.replace(/\/+$/, "") ?? "",
    apiKey: overlay.credentials[id]?.apiKey ?? "",
    model: provider.models[0]?.id ?? "",
    timeoutSeconds: DEFAULT_IMAGE_TIMEOUT_SECONDS,
  };
}

/**
 * #362 the D1 provider overlay: user-configured rows (provider_configs)
 * decoded by the server's config loader. `providers` carries the validated
 * catalog declarations (they override env same-id entries at projection);
 * `credentials` the DECRYPTED per-row wire slots; `standaloneProviders` the
 * ids whose wire identity is row-owned — they never fall back to the
 * deployment relay slots, because a user-authored baseUrl must never be
 * hit with the deployment's shared key (credential-leak vector).
 */
export interface RelayProviderOverlay {
  providers: Record<string, RelayCatalogProvider>;
  credentials: RelayProviderCredentialMap;
  standaloneProviders: ReadonlySet<string>;
}

/**
 * Decode `MODEL_RELAY_PROVIDER_CREDENTIALS` (strict: unknown members and
 * shape violations throw — deployment-time input, the AGENT_DO_IMAGE_SOURCE
 * posture; a silent degradation would turn a typo'd provider id into
 * upstream 403s instead of a loud deploy failure). Absent/blank → {} (every
 * provider rides the deployment's single-relay slots).
 */
export function decodeRelayProviderCredentials(
  raw: string | undefined,
): RelayProviderCredentialMap {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MODEL_RELAY_PROVIDER_CREDENTIALS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MODEL_RELAY_PROVIDER_CREDENTIALS must be a JSON object keyed by provider id");
  }
  const credentials: RelayProviderCredentialMap = {};
  for (const [providerId, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `MODEL_RELAY_PROVIDER_CREDENTIALS["${providerId}"] must be an object ({apiKey?, baseUrl?})`,
      );
    }
    const slot: RelayProviderCredential = {};
    const record = value as Record<string, unknown>;
    for (const field of ["apiKey", "baseUrl"] as const) {
      const entry = record[field];
      if (entry === undefined) continue;
      if (typeof entry !== "string" || entry === "") {
        throw new Error(
          `MODEL_RELAY_PROVIDER_CREDENTIALS["${providerId}"].${field} must be a non-empty string`,
        );
      }
      slot[field] = entry;
    }
    const unknown = Object.keys(record).filter((key) => key !== "apiKey" && key !== "baseUrl");
    if (unknown.length > 0) {
      throw new Error(
        `MODEL_RELAY_PROVIDER_CREDENTIALS["${providerId}"] has unknown members: ${JSON.stringify(unknown)} (strict schema: apiKey, baseUrl)`,
      );
    }
    credentials[providerId] = slot;
  }
  return credentials;
}

/** Selection-key → provider-instance cache key (one wire client per row+rung). */
function instanceKey(resolution: RelayProviderRegistryResolution): string {
  return `${resolution.providerId} ${resolution.modelId} ${resolution.reasoningLevel}`;
}

export class RelayProviderRegistry {
  private readonly instances = new Map<string, ModelProvider>();
  private catalogResolution: RelayCatalogResolution;
  private readonly credentials: RelayProviderCredentialMap;
  private readonly env: HarnessEnv;
  private overlay: RelayProviderOverlay | null;

  private constructor(
    env: HarnessEnv,
    catalogResolution: RelayCatalogResolution,
    credentials: RelayProviderCredentialMap,
    overlay: RelayProviderOverlay | null = null,
  ) {
    this.env = env;
    this.catalogResolution = catalogResolution;
    this.credentials = credentials;
    this.overlay = overlay;
  }

  /** Resolve over the deployment env (catalog + harness + credential slots). */
  static fromEnv(env: HarnessEnv): RelayProviderRegistry {
    return new RelayProviderRegistry(
      env,
      resolveRelayCatalog(env),
      decodeRelayProviderCredentials(env.MODEL_RELAY_PROVIDER_CREDENTIALS),
    );
  }

  /**
   * #362 hot-reload: swap the D1 overlay in place (the registration closure
   * holds the instance). The instance cache is cleared — stale wire clients
   * must not survive a key rotation or a baseUrl edit.
   */
  applyOverlay(overlay: RelayProviderOverlay): void {
    this.overlay = overlay;
    this.catalogResolution = resolveRelayCatalogWithOverlay(this.env, overlay.providers);
    this.instances.clear();
  }

  /**
   * Resolve one selection to its wire config. Throws RelaySelectionError
   * (fail-closed — the ROADMAP red line: never silently relax onto another
   * row) when the selection is not in the declared catalog or the rung is
   * outside the row's runnable ladder.
   */
  resolve(selection: RelaySelection): RelayProviderRegistryResolution {
    const harness = this.catalogResolution.harness;
    const resolved = resolveRelaySelection(
      {
        rows: this.catalogResolution.models,
        defaultProviderId: this.catalogResolution.defaultProviderId,
        defaultModelId: harness.relay.model,
        thinkingEnabled: harness.relay.thinking.type === "enabled",
      },
      selection,
    );
    // The running row's scalars are the harness fold (env overrides already
    // applied, #350 same-source discipline); other rows read their own
    // declaration, falling back to the harness scalars per field.
    const isRunning = resolved.modelId === harness.relay.model;
    const row = this.catalogResolution.models.find(
      (candidate) =>
        candidate.providerId === resolved.providerId && candidate.id === resolved.modelId,
    );
    // #361: the selection's protocol face — the row's api fold (model ??
    // provider ?? harness default), resolved with the same precedence the
    // catalog rows were built under.
    const api = row?.api ?? harness.relay.api;
    // #361/#363: the rung → OpenAI effort fold. resolveRelaySelection already
    // 422s an unmappable rung on openai-effort rows (fail-closed effort
    // mapping); this re-resolution is belt over the harness-face path whose
    // rows may predate that grammar. An anthropic-face row keeps its budget
    // semantics — no effort fold.
    let reasoningEffort = harness.relay.reasoningEffort;
    if (relayApiConsumesEffortMap(api)) {
      try {
        reasoningEffort = resolveResponsesEffort(resolved.reasoningLevel, row?.reasoningEffortMap);
      } catch (error) {
        if (error instanceof RelayEffortMapError) {
          throw new RelaySelectionError("reasoning_level_unknown", "reasoningLevel", error.message);
        }
        throw error;
      }
    }
    // #362: a D1-declared (overlay) provider is credential-standalone — its
    // wire identity is the user's row (baseUrl + decrypted apiKeyEnc), NEVER
    // the deployment's shared relay slots (a user-authored baseUrl hit with
    // the deployment key would exfiltrate it). Missing standalone pieces
    // degrade to the mock-first row, not to deployment credentials.
    const standalone = this.overlay?.providers[resolved.providerId] !== undefined;
    const slot: RelayProviderCredential = standalone
      ? {
          apiKey: this.overlay?.credentials[resolved.providerId]?.apiKey ?? "",
          baseUrl:
            this.overlay?.credentials[resolved.providerId]?.baseUrl ??
            this.overlay?.providers[resolved.providerId]?.baseUrl ??
            "",
        }
      : (this.credentials[resolved.providerId] ?? {});
    // #362 scope absorption ①: the row's effective thinking budget wins over
    // the deployment scalar (thinkingBudgetTokens on the projected row —
    // model-declared budget, null = budget-off, undefined = legacy row that
    // keeps the harness fold). A panel budget edit rides the overlay hot.
    const rowBudget = row?.thinkingBudgetTokens;
    const budgetThinking: ThinkingConfig =
      rowBudget === undefined
        ? harness.relay.thinking
        : rowBudget !== null
          ? { type: "enabled", budget_tokens: rowBudget }
          : { type: "disabled" };
    const thinking: ThinkingConfig =
      resolved.reasoningLevel === "none" ? { type: "disabled" } : budgetThinking;
    return {
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      reasoningLevel: resolved.reasoningLevel,
      config: {
        baseUrl: standalone ? (slot.baseUrl ?? "") : (slot.baseUrl ?? harness.relay.baseUrl),
        apiKey: standalone ? (slot.apiKey ?? "") : (slot.apiKey ?? harness.relay.apiKey),
        model: resolved.modelId,
        maxTokens: isRunning
          ? harness.relay.maxTokens
          : (row?.maxTokens ?? harness.relay.maxTokens),
        contextWindow: isRunning
          ? harness.relay.contextWindow
          : (row?.contextWindow ?? harness.relay.contextWindow),
        thinking,
        supportsImageInput: isRunning
          ? harness.relay.supportsImageInput
          : (row?.imageInput ?? false),
        api,
        reasoningEffort,
      },
    };
  }

  /**
   * The ModelProvider a selection dispatches through. Cache key =
   * provider+model+rung (the rung decides `thinking`, so it is part of the
   * wire identity). A row whose resolved apiKey is empty throws the named
   * credential error (#434 point ⑦ — fail-closed, never a fixed-reply mock).
   */
  providerFor(selection: RelaySelection): ModelProvider {
    const resolution = this.resolve(selection);
    const key = instanceKey(resolution);
    const existing = this.instances.get(key);
    if (existing !== undefined) return existing;
    // Standalone rows additionally need a wire base: a D1 provider without
    // (decryptable) key OR baseUrl has no honest wire target — deployment
    // credentials are not a fallback (see resolve()).
    const standaloneIncomplete =
      this.overlay?.providers[resolution.providerId] !== undefined &&
      (resolution.config.apiKey === "" || resolution.config.baseUrl === "");
    // #434 (point ⑦): no row-level mock degradation. A credential gap used
    // to serve the fixed-reply mock as a product mode; that was an implicit
    // default masquerading as the declared row — dispatch now fails with the
    // named remedy instead. (The DEPLOYMENT-channel mock in harness.ts
    // relayProviderFrom is a different, kept posture: the projections face
    // reports it as relayMode "mock".)
    if (resolution.config.apiKey === "" || standaloneIncomplete) {
      throw new Error(
        `relay provider "${resolution.providerId}" (${resolution.modelId}) has no usable credential` +
          (standaloneIncomplete
            ? " — the provider-config row lacks a usable key/baseUrl and deployment " +
              "credentials are never a fallback for user-configured rows; set the row's apiKey/baseUrl"
            : " — no MODEL_RELAY_PROVIDER_CREDENTIALS slot and no deployment key; set one before dispatching") +
          " (fail-closed, #434)",
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
}

/**
 * The composed AgentRuntime registration: the deployment default provider
 * (harness fold — the "*" fallback posture, unchanged for pre-#351
 * journals) plus the registry resolver every journal-selection dispatch
 * goes through. This is the one registration shape the composed worker, the
 * manager, and dev rigs install.
 */
export function relayAgentRuntime(
  env: HarnessEnv,
  registry: RelayProviderRegistry = RelayProviderRegistry.fromEnv(env),
): AgentRuntime {
  return {
    provider: relayProviderFrom(resolveHarness(env)),
    resolveExecutionProvider: (selection: RelaySelection): ModelProvider =>
      registry.providerFor(selection),
  };
}
