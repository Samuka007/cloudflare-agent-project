import { fetchWellKnownModels, type ModelSpec } from "@oh-my-pi/pi-catalog";
// bundled-references is a subpath export (pi-catalog 18.x dropped it from the
// star export but keeps "./provider-models/*" in the package exports map).
import { createReferenceResolver } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { z } from "zod";
import type {
  DiscoveredModelEntry,
  HostDiscoverModelsCommand,
  HostDiscoverModelsResult,
} from "../protocol.js";

/**
 * #447: the daemon side of `host.discover_models` — the pi-catalog-backed
 * discovery face. The edge only fetches `${baseUrl}/models` and keeps
 * {id, name?}; this host runs the SAME probe and then enriches every entry
 * against omp's catalog stack (the exact layers the ticket names):
 *
 * 1. live models.dev payload (`fetchWellKnownModels`, the catalog.stencil.so
 *    zstd hydration — Bun-host only, which is WHY the face lives here),
 * 2. the bundled catalog snapshot via the omp bundled-reference resolver
 *    (`createReferenceResolver` global map: largest context window wins,
 *    openai preferred on ties — bundled-references.ts getGlobalReferences
 *    semantics),
 * 3. neither → every metadata seat stays null and `metadataSource: "none"`
 *    marks the row honestly (the acceptance's explicit-unknown posture:
 *    unknown is rendered, never an empty cell).
 *
 * Zero-secret: `apiKey` rides the Authorization / x-api-key header only and
 * the error body is read bounded (the same posture as the edge face this
 * delegates from — provider-config-test.ts).
 */

const DISCOVERY_TIMEOUT_MS = 10_000;
const ERROR_BODY_CAP_BYTES = 512;

// pi-utils FetchImpl-compatible surface (string | URL | Request input) so the
// same stub passes through fetchWellKnownModels' seam unchanged.
type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Auth-header conventions: anthropic family → x-api-key + version pin, else Bearer. */
function discoveryHeaders(command: HostDiscoverModelsCommand): Record<string, string> {
  const isAnthropic = command.api?.startsWith("anthropic") === true;
  const headers: Record<string, string> = {};
  if (isAnthropic) headers["anthropic-version"] = "2023-06-01";
  if (command.apiKey !== undefined) {
    if (isAnthropic) {
      headers["x-api-key"] = command.apiKey;
    } else {
      headers.authorization = `Bearer ${command.apiKey}`;
    }
  }
  return headers;
}

async function boundedErrorText(response: Response): Promise<string> {
  const stream = response.body;
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunk = await reader.read();
  await reader.cancel();
  if (chunk.done) return "";
  return new TextDecoder().decode(chunk.value.slice(0, ERROR_BODY_CAP_BYTES));
}

// The envelope and entry shapes are outside-controlled (upstream JSON) —
// parsed, never cast, mirroring the edge face's schemas plus the anthropic
// display_name alias.
const modelsListEnvelopeSchema = z.object({ data: z.array(z.unknown()) });
const upstreamModelEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
});

// The models.dev payload is outside-controlled (network JSON) — parsed once
// at this boundary into exactly the seats the enrichment reads; unknown keys
// of each model record are irrelevant here and stay unparsed.
const modelsDevModelSchema = z.object({
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(z.object({ values: z.array(z.string()).optional() })).optional(),
  limit: z.object({ context: z.number().optional(), output: z.number().optional() }).optional(),
  cost: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
    })
    .optional(),
  modalities: z.object({ input: z.array(z.string()).optional() }).optional(),
});
const modelsDevPayloadSchema = z.record(
  z.string(),
  z.object({ models: z.record(z.string(), modelsDevModelSchema).optional() }),
);

/** omp toPositiveNumber semantics: a usable limit is finite and positive. */
function toPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** omp toInputCapabilities (openai-compat.ts:107-113): image presence lifts the row to [text, image]. */
function toInputCapabilities(value: unknown): ("text" | "image")[] {
  return Array.isArray(value) && value.some((item) => item === "image")
    ? ["text", "image"]
    : ["text"];
}

/** One parsed models.dev declaration, keyed by its provider slug. */
interface ModelsDevCandidate {
  providerKey: string;
  model: z.infer<typeof modelsDevModelSchema>;
}

