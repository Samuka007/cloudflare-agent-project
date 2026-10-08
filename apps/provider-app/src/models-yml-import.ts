/**
 * #364 the omp models.yml importer — turn a pasted `~/.omp/agent/models.yml`
 * fragment into provider_configs CRUD candidates (the "cloud = local omp"
 * loop: one paste lifts the local provider configuration onto the panel).
 *
 * Semantics are ported from omp's own config schema (can1357/oh-my-pi
 * packages/coding-agent/src/config/models-config-schema-bundle.ts: the
 * ModelsConfig / ProviderConfig / ModelDefinition / ModelThinking shapes,
 * including the thinking legacy-range normalization pipe). omp's reader
 * itself is not vendorable — it is typed against omp's runtime type system
 * — so the parser is the `yaml` package (pure JS, workerd-compatible) plus
 * this explicit field mapping onto the edge catalog vocabulary
 * (#350 relayCatalogModelSchema; #361/#363 api families).
 *
 * Honesty rules (ticket acceptance):
 * - api values outside the relay families produce an explicit unsupported
 *   verdict (HTTP-grade 422) — never a silently created dead row, never a
 *   silently dropped provider.
 * - Model rows are validated with the SAME zod schema the loader applies
 *   (relayCatalogModelSchema); unusable rows skip with a warning.
 * - apiKey plaintext only ever rides the import request body; the route
 *   encrypts it through the #362 AES-GCM chain. omp `$$CREDENTIAL_…$$`
 *   placeholders cannot be resolved server-side → the row imports WITHOUT a
 *   credential plus a warning, never a fake key.
 */

import { parse as parseYaml } from "yaml";
import {
  IMAGE_SOURCE_API_FAMILY,
  isImageGenerationModelId,
  relayApiValues,
  relayCatalogModelSchema,
  relayThinkingModeValues,
  responsesEffortValues,
  type RelayCatalogModel,
  type RelayEffort,
  type RelayThinkingMode,
  type ResponsesEffort,
} from "@cap/agent-do";
import { isValidProviderConfigId } from "./provider-configs.js";

/** The fragment-level parse failures the route surfaces as honest 4xx. */
export class ModelsYmlImportError extends Error {
  readonly code: "import_yaml_invalid" | "import_no_providers";

  constructor(code: "import_yaml_invalid" | "import_no_providers", message: string) {
    super(message);
    this.code = code;
    this.name = "ModelsYmlImportError";
  }
}

/** One provider ready for the CRUD insert path (fields map 1:1 to the row). */
export interface ModelsYmlProviderCandidate {
  id: string;
  baseUrl: string | null;
  /** An admitted relay family, or null (the row rides the default face). */
  api: string | null;
  /** Plaintext credential, or null (absent / unresolvable placeholder). */
  apiKey: string | null;
  models: RelayCatalogModel[];
  /** This provider's skip-with-warning transcript (migration facts). */
  warnings: string[];
}

/** A provider the import refuses with an explicit, HTTP-grade verdict. */
export interface ModelsYmlProviderSkip {
  id: string;
  status: number;
  code: "unsupported_api" | "invalid_id" | "invalid_shape";
  message: string;
}

export interface ModelsYmlImportParse {
  providers: ModelsYmlProviderCandidate[];
  skips: ModelsYmlProviderSkip[];
  /** Fragment-level oddities that name no single provider. */
  warnings: string[];
}

/**
 * omp's Api vocabulary (models-config-schema-bundle.ts ApiSchema). Only the
 * first three have cloud adaptors (#361/#363); the rest are the labels the
 * importer must verdict honestly instead of silently dropping.
 */
export const OMP_API_VOCABULARY = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "openrouter-decisions",
  "typesafe",
] as const;

/** omp's effort ladder + the legacy minLevel/maxLevel range order. */
const OMP_EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * #534 the edge effort ladder (pi Effort minus minimal): the mapped rungs a
 * row can carry. omp's `minimal` has no bb rung and drops WITH a warning.
 */
const EDGE_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

const SUPPORTED_API_LIST = relayApiValues.join(", ");

