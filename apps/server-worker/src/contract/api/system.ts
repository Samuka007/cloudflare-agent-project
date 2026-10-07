//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";
import { relayCatalogModelSchema } from "@cap/agent-do";
import { discoveredModelEntrySchema } from "@cap/daemon-service";
import {
  appSettingsSchema,
  appDefaultKeybindingsSchema,
  appKeybindingOverridesSchema,
  appKeybindingsSchema,
  appThemeSchema,
  availableModelSchema,
  experimentsSchema,
  featureFlagsSchema,
  permissionModeSchema,
  pluginThemeMetaSchema,
  providerInfoSchema,
} from "../domain/index.js";
import { hostPlatformSchema } from "../hdc/local.js";

export const systemExecutionOptionsModelLoadErrorCodeSchema = z.enum([
  "missing_executable",
  "unsupported_version",
  "auth_required",
  "timeout",
  "failed",
]);
export type SystemExecutionOptionsModelLoadErrorCode = z.infer<
  typeof systemExecutionOptionsModelLoadErrorCodeSchema
>;

export const systemExecutionOptionsModelLoadErrorSchema = z.object({
  providerId: z.string().min(1),
  code: systemExecutionOptionsModelLoadErrorCodeSchema,
});
export type SystemExecutionOptionsModelLoadError = z.infer<
  typeof systemExecutionOptionsModelLoadErrorSchema
>;

export const systemExecutionOptionsResponseSchema = z.object({
  providers: z.array(providerInfoSchema),
  /**
   * Highest permission mode the routed machine allows (Settings → Machines →
   * Permission limit). Pickers disable anything above it, and the server
   * resolves any higher request down to it. "full" when the machine is
   * uncapped or no machine could be routed.
   */
  permissionCeiling: permissionModeSchema,
  /** Active models offered as fresh picker choices. */
  models: z.array(availableModelSchema),
  /**
   * Retired/legacy models the picker no longer offers but that may still be
   * the user's stored selection. Clients prepend the matching entry when a
   * stored model isn't in `models`, so deprecation doesn't silently rewrite
   * the user's choice.
   */
  selectedOnlyModels: z.array(availableModelSchema),
  /**
   * Error for the provider whose model list was requested. Null means the
   * lookup completed or no provider was available to query.
   */
  modelLoadError: systemExecutionOptionsModelLoadErrorSchema.nullable(),
});
export type SystemExecutionOptionsResponse = z.infer<typeof systemExecutionOptionsResponseSchema>;

const systemProviderHostQueryFields = {
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
} as const;

function rejectMultipleProviderHostSelectors(
  query: { environmentId?: string; hostId?: string },
  context: z.RefinementCtx,
): void {
  if (query.environmentId !== undefined && query.hostId !== undefined) {
    context.addIssue({
      code: "custom",
      message: "hostId and environmentId are mutually exclusive",
    });
  }
}

/**
 * Routes provider discovery through an environment's host or an explicit
 * host. Omitting both preserves the primary-host fallback.
 */
export const systemProvidersQuerySchema = z
  .object(systemProviderHostQueryFields)
  .partial()
  .superRefine(rejectMultipleProviderHostSelectors);
export type SystemProvidersQuery = z.infer<typeof systemProvidersQuerySchema>;

export const systemExecutionOptionsQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    providerId: z.string().min(1),
  })
  .partial()
  .superRefine(rejectMultipleProviderHostSelectors);
export type SystemExecutionOptionsQuery = z.infer<typeof systemExecutionOptionsQuerySchema>;

/** Omission preserves the existing behavior of reading the primary machine. */
export const systemUsageLimitsQuerySchema = z.object({
  hostId: z.string().min(1).optional(),
});
export type SystemUsageLimitsQuery = z.infer<typeof systemUsageLimitsQuerySchema>;

export type SystemVoiceTranscriptionForm = Record<string, string | Blob>;

// SystemProviderInfo is the same shape as ProviderInfo from domain.
// Re-export with the API-facing name for backward compatibility.
export { providerInfoSchema as systemProviderInfoSchema } from "../domain/index.js";
export type { ProviderInfo as SystemProviderInfo } from "../domain/index.js";

