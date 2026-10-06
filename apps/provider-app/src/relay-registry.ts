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
 *   keys live here, never in the public catalog), the RelayConfig fold, the
 *   per-selection provider instance cache, and the mock-first degradation
 *   for a row whose credential slot never got a key (#28 ruling).
 *
 * Every registration site (ComposedAgentDO, ManagerDo, dev rigs) installs
 * the runtime this module returns — one registry, no per-site second source.
 */

import {
  AnthropicRelayProvider,
  resolveRelaySelection,
  type AgentRuntime,
  type ModelProvider,
  type RelayConfig,
  type RelayReasoningLevel,
  type RelaySelection,
} from "@cap/agent-do";
import type { RelayCatalogResolution } from "./catalog.js";
import { resolveRelayCatalog } from "./catalog.js";
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
  private readonly catalogResolution: RelayCatalogResolution;
  private readonly credentials: RelayProviderCredentialMap;

  private constructor(
    catalogResolution: RelayCatalogResolution,
    credentials: RelayProviderCredentialMap,
  ) {
    this.catalogResolution = catalogResolution;
    this.credentials = credentials;
  }

  /** Resolve over the deployment env (catalog + harness + credential slots). */
  static fromEnv(env: HarnessEnv): RelayProviderRegistry {
    return new RelayProviderRegistry(
      resolveRelayCatalog(env),
      decodeRelayProviderCredentials(env.MODEL_RELAY_PROVIDER_CREDENTIALS),
    );
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
    const slot = this.credentials[resolved.providerId] ?? {};
    const thinking: ThinkingConfig =
      resolved.reasoningLevel === "none"
        ? { type: "disabled" }
        : harness.relay.thinking.type === "enabled"
          ? harness.relay.thinking
          : { type: "disabled" };
    return {
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      reasoningLevel: resolved.reasoningLevel,
      config: {
        baseUrl: slot.baseUrl ?? harness.relay.baseUrl,
        apiKey: slot.apiKey ?? harness.relay.apiKey,
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
      },
    };
  }

  /**
   * The ModelProvider a selection dispatches through. Cache key =
   * provider+model+rung (the rung decides `thinking`, so it is part of the
   * wire identity). A row whose resolved apiKey is empty degrades to the
   * fixed-reply mock (mock-first ruling #28, per row) — a credential gap is
   * a visible product mode, not a thread-killing surprise.
   */
  providerFor(selection: RelaySelection): ModelProvider {
    const resolution = this.resolve(selection);
    const key = instanceKey(resolution);
    const existing = this.instances.get(key);
    if (existing !== undefined) return existing;
    const created: ModelProvider =
      resolution.config.apiKey === ""
        ? new FixedReplyProvider(
            `model relay not configured for provider "${resolution.providerId}" ` +
              "(no MODEL_RELAY_PROVIDER_CREDENTIALS slot and no deployment key) — " +
              "fixed-reply mock in service (ticket #28 M0)",
            {
              model: resolution.config.model,
              maxTokens: resolution.config.maxTokens,
              thinking: resolution.config.thinking ?? { type: "disabled" },
              contextWindow: resolution.config.contextWindow ?? 200_000,
              supportsImageInput: resolution.config.supportsImageInput,
            },
          )
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
export function relayAgentRuntime(env: HarnessEnv): AgentRuntime {
  const registry = RelayProviderRegistry.fromEnv(env);
  return {
    provider: relayProviderFrom(resolveHarness(env)),
    resolveExecutionProvider: (selection: RelaySelection): ModelProvider =>
      registry.providerFor(selection),
  };
}