function isAdmittedRelayApi(value: string): boolean {
  return (relayApiValues as readonly string[]).includes(value);
}

function isEdgeEffort(value: string): value is RelayEffort {
  // Narrowing guard: a label the ladder cannot name drops with a warning at
  // every call site, never clamps onto a neighbor.
  return (EDGE_EFFORT_ORDER as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** omp api labels with no cloud adaptor — every one gets the 422 verdict. */
export const OMP_UNADMITTED_API_VALUES = OMP_API_VOCABULARY.filter(
  (api) => !isAdmittedRelayApi(api),
);

/**
 * Normalize one omp `thinking` block per its pipe semantics: efforts beat
 * levels, levels beat the minLevel..maxLevel range (inclusive, EFFORT_ORDER).
 * The result is the pi thinking shape (#534, written verbatim onto the row):
 * the declared omp `mode` rides through; rungs our relay ladder can name
 * only — omp's `minimal`
 * has no rung on the cloud ladder and is dropped WITH a warning, never
 * silently clamped onto a neighboring rung.
 */
function normalizeThinking(
  raw: unknown,
  subject: string,
): {
  mode: RelayThinkingMode;
  efforts: RelayEffort[];
  defaultLevel?: RelayEffort;
  effortMap?: Partial<Record<RelayEffort, ResponsesEffort>>;
  requiresEffort?: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const thinking = asRecord(raw);
  if (thinking === null) {
    if (raw !== undefined) warnings.push(`${subject}: thinking is not a mapping — ignored`);
    return { mode: "budget", efforts: [], warnings };
  }
  const declaredMode = typeof thinking.mode === "string" ? thinking.mode : undefined;
  const mode =
    declaredMode !== undefined &&
    (relayThinkingModeValues as readonly string[]).includes(declaredMode)
      ? (declaredMode as RelayThinkingMode)
      : // The edge's incumbent anthropic transport; openai faces ignore the
        // mode (their knob is the effort fold) — a defaulted mode never
        // mis-wires them.
        "budget";
  const toEfforts = (values: unknown[]): { efforts: RelayEffort[]; dropped: string[] } => {
    const efforts: RelayEffort[] = [];
    const dropped: string[] = [];
    for (const entry of values) {
      if (typeof entry === "string" && isEdgeEffort(entry)) {
        if (!efforts.includes(entry)) efforts.push(entry);
      } else {
        dropped.push(typeof entry === "string" ? entry : "non-string");
      }
    }
    return { efforts, dropped };
  };
  let resolved: { efforts: RelayEffort[]; dropped: string[] };
  if (Array.isArray(thinking.efforts)) {
    resolved = toEfforts(thinking.efforts);
  } else if (Array.isArray(thinking.levels)) {
    resolved = toEfforts(thinking.levels);
  } else if (typeof thinking.minLevel === "string" && typeof thinking.maxLevel === "string") {
    const minIndex = OMP_EFFORT_ORDER.indexOf(
      thinking.minLevel as (typeof OMP_EFFORT_ORDER)[number],
    );
    const maxIndex = OMP_EFFORT_ORDER.indexOf(
      thinking.maxLevel as (typeof OMP_EFFORT_ORDER)[number],
    );
    if (minIndex === -1 || maxIndex === -1 || minIndex > maxIndex) {
      warnings.push(
        `${subject}: thinking minLevel/maxLevel "${thinking.minLevel}".."${thinking.maxLevel}" is not a usable range — ignored`,
      );
      return { mode, efforts: [], warnings };
    }
    resolved = toEfforts(OMP_EFFORT_ORDER.slice(minIndex, maxIndex + 1));
  } else {
    warnings.push(
      `${subject}: thinking has neither efforts nor a minLevel/maxLevel range — ignored`,
    );
    return { mode, efforts: [], warnings };
  }
  if (resolved.dropped.length > 0) {
    warnings.push(
      `${subject}: effort rungs outside the cloud ladder dropped (${resolved.dropped.join(", ")})`,
    );
  }
  const mergeEffortMap = (
    rawMap: unknown,
    source: string,
  ): Partial<Record<RelayEffort, ResponsesEffort>> => {
    const map = asRecord(rawMap);
    const out: Partial<Record<RelayEffort, ResponsesEffort>> = {};
    if (map === null) {
      if (rawMap !== undefined) warnings.push(`${subject}: ${source} is not a mapping — ignored`);
      return out;
    }
    for (const [key, value] of Object.entries(map)) {
      if (!isEdgeEffort(key)) {
        warnings.push(`${subject}: ${source} key "${key}" is not a cloud ladder rung — dropped`);
        continue;
      }
      if (typeof value !== "string" || ![...responsesEffortValues, "adaptive"].includes(value)) {
        warnings.push(
          `${subject}: ${source}["${key}"] = ${JSON.stringify(value)} is not a wire effort — dropped`,
        );
        continue;
      }
      out[key] = value as ResponsesEffort;
    }
    return out;
  };
  const effortMap = mergeEffortMap(thinking.effortMap, "thinking.effortMap");
  let defaultLevel: RelayEffort | undefined;
  if (typeof thinking.defaultLevel === "string") {
    if (isEdgeEffort(thinking.defaultLevel) && resolved.efforts.includes(thinking.defaultLevel)) {
      defaultLevel = thinking.defaultLevel;
    } else {
      warnings.push(
        `${subject}: thinking.defaultLevel "${thinking.defaultLevel}" is not a mapped rung — dropped`,
      );
    }
  }
  return {
    mode,
    efforts: resolved.efforts,
    ...(defaultLevel !== undefined ? { defaultLevel } : {}),
    ...(Object.keys(effortMap).length > 0 ? { effortMap } : {}),
    ...(thinking.requiresEffort === true ? { requiresEffort: true } : {}),
    warnings,
  };
}

/** The omp model keys with no cloud seat (the dropped-keys summary names them). */
const OMP_MODEL_ONLY_KEYS = [
  "baseUrl",
  "headers",
  "tokenizer",
  "imageInputDecoder",
  "supportsTools",
  "promptCache",
  "premiumMultiplier",
  "maxContextWindow",
  "omitMaxOutputTokens",
  "preferWebsockets",
  "contextPromotionTarget",
  "compactionModel",
  "remoteCompaction",
] as const;

/** The omp keys the mapper consumed (everything else lands in the dropped summary). */
const MODEL_MAPPED_KEYS = [
  "id",
  "name",
  "api",
  "reasoning",
  "thinking",
  "input",
  "contextWindow",
  "maxTokens",
  "cost",
  ...OMP_MODEL_ONLY_KEYS,
] as const;

/** The provider-level omp keys that silently change wire behavior if unnoticed. */
const OMP_PROVIDER_DROPPED_KEYS = [
  "headers",
  "authHeader",
  "auth",
  "compat",
  "remoteCompaction",
  "disableStrictTools",
  "guardrailIdentifier",
  "guardrailVersion",
  "guardrailTrace",
  "requestMetadata",
  "transport",
] as const;

/**
 * Fold an omp effort map (thinking.effortMap or compat.reasoningEffortMap)
 * onto the cloud vocabularies. Entries outside the rung/effort enums are
 * dropped WITH a warning — never clamped, never silently lost.
 */
function foldEffortMap(
  rawMap: unknown,
  subject: string,
  source: string,
  warnings: string[],
): Partial<Record<RelayEffort, ResponsesEffort>> {
  const map = asRecord(rawMap);
  const out: Partial<Record<RelayEffort, ResponsesEffort>> = {};
  if (map === null) {
    if (rawMap !== undefined) warnings.push(`${subject}: ${source} is not a mapping — ignored`);
    return out;
  }
  for (const [key, value] of Object.entries(map)) {
    if (!isEdgeEffort(key)) {
      warnings.push(`${subject}: ${source} key "${key}" is not a cloud ladder rung — dropped`);
      continue;
    }
    if (typeof value !== "string" || ![...responsesEffortValues, "adaptive"].includes(value)) {
      warnings.push(
        `${subject}: ${source}["${key}"] = ${JSON.stringify(value)} is not a wire effort — dropped`,
      );
      continue;
    }
    out[key] = value as ResponsesEffort;
  }
  return out;
}

/**
 * Map one omp model definition (plus any modelOverrides entries merged onto
 * it) into a catalog model row. Returns null when the row is unusable — the
 * caller records the warnings verbatim (skip-with-warning, never silent).
 */
function mapModelEntry(
  rawModel: unknown,
  overrides: Record<string, unknown> | null,
  fallbackId: string,
): { model: RelayCatalogModel | null; warnings: string[] } {
  const warnings: string[] = [];
  const source = asRecord(rawModel);
  if (source === null) {
    return { model: null, warnings: [`model "${fallbackId}" is not a mapping — skipped`] };
  }
  const merged: Record<string, unknown> = { ...source, ...(overrides ?? {}) };
  const subject = `model "${fallbackId}"`;
  const rawId = merged.id;
  if (typeof rawId !== "string" || rawId.trim() === "") {
    return { model: null, warnings: [`${subject}: missing id — skipped`] };
  }
  // #485: an image-generation id never imports into a chat provider row —
  // it belongs on an api=openai-images row (the Image Source), so the model
  // skips with the pointer instead of landing as a chat model.
  if (isImageGenerationModelId(rawId)) {
    return {
      model: null,
      warnings: warnings.concat([
        `${subject}: image-generation model id (产图族) — not imported into a chat provider; ` +
          `create an api=openai-images row in Configured and select it in Settings → Providers → Image Source`,
      ]),
    };
  }
  const modelWarnings: string[] = [];
  const entry: Record<string, unknown> = { id: rawId };
  if (typeof merged.name === "string" && merged.name !== "") entry.name = merged.name;
  if (typeof merged.reasoning === "boolean") entry.reasoning = merged.reasoning;
  // Model-level api: an admitted family rides the row; anything else skips
  // THIS model (the provider stays) — honest per-row verdict, no clamping.
  if (merged.api !== undefined) {
    if (typeof merged.api !== "string") {
      modelWarnings.push(`${subject}: api is not a string — model skipped`);
      return { model: null, warnings: warnings.concat(modelWarnings) };
    }
    if (merged.api === IMAGE_SOURCE_API_FAMILY) {
      modelWarnings.push(
        `${subject}: api "${IMAGE_SOURCE_API_FAMILY}" belongs to an Image Source row, not a chat ` +
          `provider — model skipped (create the image row in Configured and select it in Settings → ` +
          `Providers → Image Source)`,
      );
      return { model: null, warnings: warnings.concat(modelWarnings) };
    }
    if (!isAdmittedRelayApi(merged.api)) {
      modelWarnings.push(
        `${subject}: api "${merged.api}" has no cloud adaptor yet — model skipped ` +
          `(supported: ${SUPPORTED_API_LIST})`,
      );
      return { model: null, warnings: warnings.concat(modelWarnings) };
    }
    entry.api = merged.api;
  }
  if (Array.isArray(merged.input)) {
    const input = merged.input.filter(
      (modality): modality is "text" | "image" => modality === "text" || modality === "image",
    );
    if (input.length !== merged.input.length) {
      modelWarnings.push(
        `${subject}: input modalities outside text/image dropped (${String(
          merged.input.length - input.length,
        )} entries)`,
      );
    }
    if (input.length > 0) entry.input = input;
  } else if (merged.input !== undefined) {
    modelWarnings.push(`${subject}: input is not a list — dropped`);
  }
  if (merged.contextWindow !== undefined) {
    if (positiveInt(merged.contextWindow)) entry.contextWindow = merged.contextWindow;
    else {
      modelWarnings.push(
        `${subject}: contextWindow ${JSON.stringify(merged.contextWindow)} is not a positive integer — model skipped`,
      );
      return { model: null, warnings: warnings.concat(modelWarnings) };
    }
  }
  if (merged.maxTokens !== undefined) {
    if (positiveInt(merged.maxTokens)) entry.maxTokens = merged.maxTokens;
    else {
      modelWarnings.push(
        `${subject}: maxTokens ${JSON.stringify(merged.maxTokens)} is not a positive integer — model skipped`,
      );
      return { model: null, warnings: warnings.concat(modelWarnings) };
    }
  }
  if (merged.cost !== undefined) {
    const cost = asRecord(merged.cost);
    const valid =
      cost !== null &&
      ["input", "output", "cacheRead", "cacheWrite"].every(
        (field) =>
          typeof cost[field] === "number" && Number.isFinite(cost[field]) && cost[field] >= 0,
      );
    if (valid) entry.cost = merged.cost;
    else
      modelWarnings.push(
        `${subject}: cost is not a complete {input,output,cacheRead,cacheWrite} mapping — dropped`,
      );
  }
  // The pi thinking seat under construction (typed local — `entry` stays a
  // plain record until the seats are final).
  let thinkingSeat: {
    mode: RelayThinkingMode;
    efforts: RelayEffort[];
    defaultLevel?: RelayEffort;
    effortMap?: Partial<Record<RelayEffort, ResponsesEffort>>;
    requiresEffort?: boolean;
  } | undefined;
  if (merged.thinking !== undefined) {
    const thinking = normalizeThinking(merged.thinking, subject);
    modelWarnings.push(...thinking.warnings);
    if (thinking.efforts.length > 0) {
      // #534: the omp fragment IS the pi shape — mode/efforts/defaultLevel/
      // effortMap/requiresEffort ride through verbatim (no budget number is
      // invented; the wire budget is the named default ladder). omp's own
      // buildModel semantics: a thinking declaration reasons — when the
      // fragment omits the `reasoning` bit, the ladder implies it.
      thinkingSeat = {
        mode: thinking.mode,
        efforts: thinking.efforts,
        ...(thinking.defaultLevel !== undefined ? { defaultLevel: thinking.defaultLevel } : {}),
        ...(thinking.effortMap !== undefined ? { effortMap: thinking.effortMap } : {}),
        ...(thinking.requiresEffort === true ? { requiresEffort: true } : {}),
      };
      if (merged.reasoning !== false) entry.reasoning = true;
    }
  }
  // compat: only the effort map is representable; extraBody and the omp wire
  // flags would silently change behavior if dropped unnoticed, so they warn.
  const compat = asRecord(merged.compat);
  if (compat !== null) {
    const compatEffortMap = foldEffortMap(
      compat.reasoningEffortMap,
      subject,
      "compat.reasoningEffortMap",
      modelWarnings,
    );
    if (Object.keys(compatEffortMap).length > 0) {
      // thinking.effortMap (already seated) wins on conflicts — omp precedence.
      const seated = thinkingSeat?.effortMap;
      const folded = { ...compatEffortMap, ...(seated ?? {}) };
      if (thinkingSeat !== undefined) {
        thinkingSeat.effortMap = folded;
      } else if (Object.keys(folded).length > 0) {
        // Zero invention: a remap without a declared ladder has no rungs to
        // remap (the edge derives no implicit ladder) — dropped with the
        // named remedy, never silently lost.
        modelWarnings.push(
          `${subject}: compat.reasoningEffortMap without a thinking block has no ladder to remap — ` +
            `declare thinking.efforts alongside it`,
        );
      }
    }
    if (compat.extraBody !== undefined) {
      modelWarnings.push(
        `${subject}: compat.extraBody is not migrated — the cloud relay sends its own adaptor shapes`,
      );
    }
    const otherCompatKeys = Object.keys(compat).filter(
      (key) => key !== "reasoningEffortMap" && key !== "extraBody",
    );
    if (otherCompatKeys.length > 0) {
      modelWarnings.push(
        `${subject}: compat flags not migrated (${otherCompatKeys.join(", ")}) — the cloud relay ` +
          `applies its own adaptor semantics`,
      );
    }
  }
  const droppedKeys = Object.keys(merged).filter(
    (key) => !(MODEL_MAPPED_KEYS as readonly string[]).includes(key),
  );
  const declaredModelOnlyKeys = OMP_MODEL_ONLY_KEYS.filter((key) => merged[key] !== undefined);
  if (declaredModelOnlyKeys.includes("baseUrl")) {
    modelWarnings.push(`${subject}: per-model baseUrl is not supported — dropped`);
  }
  if (declaredModelOnlyKeys.includes("headers")) {
    modelWarnings.push(`${subject}: per-model headers are not migrated — dropped`);
  }
  if (droppedKeys.length > 0 || declaredModelOnlyKeys.length > 0) {
    const all = [...new Set([...droppedKeys, ...declaredModelOnlyKeys])];
    modelWarnings.push(`${subject}: omp-only declarations dropped (${all.join(", ")})`);
  }
  if (thinkingSeat !== undefined) entry.thinking = thinkingSeat;
  // The acceptance mechanism: every produced row re-validates against the
  // SAME zod schema the env catalog and the loader apply (#350). A mapper
  // bug surfaces as a named skip, never a corrupt stored row.
  const parsed = relayCatalogModelSchema.safeParse(entry);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue === undefined) {
      return { model: null, warnings: warnings.concat(modelWarnings) };
    }
    return {
      model: null,
      warnings: warnings.concat([
        `${subject}: failed the catalog schema (${issue.path.join(".")}: ${issue.message}) — skipped`,
      ]),
    };
  }
  return { model: parsed.data, warnings: warnings.concat(modelWarnings) };
}