export const systemVoiceTranscriptionResponseSchema = z.object({
  text: z.string(),
});
export type SystemVoiceTranscriptionResponse = z.infer<
  typeof systemVoiceTranscriptionResponseSchema
>;

/**
 * One agent row in onboarding. `planLabel` and `accountEmail` are populated
 * only for the three providers `provider.usage` covers; ACP agents report
 * presence and nothing more, and get no badge rather than a fabricated one.
 */
export const onboardingAgentSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  status: z.enum(["connected", "unauthenticated", "expired", "not_installed"]),
  planLabel: z.string().min(1).nullable(),
  accountEmail: z.string().nullable(),
  /** True only where bb has a managed installer, so only these may be offered. */
  canInstall: z.boolean(),
  /**
   * The agent's own sign-in command, when it has one. bb deliberately does not
   * drive another tool's login: it shows the command and re-checks, so
   * credentials only ever pass through the agent itself.
   */
  loginCommand: z.string().min(1).nullable(),
});
export type OnboardingAgent = z.infer<typeof onboardingAgentSchema>;

export const onboardingAgentOverviewSchema = z.object({
  agents: z.array(onboardingAgentSchema),
});
export type OnboardingAgentOverview = z.infer<typeof onboardingAgentOverviewSchema>;

/** Omission reads the primary machine, matching the usage-limits route. */
export const systemOnboardingReposQuerySchema = z.object({
  hostId: z.string().min(1).optional(),
});
export type SystemOnboardingReposQuery = z.infer<typeof systemOnboardingReposQuerySchema>;

/**
 * Onboarding funnel events, reported by the app and forwarded to the server's
 * anonymous telemetry. Categorical or counts only — never paths, project names,
 * or account emails.
 */
export const onboardingTelemetryEventSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("onboarding_started"),
    agentState: z.enum(["connected", "signed_out", "none"]),
    detectedAgentCount: z.number().int().min(0),
  }),
  z.object({
    name: z.literal("onboarding_step_completed"),
    step: z.enum(["agents", "projects"]),
  }),
  z.object({
    name: z.literal("onboarding_step_skipped"),
    step: z.enum(["agents", "projects"]),
  }),
  z.object({
    name: z.literal("onboarding_completed"),
    agentState: z.enum(["connected", "signed_out", "none"]),
    projectsAdded: z.number().int().min(0),
    durationMs: z.number().int().min(0),
  }),
  z.object({
    name: z.literal("onboarding_dismissed"),
    step: z.enum(["agents", "projects"]),
  }),
]);
export type OnboardingTelemetryEvent = z.infer<typeof onboardingTelemetryEventSchema>;

export const systemConfigResponseSchema = z.object({
  /** App-wide Settings → General preferences, persisted server-side. */
  generalSettings: appSettingsSchema,
  /** Server-resolved keyboard bindings shared by every connected app window. */
  keybindings: appKeybindingsSchema,
  /** Server defaults, before the user's per-command overrides are applied. */
  defaultKeybindings: appDefaultKeybindingsSchema,
  /** Sparse per-command customizations; null shortcuts explicitly disable commands. */
  keybindingOverrides: appKeybindingOverridesSchema,
  /** User-opt-in experiments (Settings → Experiments), persisted server-side. */
  experiments: experimentsSchema,
  /** Active app-wide palette (built-in id or custom theme), resolved server-side. */
  appearance: appThemeSchema,
  /**
   * Names of custom themes discovered under `<data-dir>/theme/<name>/theme.css`,
   * so the Settings picker can offer them alongside the built-ins.
   */
  customThemes: z.array(z.string()),
  /** Palettes contributed by currently loaded plugins. */
  pluginThemes: z.array(pluginThemeMetaSchema),
  featureFlags: featureFlagsSchema,
  hostDaemonPort: z.number().nullable(),
  /** Base URL external host daemons should use to reach this server. */
  serverUrl: z.url(),
  /**
   * The server-resolved primary host (the machine running the server, or the
   * single known host). Null only on a fresh server where no host has ever
   * enrolled — clients must not guess a primary from the host list when a
   * value is present.
   */
  primaryHostId: z.string().nullable(),
  primaryHostPlatform: hostPlatformSchema.nullable(),
  voiceTranscriptionEnabled: z.boolean(),
  /** Absolute path of the active bb data directory (where ui/, theme/, the DB live). */
  dataDir: z.string(),
});
export type SystemConfigResponse = z.infer<typeof systemConfigResponseSchema>;

