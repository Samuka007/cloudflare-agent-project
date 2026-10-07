import { z } from "zod";

/**
 * Relay provider catalog declaration (#350, #305 roadmap §3/§4.4) — the L1
 * directory vocabulary for "what the relay deployment bought":
 * providers × models × capabilities × declared flags. #450: the edge env
 * seed (MODEL_RELAY_CATALOG) is retired — the D1 provider_configs rows
 * (decoded by the server loader into this schema) are the sole directory
 * 正本; the schema itself stays the shared vocabulary. Public, zero-secret:
 * credentials never enter this ledger (keys live in the D1 encrypted column
 * — #255 ruling C); only declaration-grade fields are representable.
 *
 * Two faces consume one declaration (#319 dual-face pattern generalized to
 * the catalog layer):
 * - edge D1 provider_configs rows (this schema, via the server loader) →
 *   the picker/directory faces (apps/server-worker routes/system.ts
 *   execution-options + the provider-projections catalog row) and the
 *   registry resolution (apps/provider-app relay-registry.ts); the harness
 *   deployment channel no longer folds rows (#450);
 * - daemon `DAEMON_AGENT_AUTH.providers` → the judge/security ModelRegistry
 *   (packages/daemon-service agent-auth.ts).
 *
 * The MODEL-LEVEL FIELD DICTIONARY below is shared verbatim by both faces —
 * one zod vocabulary, no second source to drift (roadmap §4.4). Provider-
 * level fields stay channel-specific: the daemon wrapper carries credential
 * fields (`apiKey`/`auth`/`headers`) that the edge catalog must never carry,
 * and the edge wrapper carries presentation/capability fields the daemon
 * never needed (`displayName`/`serviceTier`/reasoning ladder overrides).
 *
 * Strictness is deliberate: a misspelled declared field
 * (`contextwindow`, `displayName` on a model row) must fail the deployment
 * loudly at decode, not silently strip into capability under-declaration —
 * the exact disease this layer treats.
 */

// ---------------------------------------------------------------------------
// Reasoning-level vocabulary
// ---------------------------------------------------------------------------

/**
 * The reasoning ladder vocabulary (bb reasoningLevelValues, server contract
 * shared-types.ts:18-27 / daemon-worker provider-types.ts:17-27). The two bb
 * contract copies must stay literal-identical to this array — both sides
 * guard the parity at compile time (harness execution options; the
 * execution-options projection's typed return).
 */
export const relayReasoningLevelValues = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;
export type RelayReasoningLevel = (typeof relayReasoningLevelValues)[number];
export const relayReasoningLevelSchema = z.enum(relayReasoningLevelValues);

/**
 * bb's custom-model default rung for "extended thinking on" (bb
 * thread-default-policy / customModels `defaultReasoningEffort: "medium"`).
 * The relay wire has one thinking knob (the row's thinkingBudgetTokens) —
 * until per-thread selection consumes a ladder (#351), the honest
 * projection of "budget on" for a row that declares no ladder is exactly
 * this one rung, not a multi-rung ladder the wire cannot distinguish.
 */
export const DEFAULT_THINKING_REASONING_LEVEL: RelayReasoningLevel = "medium";

export interface RelayReasoningDerivationInput {
  /**
   * Thinking flag: the row's budget is on (thinkingBudgetTokens set > 0;
   * #500: the deployment-wide env flag is deleted).
   */
  thinkingEnabled: boolean;
  /** Model-declared ladder override (relayCatalogModelSchema.reasoningLevels). */
  declaredLevels?: readonly RelayReasoningLevel[];
  /** Model-declared default rung (relayCatalogModelSchema.defaultReasoningLevel). */
  declaredDefault?: RelayReasoningLevel;
}

export interface RelayReasoningLadder {
  levels: RelayReasoningLevel[];
  defaultLevel: RelayReasoningLevel;
}

