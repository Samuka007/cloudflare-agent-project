import { z } from "zod";
// #534 the model-thinking 正本 (omp pi-catalog, npm-vendored exact pin):
// the ladder/capability domain is pi's derivation, not a fork — runtime
// helpers are field-readers over `{ reasoning, thinking }` (Workers-pure,
// raw-TS package), imported per function with the omp anchor in the doc.
import {
  defaultSupportedEffort as piDefaultSupportedEffort,
  getSupportedEfforts as piGetSupportedEfforts,
  mapEffortToAnthropicAdaptiveEffort as piMapEffortToAnthropicAdaptiveEffort,
  resolveWireModelId as piResolveWireModelId,
} from "@oh-my-pi/pi-catalog/model-thinking";
import type { Effort as PiEffort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { RelayOutputConfig, ThinkingConfig } from "./relay/wire.js";

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
 * One face consumes this declaration (#523): edge D1 provider_configs rows
 * (this schema, via the server loader) → the picker/directory faces
 * (apps/server-worker routes/system.ts execution-options + the
 * provider-projections catalog row) and the registry resolution
 * (apps/provider-app relay-registry.ts). find's judge leg is edge-side too
 * (#523): the judge model resolves from the thread's pinned selection
 * through the same D1 正本 chain (`resolveTurnModel` →
 * `provider.completeText`) — the daemon host holds no model registry and
 * runs find as a pure execution leg (find-protocol v1 candidate payloads).
 *
 * The MODEL-LEVEL FIELD DICTIONARY below is the edge catalog's own entry
 * vocabulary — one zod definition, no second source to drift. Its former
 * daemon-side twin (a credential-bearing registry materialized from the
 * retired agent-auth env channel, packages/daemon-service agent-auth.ts)
 * was deleted with that channel (#523): only the edge schema survives,
 * credential fields (`apiKey`/`auth`/`headers`) exist nowhere in it.
 *
 * Strictness is deliberate: a misspelled declared field
 * (`contextwindow`, `displayName` on a model row) must fail the deployment
 * loudly at decode, not silently strip into capability under-declaration —
 * the exact disease this layer treats.
 *
 * #534 (user ruling 2026-10-08): the model reasoning domain is the omp
 * pi-catalog 正本 — the row speaks pi's shape (`reasoning: boolean` +
 * `thinking?: { mode, efforts, defaultLevel?, effortMap?, effortRouting?,
 * effortBudgets?, requiresEffort? }`), imported from
 * `@oh-my-pi/pi-catalog/model-thinking` (npm exact pin, Workers-pure). The
 * retired `thinkingBudgetTokens` seat — one field that served as capability
 * gate, ladder driver, and decorative number — is GONE from the output
 * shape: its only remaining life is the compat-read fold below
 * (foldLegacyModelRow), which migrates stored legacy rows onto the pi shape
 * so a re-imported model list can never collapse a declared ladder again.
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
 * The OpenAI effort target vocabulary (official current schema: none,
 * minimal, low, medium, high, xhigh, max — the #361 protocol canon, not
 * memory; #363 grounded the chat-completions `reasoning_effort` field
 * against the same list, so one type serves both openai faces). Declared
 * before the thinking schema: `effortMap` values validate against it.
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
 * The pi Effort vocabulary MINUS `minimal` (pi-catalog/effort.ts THINKING_EFFORTS
 * anchor): the edge ladder must stay expressible on the bb rung vocabulary
 * (RelayReasoningLevel) the composer/selection grammar speaks, and bb names
 * no minimal rung — the models.yml import drops a declared minimal WITH a
 * warning (never a silent clamp onto a neighbor), exactly as it did against
 * the retired reasoningLevels field.
 */
export const relayEffortValues = ["low", "medium", "high", "xhigh", "max"] as const;
export type RelayEffort = (typeof relayEffortValues)[number];
export const relayEffortSchema = z.enum(relayEffortValues);

/**
 * The pi ThinkingControlMode vocabulary verbatim (pi-catalog types.ts:68-74):
 * the transport the wire uses to encode the selected effort. The edge relay
 * consumes "budget" (anthropic `thinking.budget_tokens`) and the two
 * anthropic adaptive modes (`output_config.effort`); "effort" names the
 * openai effort faces' transport, "google-level" rides as declared
 * vocabulary (an anthropic/openai row may carry it; the wire folds it to the
 * face's own knob).
 */
export const relayThinkingModeValues = [
  "effort",
  "budget",
  "google-level",
  "anthropic-adaptive",
  "anthropic-budget-effort",
] as const;
export type RelayThinkingMode = (typeof relayThinkingModeValues)[number];
export const relayThinkingModeSchema = z.enum(relayThinkingModeValues);

/**
 * The pi ThinkingConfig shape (pi-catalog types.ts:77-134), subset admitted
 * on the edge: every seat is capability metadata — the budget NUMBER is a
 * wire detail (`effortBudgets`), never a capability gate. `efforts` is
 * ordered least → most intensive and never empty when the seat is present
 * (pi's own invariant: a reasoning model without a controllable effort
 * surface carries `thinking: undefined`, not an empty list).
 */
export const relayModelThinkingSchema = z.strictObject({
  mode: relayThinkingModeSchema,
  efforts: z.array(relayEffortSchema).min(1),
  /** Pi defaultLevel: the effort applied when the model is selected. */
  defaultLevel: relayEffortSchema.optional(),
  /**
   * Pi effortMap: effort → provider wire-value remap (identity for omitted
   * efforts). The edge constrains values to the official responses effort
   * vocabulary PLUS the anthropic adaptive sentinel "adaptive" — one map
   * serves both faces, so an off-vocabulary value has no honest consumer.
   */
  effortMap: z
    .partialRecord(relayEffortSchema, z.union([responsesEffortSchema, z.literal("adaptive")]))
    .optional(),
  /**
   * Pi effortRouting: per-effort upstream wire-id routing (collapsed
   * effort-tier variants). `"off"` applies when thinking is disabled.
   */
  effortRouting: z
    .partialRecord(z.enum([...relayEffortValues, "off"]), z.string().min(1))
    .optional(),
  /**
   * Pi effortBudgets: per-effort `thinking.budget_tokens` wire values for
   * budget-transport rows. The LADDER never derives from these — a missing
   * entry rides the named default ladder (relayAnthropicThinking).
   */
  effortBudgets: z.partialRecord(relayEffortSchema, z.number().int().positive()).optional(),
  /**
   * Pi requiresEffort: thinking-off must be explicitly suppressed on the
   * wire (the edge always sends an explicit off — `thinking.type:"disabled"`
   * / effort "none" — so the seat rides as declared metadata).
   */
  requiresEffort: z.boolean().optional(),
});
export type RelayModelThinking = z.infer<typeof relayModelThinkingSchema>;

/**
 * The projected runnable ladder (#351 directory vocabulary): pi's gate —
 * `reasoning === true && efforts.length > 0` — admits the effort rungs;
 * everything else runs exactly ["none"]. "none" is the off state (bb's
 * vocabulary for no extended thinking), always offered, never a capability.
 */
export interface RelayReasoningLadder {
  levels: RelayReasoningLevel[];
  defaultLevel: RelayReasoningLevel;
}

/** The `{ reasoning, thinking }` slice pi's model-thinking helpers read. */
export interface RelayReasoningSource {
  id?: string;
  reasoning?: boolean;
  // Readonly efforts (pi's own `readonly Effort[]` shape): mutable schema
  // output assigns in; `as const` fixtures assign in too.
  thinking?: Omit<RelayModelThinking, "efforts"> & { readonly efforts: readonly RelayEffort[] };
}

/**
 * pi model view: the runtime helpers are field-readers over a catalog model
 * (model-thinking.ts reads only `reasoning`/`thinking`/`id`-adjacent
 * fields); the edge row projects onto that slice. The assertion is the
 * documented seam — pi's ModelSpec required surface (provider/baseUrl/cost/
 * …) is unread by these helpers.
 */
function piModelView(row: RelayReasoningSource): ModelSpec {
  return {
    id: row.id ?? "",
    reasoning: row.reasoning === true,
    thinking: row.thinking,
  } as unknown as ModelSpec;
}

/**
 * The row's supported efforts through the pi 正本 (pi-catalog
 * getSupportedEfforts): empty unless the gate (`reasoning === true` + a
 * declared, non-empty effort surface) passes.
 */
export function relaySupportedEfforts(row: RelayReasoningSource): RelayEffort[] {
  // The edge vocabulary is pi's minus `minimal`; a row can never carry a
  // minimal effort (the schema refuses it), so the returned members are all
  // edge-expressible by construction.
  return [...piGetSupportedEfforts(piModelView(row))] as RelayEffort[];
}

/**
 * The row's default effort through the pi 正本 (pi-catalog
 * defaultSupportedEffort): the wire-route-matched effort when the row
 * declares effortRouting + a default wire id, else the lowest supported
 * effort. Undefined exactly when the gate fails.
 */
export function relayDefaultEffort(row: RelayReasoningSource): RelayEffort | undefined {
  return piDefaultSupportedEffort(piModelView(row)) as RelayEffort | undefined;
}

/**
 * The ladder a model row projects (#534): pi's capability gate —
 * `reasoning === true && getSupportedEfforts(row).length > 0` — admits
 * ["none", ...efforts] with the row's `thinking.defaultLevel` (when declared)
 * else pi's defaultSupportedEffort; every other row runs exactly ["none"].
 * This REPLACES deriveRelayReasoning: the budget number is no load-bearing
 * gate anywhere — re-importing the same model list can never collapse a
 * declared ladder again.
 */
export function relayReasoningLadder(row: RelayReasoningSource): RelayReasoningLadder {
  const efforts = relaySupportedEfforts(row);
  if (efforts.length === 0) {
    return { levels: ["none"], defaultLevel: "none" };
  }
  const declaredDefault = row.thinking?.defaultLevel;
  const defaultLevel =
    declaredDefault !== undefined && efforts.includes(declaredDefault)
      ? declaredDefault
      : (relayDefaultEffort(row) ?? efforts[0] ?? "none");
  return { levels: ["none", ...efforts], defaultLevel };
}

// ---------------------------------------------------------------------------
// Relay API family + OpenAI effort mapping (#361/#363 adaptor seam)
// ---------------------------------------------------------------------------

/**
 * The relay's protocol-face vocabulary — exactly the api families the edge
 * relay speaks (omp models.yml field dictionary subset: `anthropic-messages`
 * is the #34 incumbent face, `openai-responses` the #361 adaptor and
 * `openai-completions` the #363 adaptor). The EDGE catalog validates the
 * provider-level api label at decode (strict: an api family the relay
 * cannot speak fails the deployment loudly, never silently rides the
 * anthropic wire); the model-entry dictionary keeps the free-form omp api
 * label as descriptive vocabulary for the picker faces.
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
 * The wire effort the openai faces send for one selected rung (#534): the
 * row's `thinking.effortMap` remap wins (omp models.yml deepseek anchor —
 * {high: high, xhigh: max}), then identity. Total by construction: a
 * selected rung is a RelayEffort (already an official effort value) and the
 * schema constrains effortMap values to the official vocabulary, so the old
 * unmappable-rung error class has no honest input anymore — the ladder
 * simply cannot offer a rung the wire cannot express.
 */
export function relayResponsesWireEffort(
  rung: RelayReasoningLevel,
  thinking?: RelayModelThinking,
): ResponsesEffort {
  if (rung === "none") return "none";
  // The projected ladder admits RelayEffort rungs only; the selection
  // resolver 422s anything else before the wire fold runs.
  const effort = rung as RelayEffort;
  return (thinking?.effortMap?.[effort] ?? effort) as ResponsesEffort;
}

/**
 * The anthropic adaptive effort for one selected rung, through the pi 正本
 * (pi-catalog mapEffortToAnthropicAdaptiveEffort: the row's effortMap
 * remap, then identity, then the minimal→low clamp the adaptive wire
 * vocabulary needs). "adaptive" (the sentinel a map may name) means the
 * wire sends `thinking.type:"adaptive"` with NO output_config — the caller
 * reads it off the return to pick that shape.
 */
export function relayAnthropicAdaptiveEffort(
  row: RelayReasoningSource,
  effort: RelayEffort,
): "low" | "medium" | "high" | "xhigh" | "max" | "adaptive" {
  // RelayEffort is pi's Effort minus `minimal` (string-compatible); the
  // const-enum nominal typing is the only gap.
  return piMapEffortToAnthropicAdaptiveEffort(piModelView(row), effort as unknown as PiEffort);
}

/**
 * The upstream wire id for one selection (pi-catalog resolveWireModelId):
 * the row's `thinking.effortRouting` routes collapsed effort-tier variants
 * per rung ("off" when thinking is off); everything else keeps the row id.
 */
export function relayWireModelId(row: { id: string } & RelayReasoningSource, rung: RelayReasoningLevel): string {
  return piResolveWireModelId(
    piModelView(row),
    (rung === "none" ? undefined : rung) as unknown as PiEffort | undefined,
  );
}

/**
 * The per-effort `thinking.budget_tokens` ladder a budget-transport row
 * rides when its declared `thinking.effortBudgets` names no entry — pi-ai
 * stream.ts:1613 ANTHROPIC_THINKING anchor (the same wire the relay
 * speaks). Wire detail, not capability: the ladder NEVER derives from it.
 */
export const RELAY_ANTHROPIC_BUDGET_BY_EFFORT: Record<RelayEffort, number> = {
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 32768,
};

/**
 * The anthropic wire thinking fold for one selection (#534): the row's
 * declared transport decides the shape —
 * - rung "none" (or no thinking seat): explicit off (`type:"disabled"` —
 *   the probe-confirmed compat posture; satisfies requiresEffort rows,
 *   which need the explicit suppression);
 * - "anthropic-adaptive": `type:"adaptive"` + `output_config.effort`
 *   (pi-ai anthropic.ts: adaptive model, effort rides output_config);
 * - "anthropic-budget-effort": `type:"enabled"` + budget AND the effort;
 * - every other mode: the classic budget knob — the rung's
 *   `effortBudgets` entry, else the named default ladder (pi-ai's own
 *   precedence: per-effort lookup, no default-rung borrow). The budget
 *   NUMBER is wire detail; the row id/rung decision stays with the ladder.
 */
export function relayAnthropicThinking(
  row: RelayReasoningSource,
  rung: RelayReasoningLevel,
): { thinking: ThinkingConfig; outputConfig?: RelayOutputConfig } {
  const meta = row.thinking;
  if (rung === "none" || meta === undefined) {
    return { thinking: { type: "disabled" } };
  }
  const effort = rung as RelayEffort;
  const budget =
    meta.effortBudgets?.[effort] ?? RELAY_ANTHROPIC_BUDGET_BY_EFFORT[effort];
  if (meta.mode === "anthropic-adaptive" || meta.mode === "anthropic-budget-effort") {
    const mapped = relayAnthropicAdaptiveEffort(row, effort);
    const adaptive: ThinkingConfig =
      meta.mode === "anthropic-adaptive"
        ? { type: "adaptive" }
        : { type: "enabled", budget_tokens: budget };
    return mapped === "adaptive"
      ? { thinking: adaptive }
      : { thinking: adaptive, outputConfig: { effort: mapped } };
  }
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

// ---------------------------------------------------------------------------
// Shared field dictionary (model entries — one vocabulary, edge faces only)
// ---------------------------------------------------------------------------

/**
 * The shared model-entry dictionary: the omp models.yml field set (id/name/
 * api/reasoning/input/contextWindow/maxTokens/cost) as the edge catalog's
 * canonical entry vocabulary. #523 deleted its last second consumer (the
 * daemon-side model registry that imported this zod instance from the
 * retired agent-auth env channel) — the edge catalog is now the
 * dictionary's only consumer, and it extends entries with picker-face
 * fields.
 */
export const relayModelEntrySchema = z.strictObject({
  /** Model id as the relay wire addresses it (e.g. `glm-5.3`). */
  id: z.string().min(1),
  /** Display name; defaults to the id on the picker face. */
  name: z.string().min(1).optional(),
  /** API family label (free-form omp vocabulary; provider rows use the strict enum). */
  api: z.string().min(1).optional(),
  /** Reasoning capability bit — the pi gate input (relayReasoningLadder). */
  reasoning: z.boolean().optional(),
  /**
   * #534 the pi ThinkingConfig seat (relayModelThinkingSchema): capability
   * ladder + wire transport, one vocabulary with omp models.yml. Absent on
   * rows with no controllable thinking surface.
   */
  thinking: relayModelThinkingSchema.optional(),
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

/** Public per-token pricing (USD per million tokens) — the named shape of
 * `relayModelEntrySchema.cost`, consumable without the full entry (#523
 * find judge footer pricing). */
export type RelayModelCost = NonNullable<RelayModelEntry["cost"]>;

const CANONICAL_EFFORT_ORDER: readonly RelayEffort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * #534 the compat read (存量行迁移): stored/pre-pi rows carry the retired
 * seats (`thinkingBudgetTokens` budget + `reasoningLevels`/
 * `defaultReasoningLevel` ladder + `reasoningEffortMap` remap). The fold
 * migrates them onto the pi shape — the ladder becomes
 * `thinking.efforts` (capability, NO budget gate), the budget number rides
 * `thinking.effortBudgets` on the default rung (wire detail), the remap
 * rides `thinking.effortMap`. pi-shaped `thinking` input wins verbatim and
 * the retired seats strip from the output. Semantics preserved per the old
 * deriveRelayReasoning: declared rungs keep their ladder; a budget number
 * with no declared ladder becomes the single honest medium rung; rows with
 * neither keep `thinking` absent (gate off).
 */
function foldLegacyModelRow(row: {
  id: string;
  name?: string;
  api?: RelayApi;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: RelayModelCost;
  description?: string;
  thinking?: RelayModelThinking;
  thinkingBudgetTokens?: number | null | undefined;
  reasoningLevels?: readonly RelayReasoningLevel[] | null | undefined;
  defaultReasoningLevel?: RelayReasoningLevel | null | undefined;
  reasoningEffortMap?: Partial<Record<RelayReasoningLevel, ResponsesEffort>> | null | undefined;
  // The OUTPUT shape (RelayModelEntry + the edge seats the extend narrows or
  // adds) — spelled structurally, NOT via z.infer of the schema below: the
  // fold sits inside that schema's transform, so inferring through it would
  // cycle. `api` re-narrows to the relay enum (the extend's override).
}): RelayModelEntry & { description?: string; api?: RelayApi } {
  const {
    thinkingBudgetTokens,
    reasoningLevels,
    defaultReasoningLevel,
    reasoningEffortMap,
    ...pi
  } = row;
  if (pi.thinking !== undefined) return pi;
  // The remap: effort-keyed entries survive verbatim (value vocabulary is
  // the same official effort set); rung keys the edge ladder cannot offer
  // (none/ultra/ultracode) drop — they never projected a runnable rung.
  const effortMap: Partial<Record<RelayEffort, ResponsesEffort>> = {};
  for (const [key, value] of Object.entries(reasoningEffortMap ?? {})) {
    if ((relayEffortValues as readonly string[]).includes(key)) {
      effortMap[key as RelayEffort] = value;
    }
  }
  // Legacy declarations may arrive unordered (and carry the off/fantasy
  // rungs) — emit the ladder pi expects: canonical order (pi-catalog
  // THINKING_EFFORTS, minus minimal), only edge-expressible efforts.
  const declaredEfforts = CANONICAL_EFFORT_ORDER.filter((effort) =>
    (reasoningLevels ?? []).includes(effort),
  );
  if (declaredEfforts.length === 0) {
    // No declared ladder: the budget number was the old single-honest-rung
    // gate (medium) — migrate it as exactly that, number intact.
    if (thinkingBudgetTokens === undefined || thinkingBudgetTokens === null) return pi;
    return {
      ...pi,
      thinking: {
        mode: "budget",
        efforts: ["medium"],
        defaultLevel: "medium",
        effortBudgets: { medium: thinkingBudgetTokens },
      },
    };
  }
  const budget = thinkingBudgetTokens === null ? undefined : thinkingBudgetTokens;
  const declaredDefault =
    defaultReasoningLevel != null &&
    (relayEffortValues as readonly string[]).includes(defaultReasoningLevel)
      ? (defaultReasoningLevel as RelayEffort)
      : undefined;
  // No declared default → pi defaultSupportedEffort semantics over the
  // migrated ladder: the lowest supported effort (no routing to match —
  // minimumSupportedEffort is the fallback the pi helper itself returns).
  const defaultLevel = declaredDefault ?? (declaredEfforts[0] ?? "medium");
  return {
    ...pi,
    thinking: {
      mode: "budget",
      efforts: declaredEfforts,
      defaultLevel,
      ...(Object.keys(effortMap).length > 0 ? { effortMap } : {}),
      ...(budget !== undefined ? { effortBudgets: { [defaultLevel]: budget } } : {}),
    },
  };
}

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
    /** bb AvailableModel.description (picker subtitle). */
    description: z.string().optional(),
    /**
     * #534 the RETIRED seats, accepted as INPUT only (compat read): the
     * transform below folds them onto the pi thinking shape and strips them
     * from the output. Declaring them on a fresh row still works (the fold
     * is the migration path), but nothing downstream reads them anymore —
     * the stored JSON normalizes to the pi shape on the next write.
     */
    thinkingBudgetTokens: z.number().int().positive().nullish(),
    reasoningLevels: z.array(relayReasoningLevelSchema).min(1).nullish(),
    defaultReasoningLevel: relayReasoningLevelSchema.nullish(),
    reasoningEffortMap: z.partialRecord(relayReasoningLevelSchema, responsesEffortSchema).nullish(),
  })
  .transform(foldLegacyModelRow)
  .refine(
    (model) =>
      model.thinking?.defaultLevel == null ||
      model.thinking.efforts.includes(model.thinking.defaultLevel),
    { message: "thinking.defaultLevel must be a member of thinking.efforts" },
  );
export type RelayCatalogModel = z.infer<typeof relayCatalogModelSchema>;
export type RelayCatalogModelInput = z.input<typeof relayCatalogModelSchema>;

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
  /** The projected capability bit (relayReasoningLadder's gate input). */
  reasoning: boolean;
  reasoningLevels: readonly RelayReasoningLevel[];
  defaultReasoningLevel: RelayReasoningLevel;
  /**
   * #361: the row's protocol face (model api ?? provider api ?? default).
   * The effort fold below applies only to openai-effort faces — the
   * anthropic face keeps its budget/adaptive semantics.
   */
  api?: RelayApi;
  /**
   * #534 the pi thinking seat verbatim (RelayCatalogModel.thinking): the
   * dispatch half reads the wire transports off it (effortBudgets /
   * effortRouting / effortMap / mode) — never the ladder, which is the
   * projected pair above.
   */
  thinking?: RelayModelThinking;
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
 *   row's projected default. The ladder is the capability projection
 *   (relayReasoningLadder) the picker face runs — one vocabulary, no second
 *   derivation. A rung the row's pi gate does not admit fails loudly (the
 *   #351 red line), never silently downgrades.
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
  const reasoningLevel = selection.reasoningLevel ?? row.defaultReasoningLevel;
  if (!row.reasoningLevels.includes(reasoningLevel)) {
    throw new RelaySelectionError(
      "reasoning_level_unknown",
      "reasoningLevel",
      `reasoning level "${reasoningLevel}" is not in the runnable ladder ` +
        `${JSON.stringify(row.reasoningLevels)} for ${providerId}/${row.id}`,
    );
  }
  return { providerId, modelId: row.id, reasoningLevel };
}