export const systemAttentionResponseSchema = z.object({
  hasAttention: z.boolean(),
});
export type SystemAttentionResponse = z.infer<typeof systemAttentionResponseSchema>;

/**
 * Theme catalog: the on-disk custom-theme directory plus the discovered custom
 * themes and the active palette. Drives `bb theme list` / `bb theme dir`.
 */
export const themeCatalogResponseSchema = z.object({
  /** Absolute path of the custom-theme root: `<data-dir>/theme`. */
  dir: z.string(),
  /** Discovered custom theme names (each has a `theme.css`). */
  custom: z.array(z.string()),
  /** Palettes contributed by currently loaded plugins. */
  plugins: z.array(pluginThemeMetaSchema),
  /** The active palette, resolved server-side. */
  active: appThemeSchema,
});
export type ThemeCatalogResponse = z.infer<typeof themeCatalogResponseSchema>;

export const systemVersionResponseSchema = z.object({
  /** Version of the running bb-app package, read from package.json. */
  currentVersion: z.string(),
  /** Latest version published to npm, or null when the lookup is unavailable. */
  latestVersion: z.string().nullable(),
  /** Identifier for where the latest version was fetched from. */
  source: z.literal("npm"),
  /** True only when prod-mode, both versions parse, and latest > current. */
  updateAvailable: z.boolean(),
  /** Mirrors deps.config.isDevelopment so the frontend can skip the toast. */
  isDevelopment: z.boolean(),
  /** Command users should run to upgrade. Server-owned product policy. */
  upgradeCommand: z.string(),
});
export type SystemVersionResponse = z.infer<typeof systemVersionResponseSchema>;

export const systemVersionQuerySchema = z.object({
  /** "true" bypasses the server-side npm latest cache for a manual check. */
  force: z.enum(["true", "false"]).optional(),
});
export type SystemVersionQuery = z.infer<typeof systemVersionQuerySchema>;

// --- Port-only surface (#266, #255 solution C) --------------------------------
// GET /system/provider-projections: the read-only provider status face. Zero
// secret values by construction — the harness row re-uses the secret-free
// HarnessProjection (provider-app projectHarness, key PRESENCE only) plus the
// relay host, and the web_search row carries engine ids and credential-gate
// booleans only. The web_search WRITE face lives at /system/web-search below
// (#449) — the D1 row is the sole 正本, this aggregate stays read-only.

export const providerWebSearchEngineProjectionSchema = z.object({
  engine: z.string(),
  /** True when the engine needs configured credentials to serve requests. */
  credentialsRequired: z.boolean(),
  /** True when the gate passes (nothing required, or the secret fields are set). */
  credentialsPresent: z.boolean(),
});
export type ProviderWebSearchEngineProjection = z.infer<
  typeof providerWebSearchEngineProjectionSchema
>;