/**
 * Derive the runnable reasoning ladder a model row advertises:
 * - thinking disabled → exactly `["none"]`: extended thinking never runs, so
 *   offering budget rungs would over-claim dispatch the wire ignores
 *   (roadmap §2.3 contradiction 2 — the budget flag must reach the directory).
 * - thinking enabled, no declared ladder → the single honest rung
 *   (DEFAULT_THINKING_REASONING_LEVEL).
 * - thinking enabled + declared ladder → the declaration verbatim, defaulting
 *   to the declared default (schema guarantees membership) or the medium rung
 *   when the declaration names none.
 */
export function deriveRelayReasoning(input: RelayReasoningDerivationInput): RelayReasoningLadder {
  if (!input.thinkingEnabled) {
    return { levels: ["none"], defaultLevel: "none" };
  }
  const declared = input.declaredLevels;
  if (declared === undefined) {
    return {
      levels: [DEFAULT_THINKING_REASONING_LEVEL],
      defaultLevel: DEFAULT_THINKING_REASONING_LEVEL,
    };
  }
  const defaultLevel =
    input.declaredDefault ??
    (declared.includes(DEFAULT_THINKING_REASONING_LEVEL)
      ? DEFAULT_THINKING_REASONING_LEVEL
      : (declared[0] ?? DEFAULT_THINKING_REASONING_LEVEL));
  return { levels: [...declared], defaultLevel };
}

// ---------------------------------------------------------------------------
// Relay API family + OpenAI effort mapping (#361/#363 adaptor seam)
// ---------------------------------------------------------------------------

/**
 * The relay's protocol-face vocabulary — exactly the api families the edge
 * relay speaks (omp models.yml field dictionary subset: `anthropic-messages`
 * is the #34 incumbent face, `openai-responses` the #361 adaptor and
 * `openai-completions` the #363 adaptor). The EDGE
 * catalog validates this enum at decode (strict: an api label the relay
 * cannot speak fails the deployment loudly, never silently rides the
 * anthropic wire); the shared model dictionary and the daemon
 * `DAEMON_AGENT_AUTH` face keep the free-form omp vocabulary (judge/security
 * models may declare families this relay never dials).
 */
export const relayApiValues = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
] as const;
export type RelayApi = (typeof relayApiValues)[number];
export const relayApiSchema = z.enum(relayApiValues);
export const DEFAULT_RELAY_API: RelayApi = "anthropic-messages";

/**
 * The faces that consume a reasoning rung → OpenAI effort fold (both openai
 * wire shapes carry an official effort field — `reasoning.effort` on
 * responses, `reasoning_effort` on chat completions — with the SAME value
 * vocabulary; the anthropic face keeps its budget semantics). #363: one
 * predicate so the three fold sites (resolveRelaySelection, the harness
 * resolution, the registry resolve) cannot grow a second opinion.
 */
export const OPENAI_EFFORT_API_FACES: readonly RelayApi[] = [
  "openai-responses",
  "openai-completions",
];

export function relayApiConsumesEffortMap(api: RelayApi): boolean {
  return OPENAI_EFFORT_API_FACES.includes(api);
}

/**
 * Resolve a deployment-grade api label (env scalar, credential slot row)
 * to the RelayApi face. Blank → the default; anything outside the enum is
 * a loud construction-time failure (the AGENT_DO_IMAGE_SOURCE posture —
 * a silent wrong-protocol fallback would surface as upstream 404s).
 */
export function resolveRelayApi(raw: string | undefined | null): RelayApi {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return DEFAULT_RELAY_API;
  const parsed = relayApiSchema.safeParse(trimmed);
  if (!parsed.success) {
    throw new Error(
      `unknown relay api "${trimmed}" — supported: ${JSON.stringify(relayApiValues)}`,
    );
  }
  return parsed.data;
}

/**
 * The OpenAI effort target vocabulary (official current schema: none,
 * minimal, low, medium, high, xhigh, max — the #361 protocol canon, not
 * memory; #363 grounded the chat-completions `reasoning_effort` field
 * against the same list, so one type serves both openai faces).
 */