/**
 * Parse one pasted fragment into CRUD candidates + explicit skips.
 * Accepts both the full `{providers: {...}}` shape and the bare inner map
 * (a pasted fragment may omit the wrapper). Every provider key in the
 * fragment gets exactly one verdict — created, skipped (with a named code),
 * or a fragment warning.
 */
export function parseModelsYml(text: string): ModelsYmlImportParse {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    // yaml errors quote document content — keep only the position/summary.
    const message = error instanceof Error ? error.message : String(error);
    const lineMatch = /line (\d+)/.exec(message);
    throw new ModelsYmlImportError(
      "import_yaml_invalid",
      `the pasted text is not valid YAML${
        lineMatch !== null ? ` (first error near line ${lineMatch[1]})` : ""
      }`,
    );
  }
  const root = asRecord(document);
  if (root === null) {
    throw new ModelsYmlImportError(
      "import_no_providers",
      "the pasted fragment must be a mapping of providers (or {providers: {...}})",
    );
  }
  const rawProviders = root.providers !== undefined ? asRecord(root.providers) : root;
  if (rawProviders === null || Object.keys(rawProviders).length === 0) {
    throw new ModelsYmlImportError(
      "import_no_providers",
      "no providers found under `providers:` — nothing to import",
    );
  }
  const parse: ModelsYmlImportParse = { providers: [], skips: [], warnings: [] };
  for (const [id, rawProvider] of Object.entries(rawProviders)) {
    const provider = asRecord(rawProvider);
    if (provider === null) {
      parse.skips.push({
        id,
        status: 422,
        code: "invalid_shape",
        message: `provider "${id}" is not a mapping — skipped`,
      });
      continue;
    }
    if (!isValidProviderConfigId(id)) {
      parse.skips.push({
        id,
        status: 422,
        code: "invalid_id",
        message: `provider id "${id}" does not match ^[A-Za-z0-9][A-Za-z0-9._-]*$ (max 64) — skipped`,
      });
      continue;
    }
    const warnings: string[] = [];
    const declaredApi = provider.api;
    let api: string | null = null;
    if (declaredApi !== undefined) {
      if (typeof declaredApi !== "string" || declaredApi === "") {
        parse.skips.push({
          id,
          status: 422,
          code: "invalid_shape",
          message: `provider "${id}": api is not a non-empty string — skipped`,
        });
        continue;
      }
      if (!isAdmittedRelayApi(declaredApi)) {
        // Out of the #361/#363 protocol families: the honest 4xx verdict —
        // no row is created (a dead row would set a dispatch trap), and the
        // provider is named, never silently dropped.
        parse.skips.push({
          id,
          status: 422,
          code: "unsupported_api",
          message: `provider "${id}": api "${declaredApi}" has no cloud adaptor yet — 暂不支持该协议 (supported: ${SUPPORTED_API_LIST})`,
        });
        continue;
      }
      api = declaredApi;
    }
    let baseUrl: string | null = null;
    if (provider.baseUrl !== undefined) {
      if (typeof provider.baseUrl === "string" && provider.baseUrl !== "") {
        baseUrl = provider.baseUrl;
      } else {
        warnings.push(`provider "${id}": baseUrl is not a non-empty string — dropped`);
      }
    }
    let apiKey: string | null = null;
    if (provider.apiKey !== undefined) {
      if (typeof provider.apiKey === "string" && provider.apiKey !== "") {
        if (provider.apiKey.startsWith("$$CREDENTIAL_") && provider.apiKey.endsWith("$$")) {
          warnings.push(
            `provider "${id}": apiKey is an omp credential placeholder ($$CREDENTIAL_…$$) and cannot be ` +
              `resolved server-side — imported WITHOUT a key; paste the real key on the row`,
          );
        } else {
          apiKey = provider.apiKey;
        }
      } else {
        warnings.push(`provider "${id}": apiKey is not a non-empty string — dropped`);
      }
    }
    // modelOverrides: omp merges these over discovered models; without the
    // local discovery cache only explicit models[] rows can receive them.
    const overrides = asRecord(provider.modelOverrides);
    const overrideTargetsKnown = new Set<string>();
    if (overrides !== null) {
      for (const [targetId, overrideValue] of Object.entries(overrides)) {
        if (asRecord(overrideValue) === null) {
          warnings.push(
            `provider "${id}": modelOverrides["${targetId}"] is not a mapping — dropped`,
          );
          continue;
        }
        overrideTargetsKnown.add(targetId);
      }
    }
    const models: RelayCatalogModel[] = [];
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models)) {
        warnings.push(`provider "${id}": models is not a list — ignored`);
      } else {
        for (const [index, rawModel] of provider.models.entries()) {
          const record = asRecord(rawModel);
          const fallbackId =
            record !== null && typeof record.id === "string" ? record.id : `models[${String(index)}]`;
          // overrideTargetsKnown only admits mapping values, so asRecord
          // returning null here is unreachable in practice — and harmless:
          // mapModelEntry treats a null override as "no merge".
          const override =
            overrides !== null && overrideTargetsKnown.has(fallbackId)
              ? asRecord(overrides[fallbackId])
              : null;
          const mapped = mapModelEntry(rawModel, override, fallbackId);
          warnings.push(...mapped.warnings);
          if (mapped.model !== null) models.push(mapped.model);
        }
      }
    }
    if (overrides !== null) {
      const consumedExplicit = new Set(models.map((model) => model.id));
      const orphans = [...overrideTargetsKnown].filter((targetId) => !consumedExplicit.has(targetId));
      if (orphans.length > 0) {
        warnings.push(
          `provider "${id}": modelOverrides for ${String(orphans.length)} discovered-only models ` +
            `(${orphans.join(", ")}) cannot migrate without the local discovery cache — ` +
            `import the row, then use Discover models and re-apply`,
        );
      }
    }
    if (provider.discovery !== undefined) {
      warnings.push(
        `provider "${id}": omp discovery is not migrated — import creates the row, then use the ` +
          `panel's Discover models to pull the upstream list`,
      );
    }
    const droppedProviderKeys = OMP_PROVIDER_DROPPED_KEYS.filter(
      (key) => provider[key] !== undefined,
    );
    if (droppedProviderKeys.length > 0) {
      warnings.push(
        `provider "${id}": omp-only keys dropped (${droppedProviderKeys.join(", ")}) — the cloud ` +
          `relay applies its own adaptor semantics`,
      );
    }
    if (models.length === 0 && provider.discovery === undefined) {
      warnings.push(
        `provider "${id}": declares no models and no discovery — imported as a non-dispatchable row; ` +
          `add models or use Discover`,
      );
    }
    parse.providers.push({ id, baseUrl, api, apiKey, models, warnings });
  }
  return parse;
}