export const systemProviderProjectionsResponseSchema = z.object({
  /** The relay harness projection (projectHarness + relayBaseUrlHost). */
  harness: z.object({
    relayMode: z.string(),
    /**
     * #361/#363: the relay protocol face (anthropic-messages |
     * openai-responses | openai-completions).
     */
    relayApi: z.string(),
    relayBaseUrl: z.string(),
    /** Host component of relayBaseUrl; null when the env URL does not parse. */
    relayBaseUrlHost: z.string().nullable(),
    relayKeyPresent: z.boolean(),
    relayModel: z.string(),
    relayMaxTokens: z.number(),
    relayThinking: z.string(),
    machineId: z.string(),
    executionModel: z.string(),
    executionServiceTier: z.string(),
    executionReasoningLevel: z.string(),
    permissionMode: z.string(),
    /**
     * #484: true iff the deployment set any legacy deployment-channel env
     * (the MODEL_RELAY_* family, DAEMON_MACHINE_ID, HARNESS_PERMISSION_MODE;
     * blank strings don't count). false = the relay rows in this object are
     * pure HARNESS_DEFAULTS synthesis with zero deployment input — since
     * #450 the D1 provider_configs rows are the sole provider 正本, the
     * deployment channel has no product meaning at zero env, and the panel
     * must NOT render the block (defaults like "mock / open.bigmodel.cn /
     * glm-5.3" read as "my LLM provider is mock" next to the live rows).
     */
    envConfigured: z.boolean(),
  }),
  webSearch: z.object({
    /** True when the D1 web_search row exists (false = ruled defaults). */
    configured: z.boolean(),
    /**
     * True when the stored D1 row failed to decode/decrypt — no chain is
     * served and the DO keeps its last-known config. Error text is dropped
     * (JSON.parse/zod messages can quote raw row content — zero-secret
     * discipline).
     */
    decodeError: z.boolean(),
    chain: z.array(providerWebSearchEngineProjectionSchema),
    timeoutSeconds: z.number().nullable(),
    browserBackedEngines: z.array(z.string()),
  }),
  /**
   * Catalog status (#350 → #450): the D1 provider_configs rows are the sole
   * directory 正本 (the env MODEL_RELAY_CATALOG seed is retired), so this row
   * names ids only — the full declared values (ladders, windows, display
   * names) live on GET /system/execution-options, the same resolution.
   * decodeError is the retired env-era state: without env JSON to decode it
   * cannot arise (D1 rows carry per-row skip-with-warning on the CRUD face)
   * and stays constantly false with the shape kept. defaultProviderId is
   * constantly null — rows declare no deployment-wide default (#434: no
   * first-key fill; a selection without an explicit provider fails closed).
   */
  catalog: z.object({
    configured: z.boolean(),
    decodeError: z.boolean(),
    /** The declaration's defaultProvider; null = declared none (or broken). */
    defaultProviderId: z.string().nullable(),
    defaultModel: z.string(),
    providers: z.array(z.string()),
    models: z.array(z.string()),
    /**
     * #362 scope absorption ②: generate_image availability, presence-only
     * (zero-secret). #448: `providerId` is the panel's 产图源 seat (D1
     * image_source, null = nothing selected — there is no env fallback,
     * #450); `configured` is true only when that selection resolves to a
     * dispatchable api=openai-images row.
     */
    imageGeneration: z.object({
      configured: z.boolean(),
      providerId: z.string().nullable(),
    }),
  }),
});
export type SystemProviderProjectionsResponse = z.infer<
  typeof systemProviderProjectionsResponseSchema
>;

/**
 * #449 the explicit web-search engine-chain face (the D1 `web_search` row,
 * the sole 正本 — the AGENT_DO_WEB_SEARCH env path is deleted, #450
 * zero-env ruling). `chain` is the effective ordered chain with per-engine
 * credential gates; `engines` is the zero-secret editable detail (non-secret
 * values readable, secret PRESENCE only); `availableEngines` is the
 * writable vocabulary (the DO-local fetch-only engine set — browser-backed
 * engines are excluded at the config layer and never selectable).
 */
export const systemWebSearchResponseSchema = z.object({
  configured: z.boolean(),
  decodeError: z.boolean(),
  chain: z.array(providerWebSearchEngineProjectionSchema),
  timeoutSeconds: z.number().nullable(),
  browserBackedEngines: z.array(z.string()),
  availableEngines: z.array(z.string()),
  engines: z.object({
    brave: z.object({ hasApiKey: z.boolean() }),
    searxng: z.object({
      endpoint: z.string().nullable(),
      categories: z.string().nullable(),
      language: z.string().nullable(),
      safesearch: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable(),
      hasToken: z.boolean(),
      hasBasicAuth: z.boolean(),
    }),
  }),
});
export type SystemWebSearchResponse = z.infer<typeof systemWebSearchResponseSchema>;

/**
 * PUT /system/web-search. `chain` is the full ordered chain (wholesale —
 * order IS the payload); every engine setting is TRI-STATE: absent = keep
 * the stored value, null = clear, string = set — so a partial panel write
 * (e.g. a reorder) never disturbs unrelated fields.
 */