/**
 * Cross-provider index over the models.dev payload: model id → declaration,
 * resolved exactly the way omp's bundled global-reference map resolves
 * (bundled-references.ts getGlobalReferences): larger context window wins,
 * larger max tokens wins the next tie, the openai declaration wins the next,
 * otherwise first seen. Memoized on payload identity: the pi-catalog session
 * hands back the SAME object until an etag revision lands, so the ~MB parse
 * runs once per catalog generation, not once per discovery request.
 */
let modelsDevIndexCache: {
  payload: unknown;
  byId: Map<string, ModelsDevCandidate>;
} | null = null;

function buildModelsDevIndex(payload: unknown): Map<string, ModelsDevCandidate> {
  const byId = new Map<string, ModelsDevCandidate>();
  const parsed = modelsDevPayloadSchema.safeParse(payload);
  if (!parsed.success) return byId;
  for (const [providerKey, provider] of Object.entries(parsed.data)) {
    const models = provider.models;
    if (models === undefined) continue;
    for (const [modelId, model] of Object.entries(models)) {
      const incumbent = byId.get(modelId);
      const candidate: ModelsDevCandidate = { providerKey, model };
      if (incumbent === undefined) {
        byId.set(modelId, candidate);
        continue;
      }
      const candidateContext = toPositiveNumber(candidate.model.limit?.context) ?? 0;
      const incumbentContext = toPositiveNumber(incumbent.model.limit?.context) ?? 0;
      const candidateMax = toPositiveNumber(candidate.model.limit?.output) ?? 0;
      const incumbentMax = toPositiveNumber(incumbent.model.limit?.output) ?? 0;
      const candidateWins =
        candidateContext > incumbentContext ||
        (candidateContext === incumbentContext && candidateMax > incumbentMax) ||
        (candidateContext === incumbentContext &&
          candidateMax === incumbentMax &&
          providerKey === "openai" &&
          incumbent.providerKey !== "openai");
      if (candidateWins) {
        byId.set(modelId, candidate);
      }
    }
  }
  return byId;
}

async function loadModelsDevIndex(
  warnings: string[],
  catalogFetch: FetchImpl,
): Promise<Map<string, ModelsDevCandidate>> {
  let payload: unknown;
  try {
    payload = await fetchWellKnownModels(catalogFetch);
  } catch (error) {
    warnings.push(
      `models.dev catalog unavailable (${error instanceof Error ? error.message : String(error)}) — bundled snapshot only`,
    );
    return new Map();
  }
  const cached = modelsDevIndexCache;
  if (cached !== null && cached.payload === payload) {
    return cached.byId;
  }
  const byId = buildModelsDevIndex(payload);
  modelsDevIndexCache = { payload, byId };
  return byId;
}

/**
 * omp mapWithBundledReference field merge (openai-compat.ts:311-333),
 * projected to the row vocabulary: the models.dev declaration wins the seats
 * it carries, the bundled reference fills the rest (name → limits → cost →
 * capability bits → thinking ladder), and a row no catalog knows keeps every
 * seat null under `metadataSource: "none"`.
 */