export const responsesEffortValues = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ResponsesEffort = (typeof responsesEffortValues)[number];
export const responsesEffortSchema = z.enum(responsesEffortValues);

/**
 * Default relay-rung → effort mapping: identity for every rung the official
 * effort vocabulary also names. The relay-only rungs (`ultra`, `ultracode`)
 * are deliberately unmapped — a rung the wire cannot honestly express must
 * 422 at selection (the #351 fail-closed red line), never clamp silently.
 */
export const DEFAULT_REASONING_EFFORT_BY_RUNG: Partial<
  Record<RelayReasoningLevel, ResponsesEffort>
> = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * A ladder rung the responses face cannot express (no default mapping and
 * no per-model override). Named so the registry can translate it into the
 * #351 selection-grammar 422 instead of a wire-time surprise.
 */
export class RelayEffortMapError extends Error {
  constructor(
    readonly rung: RelayReasoningLevel,
    message?: string,
  ) {
    super(
      message ??
        `reasoning rung "${rung}" has no responses-effort mapping ` +
          `(declare reasoningEffortMap["${rung}"] on the model row, ` +
          `omp models.yml compat.reasoningEffortMap dictionary precedent)`,
    );
    this.name = "RelayEffortMapError";
  }
}

/**
 * Resolve one relay rung to the Responses reasoning.effort string: the
 * model row's per-model map wins (omp models.yml compat.reasoningEffortMap
 * precedent — the deepseek rows map {high: high, xhigh: max}), then the
 * default identity mapping, then the honest RelayEffortMapError.
 */
export function resolveResponsesEffort(
  rung: RelayReasoningLevel,
  map?: Partial<Record<RelayReasoningLevel, ResponsesEffort>>,
): ResponsesEffort {
  const mapped = map?.[rung] ?? DEFAULT_REASONING_EFFORT_BY_RUNG[rung];
  if (mapped === undefined) throw new RelayEffortMapError(rung);
  return mapped;
}

// ---------------------------------------------------------------------------
// Shared field dictionary (model entries — edge + daemon, one vocabulary)
// ---------------------------------------------------------------------------

/**
 * The shared model-entry dictionary: identical to the daemon-side
 * `DAEMON_AGENT_AUTH.providers[].models[]` vocabulary (omp models.yml field
 * set — id/name/api/reasoning/input/contextWindow/maxTokens/cost). The edge
 * catalog extends it with picker-face fields; the daemon wrapper adds none.
 */
export const relayModelEntrySchema = z.strictObject({
  /** Model id as the relay wire addresses it (e.g. `glm-5.3`). */
  id: z.string().min(1),
  /** Display name; defaults to the id on the picker face. */
  name: z.string().min(1).optional(),
  /** API family label (dictionary parity with the daemon defs). */
  api: z.string().min(1).optional(),
  /** Reasoning capability bit (declarative; the ladder is budget-derived). */
  reasoning: z.boolean().optional(),
  /** Input modalities; `image` projects the #319 image-input capability. */
  input: z.array(z.enum(["text", "image"])).optional(),
  /** Declared context window (tokens). */
  contextWindow: z.number().int().positive().optional(),
  /** Declared per-call completion budget (tokens). */
  maxTokens: z.number().int().positive().optional(),
  /** Public pricing declaration (parity with the daemon defs). */
  cost: z
    .strictObject({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
    })
    .optional(),
});
export type RelayModelEntry = z.infer<typeof relayModelEntrySchema>;

// ---------------------------------------------------------------------------
// Edge catalog schema (MODEL_RELAY_CATALOG)
// ---------------------------------------------------------------------------

/**
 * Edge model row: the shared dictionary plus the picker-face declarations.
 * No credential field exists anywhere in this schema — an `apiKey` attempt
 * fails the strict decode (secrets live in env/secret slots, never in the
 * public ledger).
 */