export const systemWebSearchPutRequestSchema = z
  .object({
    chain: z.array(z.string()).min(1).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    engines: z
      .object({
        brave: z
          .object({ apiKey: z.string().min(1).nullable().optional() })
          .strict()
          .optional(),
        searxng: z
          .object({
            endpoint: z.string().min(1).nullable().optional(),
            token: z.string().min(1).nullable().optional(),
            basicUsername: z.string().min(1).nullable().optional(),
            basicPassword: z.string().min(1).nullable().optional(),
            categories: z.string().min(1).nullable().optional(),
            language: z.string().min(1).nullable().optional(),
            safesearch: z
              .union([z.literal(0), z.literal(1), z.literal(2)])
              .nullable()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SystemWebSearchPutRequest = z.infer<typeof systemWebSearchPutRequestSchema>;

/**
 * #448 the explicit image-source face (the 产图源 正本, D1 image_source).
 * `providerId` names the api=openai-images provider row that supplies
 * generate_image; null = no source (the tool is unavailable — zero env
 * fallback, #450). `candidates` lists the currently dispatchable
 * api=openai-images row ids the panel can select from.
 */
export const systemImageSourceResponseSchema = z.object({
  providerId: z.string().nullable(),
  candidates: z.array(z.string()),
});
export type SystemImageSourceResponse = z.infer<typeof systemImageSourceResponseSchema>;

/** PUT /system/image-source: select a row, or null to clear the seat. */
export const systemImageSourcePutRequestSchema = z
  .object({ providerId: z.string().min(1).nullable() })
  .strict();
export type SystemImageSourcePutRequest = z.infer<typeof systemImageSourcePutRequestSchema>;

// --- #362/#450 provider configurable panel (port-only CRUD face) -------------
// GET/POST/PUT/PATCH/DELETE /system/providers(+ /:id, /:id/test): the
// user-face provider configuration 正本 (D1 provider_configs) — and since
// #450 the SOLE directory source (the env MODEL_RELAY_CATALOG pair is
// retired; zero env fallback anywhere on the provider path). Secret
// discipline: `apiKey` is WRITE-ONLY —
// it is AES-GCM encrypted into api_key_enc and never read back; responses
// carry `hasApiKey` presence only. PUT replaces the row's visible face
// wholesale (absent visible fields reset), while BOTH write verbs treat the
// credential column as omission-preserving (absent → keep, null → clear,
// string → set) — secrets are never round-tripped through the client, so an
// edit that omits the key cannot silently wipe it.

export const providerConfigIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$");

/**
 * SEC-W5-003: a provider row is a credential-decryption face — the stored
 * key rides probe headers to the row's baseUrl (services/provider-config-test.ts),
 * so a baseUrl is only legal when it names a PUBLIC https origin the operator
 * deliberately chose. Everything else (http, IP literals, single-label or
 * reserved-suffix hosts, userinfo tricks) is rejected at the write faces
 * (422) instead of becoming an exfil/SSRF seam. The same rule guards the
 * raw-anchored discovery payload and the models-yml import candidates; the
 * env deployment seed stays redeploy-managed (deployment-time input).
 */
const RESERVED_URL_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
  ".lan",
  ".intranet",
  ".corp",
  ".private",
];

export function isPublicHttpsBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.includes(":")) return false;
  // Dotted domain names only: IP literals (WHATWG-normalized decimal forms
  // included) are never public domains.
  if (/^[\d.]+$/.test(host)) return false;
  if (!host.includes(".")) return false;
  if (RESERVED_URL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return host.split(".").every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export const publicHttpsBaseUrlSchema = z.string().min(1).max(2000).refine(isPublicHttpsBaseUrl, {
  message: "baseUrl must be an https URL naming a public domain (no http, IPs, or intranet hosts)",
});

export const providerConfigWriteSchema = z.strictObject({
  displayName: z.string().min(1).max(200).optional(),
  baseUrl: publicHttpsBaseUrlSchema.optional(),
  api: z.string().min(1).max(64).optional(),
  serviceTier: z.boolean().optional(),
  models: z.array(relayCatalogModelSchema).optional(),
  apiKey: z.string().min(1).optional(),
});
export type ProviderConfigWrite = z.infer<typeof providerConfigWriteSchema>;

export const providerConfigCreateRequestSchema = providerConfigWriteSchema.extend({
  id: providerConfigIdSchema,
});
export type ProviderConfigCreateRequest = z.infer<typeof providerConfigCreateRequestSchema>;

/** PUT: visible-face replace; the credential column follows the null protocol. */
export const providerConfigReplaceRequestSchema = providerConfigWriteSchema.extend({
  apiKey: z.string().min(1).nullish(),
});
export type ProviderConfigReplaceRequest = z.infer<typeof providerConfigReplaceRequestSchema>;

export const providerConfigPatchRequestSchema = z.strictObject({
  displayName: z.string().min(1).max(200).nullish(),
  baseUrl: publicHttpsBaseUrlSchema.nullish(),
  api: z.string().min(1).max(64).nullish(),
  serviceTier: z.boolean().optional(),
  models: z.array(relayCatalogModelSchema).optional(),
  apiKey: z.string().min(1).nullish(),
});
export type ProviderConfigPatchRequest = z.infer<typeof providerConfigPatchRequestSchema>;

/**
 * One user row of the D1 provider_configs 正本. #434 (point 6): the CRUD
 * display face lists ONLY user rows — the env seed has no rows here; its
 * read faces are provider-projections / execution-options.
 */
export const providerConfigRowSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable(),
  baseUrl: z.string().nullable(),
  api: z.string().nullable(),
  serviceTier: z.boolean(),
  /** The RAW stored models value — an invalid row stays visible for repair. */
  models: z.array(z.unknown()),
  hasApiKey: z.boolean(),
  status: z.enum(["ok", "warning"]),
  warnings: z.array(z.string()),
  dispatchable: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProviderConfigRow = z.infer<typeof providerConfigRowSchema>;

export const providerConfigsListResponseSchema = z.object({
  providers: z.array(providerConfigRowSchema),
});
export type ProviderConfigsListResponse = z.infer<typeof providerConfigsListResponseSchema>;

/** POST /system/providers/:id/test — one minimal probe, true/false verdict. */
export const providerConfigTestResponseSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type ProviderConfigTestResponse = z.infer<typeof providerConfigTestResponseSchema>;

/**
 * POST /system/providers/discover-models (PM addition ①; #447 enrichment):
 * the /models discovery face. Exactly one anchor is required — an unsaved
 * row's {baseUrl, apiKey?} (the typed key is write-only, used for the one
 * probe) or a saved row's {providerId} (uses the row's baseUrl + stored
 * secret; the plaintext never round-trips through the panel). Discovered
 * entries that cannot become a catalog model seat ride `warnings` — skip-
 * with-warning, never silently dropped.
 *
 * #447: discovery runs ON a connected host over the host online-RPC seam
 * (`host.discover_models`) so omp's pi-catalog enrichment applies (Bun-only
 * catalog hydration lives on the host). `hostId` pins the serving host;
 * omitted, the route picks registered hosts in creation order. When no host
 * can serve, the route falls back to its own bare probe — those rows carry
 * id/name only, marked `metadataSource: "unavailable"`, plus a warning
 * naming the degradation. Rows are draft-projection
 * material: the stored catalog schema (relayCatalogModelSchema) rejects the
 * display seats (`thinking`, `metadataSource`), so write-back goes through
 * the panel's draft projection.
 */
const providerConfigDiscoverByRowSchema = z.strictObject({
  providerId: providerConfigIdSchema,
  apiKey: z.string().min(1).optional(),
  hostId: z.string().min(1).optional(),
});
const providerConfigDiscoverByBaseUrlSchema = z.strictObject({
  baseUrl: publicHttpsBaseUrlSchema,
  apiKey: z.string().min(1).optional(),
  hostId: z.string().min(1).optional(),
});
/** The union IS the exactly-one-anchor rule: strict members reject mixed
 * or empty payloads (422), and the route narrows on the discriminant. */
export const providerConfigDiscoverRequestSchema = z.union([
  providerConfigDiscoverByRowSchema,
  providerConfigDiscoverByBaseUrlSchema,
]);
export type ProviderConfigDiscoverRequest = z.infer<typeof providerConfigDiscoverRequestSchema>;

export const providerConfigDiscoverResponseSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
  models: z.array(discoveredModelEntrySchema),
  warnings: z.array(z.string()),
});
export type ProviderConfigDiscoverResponse = z.infer<typeof providerConfigDiscoverResponseSchema>;

// --- #364 omp models.yml import (paste-to-panel one-click lift) --------------
// POST /system/providers/import-models-yml: the panel pastes an omp
// ~/.omp/agent/models.yml fragment and the server parses + maps it into
// provider_configs rows through the SAME insert/encryption path the CRUD
// face uses (apiKey plaintext rides this one request body exactly once,
// then only api_key_enc ciphertext exists). Semantics live in
// @cap/provider-app models-yml-import.ts (omp models-config-schema ground
// truth); this face only bounds the payload and describes the verdicts.

export const providerConfigImportRequestSchema = z.strictObject({
  /** The pasted YAML text (a full models.yml or a bare fragment of it). */
  yaml: z.string().min(1).max(524_288),
});
export type ProviderConfigImportRequest = z.infer<typeof providerConfigImportRequestSchema>;

/**
 * Per-provider verdict: `created` rows report HTTP-grade 201; every refusal
 * is a named code with its HTTP-grade status (409 exists/reserved, 422
 * unsupported api/invalid shape/master-key gate) — an out-of-family api
 * value is an explicit 422 unsupported_api verdict, never a silent drop.
 * `warnings` carries the migration transcript (dropped omp-only keys,
 * unresolvable $$CREDENTIAL_ placeholders, skipped model rows).
 */
export const providerConfigImportEntrySchema = z.object({
  id: z.string().min(1),
  verdict: z.enum(["created", "skipped"]),
  status: z.number().int(),
  code: z.string().min(1),
  message: z.string(),
  modelCount: z.number().int().nonnegative(),
  hasApiKey: z.boolean(),
  warnings: z.array(z.string()),
});
export type ProviderConfigImportEntry = z.infer<typeof providerConfigImportEntrySchema>;

export const providerConfigImportResponseSchema = z.object({
  providers: z.array(providerConfigImportEntrySchema),
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type ProviderConfigImportResponse = z.infer<typeof providerConfigImportResponseSchema>;

export const systemConfigReloadResponseSchema = z.object({
  ok: z.literal(true),
});

/**
 * Whether a machine's copy of the built-in bb CLI skills matches what this
 * server would install. "unknown" covers a disconnected machine or one that
 * could not be asked.
 */
export const cliSkillMachineStatusSchema = z.enum(["installed", "outdated", "missing", "unknown"]);
export type CliSkillMachineStatus = z.infer<typeof cliSkillMachineStatusSchema>;

export const systemCliSkillsStatusQuerySchema = z.object({
  /** Comma-separated machine ids; omit for every enrolled machine. */
  hostIds: z.string().optional(),
});
export type SystemCliSkillsStatusQuery = z.infer<typeof systemCliSkillsStatusQuerySchema>;

export const systemCliSkillsStatusResponseSchema = z.object({
  machines: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string(),
      status: cliSkillMachineStatusSchema,
    }),
  ),
});
export type SystemCliSkillsStatusResponse = z.infer<typeof systemCliSkillsStatusResponseSchema>;

/** The machines to copy the built-in bb CLI skills onto. */
export const systemInstallCliSkillsRequestSchema = z.object({
  hostIds: z.array(z.string().min(1)).min(1).max(64),
});
export type SystemInstallCliSkillsRequest = z.infer<typeof systemInstallCliSkillsRequestSchema>;

/**
 * One entry per requested machine. A machine that is offline or otherwise
 * refuses the install fails on its own without taking the others down, so the
 * caller can report exactly which machines got the skills.
 */
export const systemInstallCliSkillsResponseSchema = z.object({
  results: z.array(
    z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        hostId: z.string(),
        hostName: z.string(),
        installations: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
          }),
        ),
      }),
      z.object({
        ok: z.literal(false),
        hostId: z.string(),
        hostName: z.string(),
        errorMessage: z.string(),
      }),
    ]),
  ),
});
export type SystemInstallCliSkillsResponse = z.infer<typeof systemInstallCliSkillsResponseSchema>;
export type SystemConfigReloadResponse = z.infer<typeof systemConfigReloadResponseSchema>;
