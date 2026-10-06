import { z } from "zod";

/**
 * Relay provider catalog declaration (#350, #305 roadmap §3/§4.4) — the L1
 * deployment-env source of truth for "what the relay deployment bought":
 * providers × models × capabilities × declared flags. Public, zero-secret:
 * credentials never enter this ledger (keys stay in their own env/secret
 * slots — #255 ruling C); only declaration-grade fields are representable.
 *
 * Two faces consume one declaration (#319 dual-face pattern generalized to
 * the catalog layer):
 * - edge `MODEL_RELAY_CATALOG` → the picker/directory faces
 *   (apps/server-worker routes/system.ts execution-options + the
 *   provider-projections catalog row) and the harness resolution
 *   (apps/provider-app harness.ts);
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
 * The relay wire has one thinking knob (the deployment's budget token count,
 * MODEL_RELAY_THINKING_BUDGET_TOKENS) — until per-thread selection consumes
 * a ladder (#351), the honest projection of "budget on" is exactly this one
 * rung, not a multi-rung ladder the wire cannot distinguish.
 */
export const DEFAULT_THINKING_REASONING_LEVEL: RelayReasoningLevel = "medium";

export interface RelayReasoningDerivationInput {
  /** Deployment thinking flag: MODEL_RELAY_THINKING_BUDGET_TOKENS set (>0). */
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
    /** bb AvailableModel.description (picker subtitle). */
    description: z.string().optional(),
    /**
     * Per-model thinking budget (#362 scope absorption ①): the reasoning
     * budget rides the model row, replacing the deployment-wide
     * MODEL_RELAY_THINKING_BUDGET_TOKENS scalar for THIS row (the env
     * scalar is the fallback for rows that do not declare one — deprecated,
     * not removed). A panel edit hot-applies through the catalog overlay.
     */
    thinkingBudgetTokens: z.number().int().positive().optional(),
    /**
     * Explicit ladder override. Unset → budget-derived (deriveRelayReasoning).
     * Dormant while thinking is disabled: the wire cannot run any budget rung,
     * so the projection stays `["none"]` regardless of the declaration.
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

export const relayCatalogProviderSchema = z.strictObject({
  /** Picker display name; defaults to the provider key. */
  displayName: z.string().min(1).optional(),
  /**
   * Public endpoint declaration (projection-grade — the same trust level the
   * provider-projections harness row already emits for the relay base URL).
   * The wire base stays MODEL_RELAY_BASE_URL_ANTHROPIC; this documents the
   * bought channel and never carries a credential.
   */
  baseUrl: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  /** bb ProviderCapabilities.supportsServiceTier projection. */
  serviceTier: z.boolean().optional(),
  models: z.array(relayCatalogModelSchema).min(1),
});
export type RelayCatalogProvider = z.infer<typeof relayCatalogProviderSchema>;

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
    const model = provider?.models.find((entry) => entry.id === modelId);
    if (provider !== undefined && model !== undefined) {
      return { providerId, model };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Thread-level selection resolution (#351 — the L4 consumption chain)
// ---------------------------------------------------------------------------

/**
 * The synthetic provider seam id (routes/threads.ts create: the pre-#351
 * `payload.providerId ?? "omp"` sentinel). It names "the deployment default
 * provider" rather than a concrete catalog key, so it resolves to whatever
 * the declaration's default is — pre-#351 threads keep dispatching on
 * catalog deployments instead of failing on an undeclared key.
 */
export const SYNTHETIC_RELAY_PROVIDER_ID = "omp";

/**
 * #362 scope absorption ②: the api family that marks a provider row as an
 * IMAGE source (the generate_image tool's OpenAI-images endpoint). Such rows
 * carry their own source config + switch (row presence is the opt-in); they
 * are excluded from the LLM selection directory and ride the panel CRUD face.
 */
export const IMAGE_SOURCE_API_FAMILY = "openai-images";

/** A thread-level execution selection (threads row overrides / create/send payloads). */
export interface RelaySelection {
  providerId?: string;
  model?: string;
  reasoningLevel?: RelayReasoningLevel;
}

export type RelaySelectionErrorCode =
  "provider_unknown" | "model_unknown" | "reasoning_level_unknown";

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
   * The row's EFFECTIVE thinking budget (#362): model-declared budget
   * winning over the deployment scalar. `undefined` = legacy row that
   * predates the seat (falls back to `directory.thinkingEnabled`);
   * `null` = explicitly budget-off; a number = enabled with that budget.
   */
  thinkingBudgetTokens?: number | null;
}

export interface RelaySelectionDirectory {
  rows: readonly RelaySelectionDirectoryRow[];
  /** The seam default provider (catalog defaultProvider ?? first key ?? omp). */
  defaultProviderId: string;
  /** The model turns actually run (harness model) — a provider's default fill. */
  defaultModelId: string;
  /** Deployment thinking flag (MODEL_RELAY_THINKING_BUDGET_TOKENS > 0). */
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
 * - provider: explicit ?? default ("omp" maps to the default — sentinel);
 * - model: explicit (must sit in the resolved provider's rows) ?? the
 *   running model when the provider declares it — a provider without the
 *   running row has NO default and demands an explicit model (named error,
 *   not a guessed first row);
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
  const providerId =
    selection.providerId === SYNTHETIC_RELAY_PROVIDER_ID
      ? directory.defaultProviderId
      : (selection.providerId ?? directory.defaultProviderId);
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
            `(the running model "${directory.defaultModelId}" is not one of its rows: ` +
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
  return { providerId, modelId: row.id, reasoningLevel };
}