export const relayCatalogModelSchema = relayModelEntrySchema
  .extend({
    /**
     * #361: the protocol face this row dispatches under — the EDGE relay
     * vocabulary (enum-validated at decode; the shared dictionary above
     * stays free-form for daemon parity). Absent → the provider row's api,
     * then anthropic-messages.
     */
    api: relayApiSchema.optional(),
    /**
     * Per-model reasoning-rung → Responses effort map (omp models.yml
     * compat.reasoningEffortMap dictionary precedent, deepseek rows:
     * {high: high, xhigh: max}). Consumed by the openai-responses face;
     * unmapped rungs fail closed at selection (RelayEffortMapError → 422).
     */
    reasoningEffortMap: z
      .partialRecord(relayReasoningLevelSchema, responsesEffortSchema)
      .optional(),
    /** bb AvailableModel.description (picker subtitle). */
    description: z.string().optional(),
    /**
     * Per-model thinking budget (#362 scope absorption ①; the ONLY budget
     * source since #500 deleted the deployment-wide env scalar): the row's
     * reasoning budget rides this field — absent = budget-off. A panel edit
     * hot-applies through the catalog overlay.
     */
    thinkingBudgetTokens: z.number().int().positive().optional(),
    /**
     * Explicit ladder override. Unset → budget-derived (deriveRelayReasoning).
     * Dormant while the row's budget is off: the wire cannot run any budget
     * rung, so the projection stays `["none"]` regardless of the declaration.
     */
    reasoningLevels: z.array(relayReasoningLevelSchema).min(1).optional(),
    /** Default rung of the declared ladder (must be a member when both set). */
    defaultReasoningLevel: relayReasoningLevelSchema.optional(),
  })
  .refine(
    (model) =>
      model.defaultReasoningLevel === undefined ||
      model.reasoningLevels === undefined ||
      model.reasoningLevels.includes(model.defaultReasoningLevel),
    { message: "defaultReasoningLevel must be a member of reasoningLevels" },
  );
export type RelayCatalogModel = z.infer<typeof relayCatalogModelSchema>;

/**
 * #362 scope absorption ②: the api family that marks a provider row as an
 * IMAGE source (the generate_image tool's OpenAI-images endpoint). Such rows
 * carry their own source config + switch (row presence is the opt-in); they
 * are excluded from the LLM selection directory and ride the panel CRUD face.
 */
export const IMAGE_SOURCE_API_FAMILY = "openai-images";

// ---------------------------------------------------------------------------
// #485 row/model family split (chat vs image-source)
// ---------------------------------------------------------------------------

/**
 * #485 the row/model family vocabulary. A provider row and its model entries
 * MUST belong to one family, and the family is the row-level api seat:
 *
 * - "chat": the #361 relay faces (api unset/relay) — model entries are the
 *   chat dictionary (reasoning/input/contextWindow/maxTokens/thinking
 *   ladder/cost-per-token).
 * - "image": the #362/#448 image-source family (`api=openai-images`) —
 *   model entries carry IMAGE semantics (sizes/outputFormat/per-image cost)
 *   and none of the chat seats; the row is excluded from the LLM selection
 *   directory and serves generate_image through the image_source seat.
 *
 * The family pairing is enforced structurally (the two provider branches
 * below), at the CRUD write faces (family-paired 422s), by the loader
 * (defensive, skip-with-warning) and by the discovery/import faces (the
 * `family` seat + explicit warnings pointing image ids at the Image Source
 * row).
 */
export const providerModelFamilyValues = ["chat", "image"] as const;
export type ProviderModelFamily = (typeof providerModelFamilyValues)[number];
export const providerModelFamilySchema = z.enum(providerModelFamilyValues);

/**
 * #485 the image-source row's model-entry dictionary: image semantics only.
 * Strict by construction — the chat seats (reasoning, input, contextWindow,
 * maxTokens, thinkingBudgetTokens, reasoningLevels, defaultReasoningLevel,
 * reasoningEffortMap, the per-token cost object) have no seat here, so an
 * image row can never look like a chat model on any surface.
 */
