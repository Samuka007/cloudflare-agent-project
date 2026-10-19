import {
  createModels,
  createProvider,
  type Model,
  type Models,
  type ModelThinkingLevel,
  type Provider,
  type ProviderStreams,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

export const DURABLE_PROVIDER_APIS = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
] as const;
export type DurableProviderApi = (typeof DURABLE_PROVIDER_APIS)[number];

export const FALLBACK_MAX_TOKENS = 8192;
export const FALLBACK_CONTEXT_WINDOW = 200_000;

export type ProviderProjectionErrorCode = "unknown_api" | "unknown_rung" | "empty_models";

export class ProviderProjectionError extends Error {
  readonly code: ProviderProjectionErrorCode;

  constructor(code: ProviderProjectionErrorCode, message: string) {
    super(message);
    this.name = "ProviderProjectionError";
    this.code = code;
  }
}

/** The D1 `provider_configs` model row, structurally (no zod dependency here). */
export interface DurableModelRow {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinking?: {
    mode: string;
    efforts: readonly string[];
    defaultLevel?: string;
    effortMap?: Partial<Record<string, string>>;
    effortBudgets?: Partial<Record<string, number>>;
  };
  input?: readonly ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

/** One decrypted D1 provider row; `resolveApiKey` decrypts at request time. */
export interface DurableProviderSource {
  providerId: string;
  displayName?: string;
  baseUrl: string;
  api?: string;
  models: readonly DurableModelRow[];
  resolveApiKey?: () => string | undefined | Promise<string | undefined>;
}

/**
 * #577 rung fold. pi has no `none`/`ultra`/`ultracode`; both cap-only rungs
 * fold to pi's `max` and the fold is explicit so a new rung cannot ride an
 * accidental identity switch.
 */
const CAP_RUNG_TO_PI: Readonly<Record<string, ModelThinkingLevel>> = {
  none: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "max",
  ultracode: "max",
};

export function foldCapRung(rung: string): ModelThinkingLevel {
  const level = CAP_RUNG_TO_PI[rung];
  if (level === undefined) {
    throw new ProviderProjectionError("unknown_rung", `unknown cap reasoning rung "${rung}"`);
  }
  return level;
}

export function resolveProviderApi(raw: string | undefined): DurableProviderApi {
  const api = raw ?? "anthropic-messages";
  if (!(DURABLE_PROVIDER_APIS as readonly string[]).includes(api)) {
    throw new ProviderProjectionError(
      "unknown_api",
      `unknown provider api "${api}" — supported: ${JSON.stringify(DURABLE_PROVIDER_APIS)}`,
    );
  }
  return api as DurableProviderApi;
}

const PI_EFFORT_LEVELS: readonly Exclude<ModelThinkingLevel, "off">[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function thinkingLevelMap(
  row: DurableModelRow,
  api: DurableProviderApi,
): ThinkingLevelMap | undefined {
  const thinking = row.thinking;
  if (thinking === undefined) return undefined;
  const map: ThinkingLevelMap = {};
  for (const [capRung, piLevel] of Object.entries(CAP_RUNG_TO_PI)) {
    const wire = thinking.effortMap?.[capRung];
    if (wire !== undefined) map[piLevel] = wire;
  }
  if (api === "openai-responses" || api === "openai-completions") {
    // OpenAI effort faces accept the pi level names directly when the row
    // declares no remap; "off" is the explicit disabled value.
    map.off = "none";
    for (const level of PI_EFFORT_LEVELS) {
      map[level] ??= level;
    }
  }
  return Object.keys(map).length === 0 ? undefined : map;
}

export function projectModelRow(
  source: DurableProviderSource,
  row: DurableModelRow,
): Model<DurableProviderApi> {
  const api = resolveProviderApi(row.api ?? source.api);
  const map = thinkingLevelMap(row, api);
  return {
    id: row.id,
    name: row.name ?? row.id,
    api,
    provider: source.providerId,
    baseUrl: source.baseUrl,
    reasoning: row.reasoning === true || row.thinking !== undefined,
    input: [...(row.input ?? ["text"])],
    cost: row.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: row.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: row.maxTokens ?? FALLBACK_MAX_TOKENS,
    ...(map === undefined ? {} : { thinkingLevelMap: map }),
  };
}

function apiImplementations(): Record<DurableProviderApi, ProviderStreams> {
  return {
    "anthropic-messages": anthropicMessagesApi(),
    "openai-responses": openAIResponsesApi(),
    "openai-completions": openAICompletionsApi(),
  };
}

export function projectProvider(source: DurableProviderSource): Provider {
  if (source.models.length === 0) {
    throw new ProviderProjectionError(
      "empty_models",
      `provider "${source.providerId}" declares no models`,
    );
  }
  const name = source.displayName ?? source.providerId;
  return createProvider({
    id: source.providerId,
    name,
    baseUrl: source.baseUrl,
    auth: {
      apiKey: {
        name,
        resolve: async () => {
          const key = await source.resolveApiKey?.();
          return key === undefined
            ? undefined
            : { auth: { apiKey: key }, source: "provider_configs" };
        },
      },
    },
    models: source.models.map((row) => projectModelRow(source, row)),
    api: apiImplementations(),
  });
}

/**
 * The `Models` collection is the hot-reload unit: the D1 loader rebuilds it
 * and the Harness keeps the same reference (Models.update in place is the
 * alternative when the loader owns the collection).
 */
export function createModelsFromProviders(sources: readonly DurableProviderSource[]): Models {
  const models = createModels();
  for (const source of sources) models.setProvider(projectProvider(source));
  return models;
}