function enrichEntry(
  entry: { id: string; name?: string },
  modelsDev: ModelsDevCandidate | undefined,
  reference: ModelSpec | undefined,
  apiHint: string | null,
): DiscoveredModelEntry {
  const modelsDevPresent = modelsDev !== undefined;
  const referencePresent = reference !== undefined;

  const contextWindow =
    toPositiveNumber(modelsDev?.model.limit?.context) ?? reference?.contextWindow ?? null;
  const maxTokens =
    toPositiveNumber(modelsDev?.model.limit?.output) ?? reference?.maxTokens ?? null;

  const cost =
    modelsDev?.model.cost !== undefined || reference !== undefined
      ? {
          input: modelsDev?.model.cost?.input ?? reference?.cost.input ?? 0,
          output: modelsDev?.model.cost?.output ?? reference?.cost.output ?? 0,
          cacheRead: modelsDev?.model.cost?.cache_read ?? reference?.cost.cacheRead ?? 0,
          cacheWrite: modelsDev?.model.cost?.cache_write ?? reference?.cost.cacheWrite ?? 0,
        }
      : null;

  const reasoning =
    modelsDev?.model.reasoning === true || reference?.reasoning === true
      ? true
      : modelsDevPresent || referencePresent
        ? false
        : null;

  const input = modelsDevPresent
    ? toInputCapabilities(modelsDev.model.modalities?.input)
    : referencePresent
      ? reference.input
      : null;

  // Thinking ladder: the bundled reference carries omp's baked ladder; the
  // models.dev `reasoning_options` values are the live second source. A
  // reasoning model with neither keeps an EMPTY ladder (known reasoning,
  // unknown rungs); a non-reasoning or unknown row has no thinking seat.
  const efforts: string[] = reference?.thinking ? [...reference.thinking.efforts] : [];
  for (const option of modelsDev?.model.reasoning_options ?? []) {
    for (const value of option.values ?? []) {
      if (typeof value === "string" && value.length > 0 && !efforts.includes(value)) {
        efforts.push(value);
      }
    }
  }
  const thinking =
    reasoning === true || efforts.length > 0
      ? { mode: reference?.thinking?.mode ?? null, efforts }
      : null;

  const name =
    entry.name ??
    (modelsDevPresent &&
    typeof modelsDev.model.name === "string" &&
    modelsDev.model.name.trim().length > 0
      ? modelsDev.model.name.trim()
      : undefined) ??
    (referencePresent && reference.name !== entry.id ? reference.name : undefined);

  return {
    id: entry.id,
    ...(name !== undefined && name !== entry.id ? { name } : {}),
    ...(apiHint !== null ? { api: apiHint } : {}),
    // Unknown-capability seats carry explicit nulls (the acceptance posture:
    // unknown renders, never an empty cell) — only name/api stay optional
    // (panel id-fallback / no family hint).
    reasoning,
    input,
    contextWindow,
    maxTokens,
    cost,
    thinking,
    metadataSource: modelsDevPresent ? "models_dev" : referencePresent ? "bundled" : "none",
  };
}

/**
 * The command face: one upstream GET + catalog enrichment, answered as a
 * verdict (never throws — dispatch wraps a throw into ok:false, but a
 * transport failure against the UPSTREAM is a discover verdict, not a
 * dispatch failure).
 */
export async function discoverHostProviderModels(
  command: HostDiscoverModelsCommand,
  fetchImpl: FetchImpl = fetch,
  /**
   * The models.dev hydration fetch — scoped per fetch implementation by the
   * pi-catalog session, so rigs pass a stub here to isolate the catalog.
   * Defaults to the upstream fetch.
   */
  catalogFetchImpl: FetchImpl = fetchImpl,
): Promise<HostDiscoverModelsResult> {
  const warnings: string[] = [];
  const url = `${command.baseUrl.replace(/\/+$/, "")}/models`;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: discoveryHeaders(command),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      models: [],
      warnings,
    };
  }
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      error: await boundedErrorText(response),
      models: [],
      warnings,
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      error: "response body is not JSON",
      models: [],
      warnings,
    };
  }
  const envelope = modelsListEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      error: 'response is not an OpenAI models list (expected { "data": [...] })',
      models: [],
      warnings,
    };
  }

  const entries: { id: string; name?: string }[] = [];
  for (const raw of envelope.data.data) {
    const parsed = upstreamModelEntrySchema.safeParse(raw);
    if (!parsed.success) {
      warnings.push(
        `discovered entry without a usable string id (${JSON.stringify(raw ?? null).slice(0, 80)}) — skipped, never silently dropped`,
      );
      continue;
    }
    const name = parsed.data.name ?? parsed.data.display_name;
    entries.push({ id: parsed.data.id, ...(name !== undefined ? { name } : {}) });
  }

  // Enrichment runs even for a short list: an empty catalog is still an ok
  // verdict with honest rows.
  const [modelsDevById, resolveReference] = await Promise.all([
    loadModelsDevIndex(warnings, catalogFetchImpl),
    Promise.resolve(createReferenceResolver(new Map<string, ModelSpec>())),
  ]);

  const apiHint =
    command.api !== undefined && command.api !== null && command.api.trim().length > 0
      ? command.api.trim()
      : null;
  const models = entries.map((entry) =>
    enrichEntry(entry, modelsDevById.get(entry.id), resolveReference(entry.id), apiHint),
  );
  return { ok: true, status: response.status, latencyMs, error: null, models, warnings };
}