export const relayImageModelSchema = z.strictObject({
  /** Model id as the images wire addresses it (e.g. `gpt-image-2`). */
  id: z.string().min(1),
  /** Display name; defaults to the id on the panel face. */
  name: z.string().min(1).optional(),
  /** Display subtitle (parity with chat entries; display-only). */
  description: z.string().optional(),
  /**
   * The generation sizes this model accepts (e.g.
   * ["1024x1024","1536x1024","1024x1536"]). Display/declaration grade — the
   * wire size rides each generate_image request (aspect-ratio resolution).
   */
  sizes: z.array(z.string().min(1)).min(1).optional(),
  /** The output format the upstream returns for this model. */
  outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  /** Per-image pricing (USD per generated image). */
  cost: z.strictObject({ perImage: z.number().nonnegative() }).optional(),
});
export type RelayImageModel = z.infer<typeof relayImageModelSchema>;

/**
 * The image dictionary's own key set — the write gates and the loader's
 * strip-unknown recovery name the offending seats from it (one vocabulary,
 * no parallel list to drift).
 */
export const relayImageModelKeys: string[] = Object.keys(relayImageModelSchema.shape);

/**
 * #485 curated image-generation id markers (lowercased substring match) —
 * the import faces' guard for image ids that appear in a CHAT row/upstream
 * list. Deliberately conservative and loud: a marker match REJECTS/WARNS
 * with the Image Source pointer, never a silent chat import. The
 * authoritative split stays the row-level family seat — this list only
 * catches the well-known families when the family seat says "chat".
 */
const IMAGE_GENERATION_ID_MARKERS = [
  "gpt-image", // OpenAI Images API family (gpt-image-1/2/2.5…)
  "dall-e", // OpenAI legacy
  "dalle", // aggregator spelling of the above
  "imagen", // Google Imagen family
  "flux", // Black Forest Labs FLUX family
  "stable-diffusion", // Stability AI family
  "sdxl", // Stability SDXL
  "sd3", // Stability SD3.x
  "qwen-image", // Alibaba Qwen-Image family
  "seedream", // ByteDance Seedream family
  "wanx", // Alibaba Tongyi Wanxiang text-to-image
  "ideogram", // Ideogram family
  "recraft", // Recraft family
] as const;

/** A whole `image`/`images` id segment, e.g. `gemini-2.5-flash-image`. */
const IMAGE_ID_SEGMENT_PATTERN = /(?:^|[/._-])images?(?:[/._-]|$)/;

/**
 * #485: does this model id name an image-generation model? Used by the
 * import faces (discovery, models.yml) and the loader to keep image ids off
 * chat rows — a false positive refuses/warns loudly with the Image Source
 * pointer (repairable), while the row-level family seat remains the
 * authoritative split.
 */
export function isImageGenerationModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  if (normalized === "") return false;
  return (
    IMAGE_GENERATION_ID_MARKERS.some((marker) => normalized.includes(marker)) ||
    IMAGE_ID_SEGMENT_PATTERN.test(normalized)
  );
}

const relayCatalogProviderShellFields = {
  /** Picker display name; defaults to the provider key. */
  displayName: z.string().min(1).optional(),
  /**
   * Public endpoint declaration (projection-grade — the same trust level the
   * read faces already project). This is the wire base every dispatch dials
   * (#500: the retired env scalar is gone — the row IS the base); it
   * documents the bought channel and never carries a credential.
   */
  baseUrl: z.string().min(1).optional(),
  /** bb ProviderCapabilities.supportsServiceTier projection. */
  serviceTier: z.boolean().optional(),
};

/**
 * #485 the image-source row branch: `api` is literally the image family and
 * the models are image entries. No chat seat exists on this branch (strict).
 */
export const relayImageSourceProviderSchema = z.strictObject({
  ...relayCatalogProviderShellFields,
  api: z.literal(IMAGE_SOURCE_API_FAMILY),
  models: z.array(relayImageModelSchema).min(1),
});
export type RelayImageSourceProvider = z.infer<typeof relayImageSourceProviderSchema>;

/**
 * The chat branch: the #361 relay faces (api optional — an unset seat rides
 * the relay default face), models are chat entries. `openai-images` is NOT
 * admitted here — an image model id or image semantics on this branch is a
 * family mismatch, rejected with the named 422s.
 */
export const relayChatCatalogProviderSchema = z.strictObject({
  ...relayCatalogProviderShellFields,
  api: relayApiSchema.optional(),
  models: z.array(relayCatalogModelSchema).min(1),
});
export type RelayChatCatalogProvider = z.infer<typeof relayChatCatalogProviderSchema>;

/**
 * #485: the family-discriminated provider schema. The branch IS the family —
 * `api: "openai-images"` admits only image entries; every other (or unset)
 * api admits only chat entries. Downstream narrowing
 * (`provider.api === IMAGE_SOURCE_API_FAMILY`) resolves the model type.
 */
export const relayCatalogProviderSchema = z.union([
  relayImageSourceProviderSchema,
  relayChatCatalogProviderSchema,
]);
export type RelayCatalogProvider = z.infer<typeof relayCatalogProviderSchema>;

/** #485 the family discriminant as a guard (narrows the model-entry type). */
export function isImageSourceProvider(
  provider: RelayCatalogProvider,
): provider is RelayImageSourceProvider {
  return provider.api === IMAGE_SOURCE_API_FAMILY;
}

export const relayCatalogSchema = z
  .strictObject({
    /**
     * Default provider id (the seam default-execution-options reports).
     * Unset → the first provider key in declaration order.
     */
    defaultProvider: z.string().min(1).optional(),
    providers: z.record(z.string().min(1), relayCatalogProviderSchema),
  })
  .refine((catalog) => Object.keys(catalog.providers).length > 0, {
    message: "providers must declare at least one entry",
  })
  .refine(
    (catalog) =>
      catalog.defaultProvider === undefined ||
      catalog.providers[catalog.defaultProvider] !== undefined,
    { message: "defaultProvider must name a declared provider key" },
  );
export type RelayCatalog = z.infer<typeof relayCatalogSchema>;

/**
 * Decode the `MODEL_RELAY_CATALOG` env JSON (#102 decodeAgentAuthConfig
 * shape): null when unset/blank, zod rejection (never silent fallback) on
 * shape violations. Callers that must stay total (the harness resolution)
 * catch and degrade; the projection faces surface the decode error.
 */
export function decodeRelayCatalog(raw: string | undefined): RelayCatalog | null {
  if (raw === undefined || raw.trim() === "") return null;
  return relayCatalogSchema.parse(JSON.parse(raw));
}

/**
 * Locate a model row by id: the default provider first, then the remaining
 * keys in declaration order (ids are not schema-unique across providers —
 * first match wins in that priority order).
 */
export function findRelayCatalogModel(
  catalog: RelayCatalog,
  modelId: string,
): { providerId: string; model: RelayCatalogModel } | undefined {
  const keys = Object.keys(catalog.providers);
  const ordered =
    catalog.defaultProvider !== undefined
      ? [catalog.defaultProvider, ...keys.filter((key) => key !== catalog.defaultProvider)]
      : keys;
  for (const providerId of ordered) {
    const provider = catalog.providers[providerId];
    // #485: image-source rows carry image entries and are not chat model
    // rows — a lookup for chat dispatch skips them entirely.
    if (provider === undefined || provider.api === IMAGE_SOURCE_API_FAMILY) continue;
    const model = provider.models.find((entry) => entry.id === modelId);
    if (model !== undefined) {
      return { providerId, model };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Thread-level selection resolution (#351 — the L4 consumption chain)
// ---------------------------------------------------------------------------

/**
 * The reserved legacy provider id (#434 retired the sentinel semantics: a
 * selection naming "omp" is an unknown provider like any other, and
 * sentinel-era stored rows/threads fail loudly — point ⑧). The id stays
 * refused on the provider-config CRUD write face so a new user row cannot
 * silently resurrect those journals, and the agent-do compose rig keeps it
 * as its single declared directory row.
 */
export const SYNTHETIC_RELAY_PROVIDER_ID = "omp";

/** A thread-level execution selection (threads row overrides / create/send payloads). */
export interface RelaySelection {
  providerId?: string;
  model?: string;
  reasoningLevel?: RelayReasoningLevel;
}

export type RelaySelectionErrorCode =
  "provider_default_undeclared" | "provider_unknown" | "model_unknown" | "reasoning_level_unknown";

/**
 * Fail-closed selection rejection (ROADMAP red line: unknown values 422 with
 * a named error — never silently relax onto another provider/model row).
 */
export class RelaySelectionError extends Error {
  constructor(
    readonly code: RelaySelectionErrorCode,
    readonly field: "providerId" | "model" | "reasoningLevel",
    message: string,
  ) {
    super(message);
    this.name = "RelaySelectionError";
  }
}

/**
 * The directory slice the resolver reads. Structural by design: the
 * provider-app catalog projection rows (`RelayCatalogModelRow`) satisfy it,
 * so validation (#350 projection face) and dispatch (registry) read ONE
 * resolution — the picker face and the turns-actually-run dispatch cannot
 * disagree on what a selection means.
 */
export interface RelaySelectionDirectoryRow {
  providerId: string;
  id: string;
  reasoningLevels: readonly RelayReasoningLevel[];
  defaultReasoningLevel: RelayReasoningLevel;
  /**
   * #361: the row's protocol face (model api ?? provider api ?? default).
   * The effort-mapping fail-closed check below applies only to
   * openai-effort faces — the anthropic face keeps its budget semantics.
   */
  api?: RelayApi;
  /** The row's per-model effort map (RelayCatalogModel.reasoningEffortMap). */
  reasoningEffortMap?: Partial<Record<RelayReasoningLevel, ResponsesEffort>>;
  /**
   * The row's EFFECTIVE thinking budget (#362): model-declared budget
   * winning over the deployment scalar. `undefined` = legacy row that
   * predates the seat (falls back to `directory.thinkingEnabled`);
   * `null` = explicitly budget-off; a number = enabled with that budget.
   */
  thinkingBudgetTokens?: number | null;
}

export interface RelaySelectionDirectory {
  rows: readonly RelaySelectionDirectoryRow[];
  /**
   * The declaration's defaultProvider; null when the declaration names none
   * (#434: no first-key fill — an undeclared default fails closed).
   */
  defaultProviderId: string | null;
  /**
   * The directory's default model — a provider's default fill for a
   * model-less selection. Empty since #500: no deployment model is named
   * (the thread selection is the model source), so a model-less selection
   * fails closed and the caller must pass the model explicitly.
   */
  defaultModelId: string;
  /**
   * Directory-wide thinking fallback for rows that predate the per-row
   * budget seat (their `thinkingBudgetTokens` is undefined). The relay
   * registry passes false since #500 (no deployment budget scalar).
   */
  thinkingEnabled: boolean;
}

export interface ResolvedRelaySelection {
  providerId: string;
  modelId: string;
  reasoningLevel: RelayReasoningLevel;
}

/**
 * Resolve one thread-level selection against the catalog directory:
 *
 * - provider: explicit ?? the declaration's defaultProvider — and a
 *   selection with neither is a named 422 (no sentinel, no first-key guess:
 *   #434 fail-closed, the declaration is the only configuration source);
 * - model: explicit (must sit in the resolved provider's rows) ?? the
 *   directory's defaultModelId when the provider declares it — since #500
 *   that id is empty (no deployment model), so a model-less selection has
 *   NO default and demands an explicit model (named error, not a guessed
 *   first row);
 * - reasoning level: explicit (must sit in the row's runnable ladder) ?? the
 *   row's derived default. The ladder is budget-collapsed exactly like the
 *   picker face (deriveRelayReasoning) — budget off admits only "none",
 *   so a stored non-none rung from a budget-on era fails loudly on replay
 *   instead of silently downgrading (contradiction-2 discipline).
 */
export function resolveRelaySelection(
  directory: RelaySelectionDirectory,
  selection: RelaySelection,
): ResolvedRelaySelection {
  let providerId: string;
  if (selection.providerId !== undefined) {
    providerId = selection.providerId;
  } else if (directory.defaultProviderId !== null) {
    providerId = directory.defaultProviderId;
  } else {
    throw new RelaySelectionError(
      "provider_default_undeclared",
      "providerId",
      "no provider selected and the declaration names no defaultProvider — " +
        "pass providerId explicitly or declare defaultProvider in the catalog",
    );
  }
  const providerRows = directory.rows.filter((row) => row.providerId === providerId);
  if (providerRows.length === 0) {
    const declared = [...new Set(directory.rows.map((row) => row.providerId))].sort();
    throw new RelaySelectionError(
      "provider_unknown",
      "providerId",
      `unknown provider "${selection.providerId}" — declared providers: ${JSON.stringify(declared)}`,
    );
  }
  const row =
    selection.model !== undefined
      ? providerRows.find((candidate) => candidate.id === selection.model)
      : providerRows.find((candidate) => candidate.id === directory.defaultModelId);
  if (row === undefined) {
    const declared = providerRows.map((candidate) => candidate.id);
    throw new RelaySelectionError(
      "model_unknown",
      "model",
      selection.model === undefined
        ? `provider "${providerId}" has no resolvable default model ` +
            `(the directory default "${directory.defaultModelId}" is not one of its rows: ` +
            `${JSON.stringify(declared)}) — pass model explicitly`
        : `unknown model "${selection.model}" for provider "${providerId}" — ` +
            `declared models: ${JSON.stringify(declared)}`,
    );
  }
  // #362: the ladder collapses per ROW budget, not the deployment scalar —
  // a model row carrying thinkingBudgetTokens runs its declared rungs even
  // when the env budget is unset (and stays ["none"] when it declares none).
  const thinkingEnabled =
    row.thinkingBudgetTokens === undefined
      ? directory.thinkingEnabled
      : row.thinkingBudgetTokens !== null;
  const ladder = deriveRelayReasoning({
    thinkingEnabled,
    declaredLevels: row.reasoningLevels,
    declaredDefault: row.defaultReasoningLevel,
  });
  const reasoningLevel = selection.reasoningLevel ?? ladder.defaultLevel;
  if (!ladder.levels.includes(reasoningLevel)) {
    throw new RelaySelectionError(
      "reasoning_level_unknown",
      "reasoningLevel",
      `reasoning level "${reasoningLevel}" is not in the runnable ladder ` +
        `${JSON.stringify(ladder.levels)} for ${providerId}/${row.id}`,
    );
  }
  // #361/#363 fail-closed effort mapping: on the openai-effort faces a rung
  // the wire cannot honestly express (no default identity mapping and no
  // per-model reasoningEffortMap entry) is a named 422 — never a silent
  // clamp onto another effort value.
  if (row.api !== undefined && relayApiConsumesEffortMap(row.api)) {
    try {
      resolveResponsesEffort(reasoningLevel, row.reasoningEffortMap);
    } catch (error) {
      if (error instanceof RelayEffortMapError) {
        throw new RelaySelectionError("reasoning_level_unknown", "reasoningLevel", error.message);
      }
      throw error;
    }
  }
  return { providerId, modelId: row.id, reasoningLevel };
}
