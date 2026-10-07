import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  BROWSER_BACKED_ENGINES,
  DEFAULT_WEB_SEARCH_CONFIG,
  projectWebSearchConfig,
  resolveWebSearchConfig,
  SEARCH_ENGINE_IDS,
  IMAGE_SOURCE_API_FAMILY,
  isImageGenerationModelId,
  relayCatalogModelSchema,
  relayImageModelKeys,
  relayImageModelSchema,
  SYNTHETIC_RELAY_PROVIDER_ID,
  type RelayCatalogProvider,
} from "@cap/agent-do";
import type { WebSearchEngineProjection } from "@cap/agent-do";
import {
  isValidProviderConfigId,
  ModelsYmlImportError,
  loadProviderConfigCatalogOverlay,
  loadProviderConfigOverlay,
  parseModelsYml,
  projectHarness,
  resolveOverlayCatalog,
  resolveHarness,
  type ProviderConfigCatalogOverlay,
  type HarnessEnv,
  type ModelsYmlImportParse,
  type WebSearchOverlayRow,
  type WebSearchSecretsMeta,
  type WebSearchStoredEngines,
  type WebSearchStoredSecrets,
} from "@cap/provider-app";
import {
  systemProviderProjectionsResponseSchema,
  systemConfigResponseSchema,
  systemExecutionOptionsQuerySchema,
  systemExecutionOptionsResponseSchema,
  systemVersionResponseSchema,
  isPublicHttpsBaseUrl,
  providerConfigCreateRequestSchema,
  providerConfigDiscoverRequestSchema,
  providerConfigDiscoverResponseSchema,
  providerConfigIdSchema,
  providerConfigImportRequestSchema,
  providerConfigImportResponseSchema,
  providerConfigPatchRequestSchema,
  providerConfigReplaceRequestSchema,
  providerConfigRowSchema,
  providerConfigTestResponseSchema,
  providerConfigsListResponseSchema,
  systemImageSourcePutRequestSchema,
  systemImageSourceResponseSchema,
  systemToolCapabilitiesPutRequestSchema,
  systemToolCapabilitiesResponseSchema,
  systemWebSearchPutRequestSchema,
  systemWebSearchResponseSchema,
  type ProviderConfigImportEntry,
  type ProviderConfigRow,
  type SystemExecutionOptionsResponse,
} from "../contract/api/system.js";
import type { AvailableModel } from "../contract/domain/provider-types.js";
import { appSettingsSchema } from "../contract/domain/app-settings.js";
import { appKeybindingOverridesSchema } from "../contract/domain/app-keybindings.js";
import { experimentsSchema } from "../contract/domain/experiments.js";
import {
  defaultAppTheme,
  isBuiltInThemeId,
  builtInThemeIdSchema,
  faviconColorPreferenceSchema,
} from "../contract/domain/app-theme.js";
import { DEFAULT_APP_KEYBINDINGS } from "../services/system/app-keybindings.js";
import { defaultFeatureFlags } from "../contract/domain/feature-flags.js";
import { ApiError, parseOr422, requireJsonBody } from "../shared/route-utils.js";
import {
  deleteProviderConfig,
  getProviderConfigMutationContext,
  getProviderConfigTarget,
  insertProviderConfig,
  patchProviderConfig,
  readProviderConfigSecret,
  replaceProviderConfig,
  type CredentialUpdate,
  type ProviderConfigWriteFields,
} from "../db/provider-configs.js";
import { getImageSourceProviderId, setImageSourceProviderId } from "../db/image-source.js";
import { getToolCapabilities, setToolCapabilities } from "../db/tool-capabilities.js";
import { setWebSearchConfig, webSearchHasSecrets } from "../db/web-search.js";
import {
  discoverProviderModelsEnriched,
  probeProviderConnection,
} from "../services/provider-config-test.js";
import { consumeProbeSlot } from "../services/probe-rate-limit.js";
import { resolvePrimaryHostId } from "../services/host-records.js";
import {
  getAppSettingsRow,
  getExperiments,
  getKeybindingOverrides,
  setAppSettings,
  setExperiments,
  setStoredAppearance,
  getStoredAppearance,
  applyAppKeybindingOverrides,
  toAppSettings,
} from "../db/settings.js";
import { listStoredThreadModelOverrides } from "../db/control-plane.js";
import type { AppEnv, Env } from "../app-types.js";

/**
 * System + settings face (bb apps/server/src/routes/system.ts, commit
 * 8473d8c33): GET /system/config, PUT /settings/general, PUT
 * /settings/keyboard, PUT /settings/experiments, PUT /settings/appearance,
 * POST /system/config/reload, GET /system/version, GET
 * /system/execution-options. Theme catalog faces are reduced to the built-in
 * catalog (no fs themeRoot, no plugin themes).
 */

const appearancePutSchema = z
  .object({
    themeId: z.string().min(1).optional(),
    faviconColor: faviconColorPreferenceSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => value.themeId !== undefined || value.faviconColor !== undefined, {
    message: "At least one field must be provided",
  });

export function buildSystemConfig(env: Env, requestUrl: URL) {
  const origin = `${requestUrl.protocol}//${requestUrl.host}`;
  return {
    generalSettings: undefined as never, // replaced by caller
    keybindings: applyAppKeybindingOverrides(DEFAULT_APP_KEYBINDINGS, []),
    defaultKeybindings: DEFAULT_APP_KEYBINDINGS,
    keybindingOverrides: [] as never, // replaced by caller
    experiments: undefined as never, // replaced by caller
    appearance: defaultAppTheme,
    customThemes: [],
    pluginThemes: [],
    featureFlags: defaultFeatureFlags,
    hostDaemonPort: env.HOST_DAEMON_PORT !== undefined ? Number(env.HOST_DAEMON_PORT) : null,
    serverUrl: origin,
    primaryHostPlatform: null,
    voiceTranscriptionEnabled: false,
    dataDir: env.DATA_DIR ?? "/data",
  };
}

/**
 * GET /system/execution-options (bb public-api.ts:1405-1409, route at
 * apps/server/src/routes/system.ts:347-349). bb resolves the catalog by
 * probing installed agents on the routed host
 * (services/system/execution-options.ts:395-491); the Worker port has no host
 * to probe, so the catalog is the D1 provider-config 正本 instead (#450:
 * the env seed is deleted) — the panel rows projected through ONE
 * resolution shared with the registry (provider-app resolveOverlayCatalog —
 * the #319 dual-face pattern generalized to the catalog layer, roadmap
 * §0.1/§2.3). #434/#450: no configured rows → an EMPTY directory —
 * nothing is synthesized; the picker is honestly empty until the panel
 * adds rows. The response
 * shape is bb-verbatim (server-contract/src/api/system.ts:35-58) so the SPA
 * picker consumes it unmodified (shape fixture:
 * apps/app/src/hooks/useThreadCreationOptions.test.tsx:44-114); the typed
 * return is the compile-time parity guard pinning the catalog ladder
 * vocabulary to bb's ReasoningLevel enum (shared-types.ts:18-27).
 */
export function buildExecutionOptions(
  env: HarnessEnv,
  overlayProviders: Record<string, RelayCatalogProvider>,
  selectedOnlyModels: AvailableModel[] = [],
): SystemExecutionOptionsResponse {
  const catalog = resolveOverlayCatalog(resolveHarness(env), overlayProviders);
  return {
    providers: catalog.providers.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      logoUrl: null,
      capabilities: {
        supportsArchive: false,
        supportsRename: false,
        supportsServiceTier: provider.serviceTier,
        supportsUserQuestion: false,
        supportsFork: false,
        supportsImageInput: provider.imageInput,
        // min(1) required (domain/provider-types.ts:72); the harness turns
        // run at the "full" default (env.ts HARNESS_PERMISSION_MODE).
        supportedPermissionModes: ["full"],
      },
      composerActions: [],
      available: true,
    })),
    // "full" is bb's value when the machine is uncapped or none routed
    // (server-contract/src/api/system.ts:37-41) — the Worker has no machine
    // permission cap.
    permissionCeiling: "full",
    models: catalog.models.map((model) => ({
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      // The ladder is budget-derived (deriveRelayReasoning over
      // MODEL_RELAY_THINKING_BUDGET_TOKENS, declared overrides folded):
      // budget off → exactly "none" (bb's level for no extended thinking,
      // domain/shared-types.ts:13-20); budget on → the runnable rungs the
      // declaration carries. The default rung equals the harness
      // execution.reasoningLevel by construction (same resolution).
      supportedReasoningEfforts: model.reasoningLevels.map((level) => ({
        reasoningEffort: level,
        description: "",
      })),
      defaultReasoningEffort: model.defaultReasoningLevel,
      isDefault: model.isDefault,
    })),
    // #486: stored thread overrides the merged directory no longer declares
    // project as selectable-only rows (the bb retired-model pool contract,
    // api/system.ts:53-59) — the picker keeps rendering a stored selection
    // instead of silently recovering onto the catalog default. Dispatching a
    // pooled row still validates fail-closed (422 model_unknown) at send.
    // An EMPTY directory (unconfigured/broken deployment, #434) stays
    // verbatim-empty: nothing is pooled onto a face that declares nothing.
    selectedOnlyModels:
      catalog.models.length > 0
        ? selectedOnlyModels.filter(
            (model) => !catalog.models.some((row) => row.id === model.model),
          )
        : [],
    modelLoadError: null,
  };
}

/**
 * #486 selected-only pool projection: a stored override string that left the
 * directory still needs a picker-renderable row. The row is identity-shaped
 * (label = id, no declared ladder — the reasoning knob falls back to the SPA's
 * stored rung), never marked default, and dispatch stays fail-closed upstream.
 */
function projectStoredOverrideRows(models: string[]): AvailableModel[] {
  return models.map((model) => ({
    id: model,
    model,
    displayName: model,
    description: "",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "none",
    isDefault: false,
  }));
}

/** The projections-face webSearch row: the D1 overlay half (#449) mapped to
 * the aggregate shape. No overlay (rigs without D1) = the ruled defaults
 * (configured:false); a broken row reports decodeError with NO chain —
 * never a silently substituted default. */
function webSearchProjectionRow(overlayRow: WebSearchOverlayRow | undefined): {
  configured: boolean;
  decodeError: boolean;
  chain: WebSearchEngineProjection[];
  timeoutSeconds: number | null;
  browserBackedEngines: string[];
} {
  // No overlay (rigs without D1) = the ruled defaults — the same shape the
  // loader's absent-row half projects.
  if (overlayRow === undefined) {
    return {
      configured: false,
      decodeError: false,
      chain: projectWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG).chain,
      timeoutSeconds: DEFAULT_WEB_SEARCH_CONFIG.timeoutSeconds,
      browserBackedEngines: [...BROWSER_BACKED_ENGINES],
    };
  }
  if (overlayRow.projection === null) {
    return {
      configured: overlayRow.configured,
      decodeError: overlayRow.decodeError,
      chain: [],
      timeoutSeconds: null,
      browserBackedEngines: [...BROWSER_BACKED_ENGINES],
    };
  }
  return {
    configured: overlayRow.configured,
    decodeError: false,
    chain: overlayRow.projection.chain,
    timeoutSeconds: overlayRow.projection.timeoutSeconds,
    browserBackedEngines: [...overlayRow.projection.browserBackedEngines],
  };
}

/**
 * #484: did the deployment actually feed the legacy deployment channel?
 * Any non-blank member of the channel env family counts (the vars
 * resolveHarness reads plus its two execution pins). Zero members = the
 * harness row is the honest empty channel (mode "unconfigured", #496 —
 * nothing synthesized) — the panel hides it (#450: D1 provider_configs is
 * the sole provider 正本, zero env fallback).
 */
function deploymentChannelEnvConfigured(env: HarnessEnv): boolean {
  const channelVars: (string | undefined)[] = [
    env.MODEL_RELAY_BASE_URL_ANTHROPIC,
    env.MODEL_RELAY_API_KEY,
    env.MODEL_RELAY_MODEL,
    env.MODEL_RELAY_CONTEXT_WINDOW,
    env.MODEL_RELAY_MAX_TOKENS,
    env.MODEL_RELAY_THINKING_BUDGET_TOKENS,
    env.MODEL_RELAY_IMAGE_INPUT,
    env.DAEMON_MACHINE_ID,
    env.HARNESS_PERMISSION_MODE,
  ];
  return channelVars.some((value) => value !== undefined && value.trim() !== "");
}

/**
 * GET /system/provider-projections (#266, #255 solution C): aggregate the
 * read-only provider status face. Harness row = projectHarness over
 * resolveHarness (the same total resolution thread turns run) plus the relay
 * host and the #484 `envConfigured` gate; web_search row = the D1
 * `web_search` overlay half (#449 — the AGENT_DO_WEB_SEARCH env path is
 * deleted, the row is the sole 正本): chain order, credential-gate booleans,
 * browser-backed exclusions. Zero secret values leave the DB: key/token
 * contents never enter the response, and decode failures drop the error text
 * (it can quote raw row content). Daemon-side provider pins (judge/security)
 * are NOT visible here — they live in daemon env, a different trust domain
 * (#255 §6.2, ticket #56).
 */
export function buildProviderProjections(
  env: HarnessEnv,
  overlay: Pick<
    ProviderConfigCatalogOverlay,
    "providers" | "imageSourceProviderId" | "webSearch"
  >,
) {
  // One resolution for both rows: the harness projection and the catalog
  // status project the same evaluation (same-source; the D1 rows are the
  // sole directory source, #450).
  const resolution = resolveOverlayCatalog(resolveHarness(env), overlay.providers);
  const harness = projectHarness(resolution.harness);
  // Total over env content: a malformed relay URL degrades to a null host
  // instead of failing the whole read-only face.
  let relayBaseUrlHost: string | null = null;
  try {
    relayBaseUrlHost = new URL(harness.relayBaseUrl).host;
  } catch {
    // env content, not a caller error
  }
  const webSearch = webSearchProjectionRow(overlay.webSearch);
  // #448: generate_image availability, presence-only. The 产图源 seat is
  // the only gate (#450 — zero env fallback): configured iff the selection
  // resolves to a dispatchable api=openai-images row. A dangling selection
  // (row deleted after selection) reports configured:false with the seat id
  // intact, so the panel can show what to repair.
  const imageSourceProviderId = overlay.imageSourceProviderId;
  const imageSourceRow =
    imageSourceProviderId === null ? undefined : overlay.providers[imageSourceProviderId];
  const imageGeneration = {
    providerId: imageSourceProviderId,
    configured: imageSourceRow?.api === IMAGE_SOURCE_API_FAMILY && imageSourceRow.models.length > 0,
  };
  return {
    harness: { ...harness, relayBaseUrlHost, envConfigured: deploymentChannelEnvConfigured(env) },
    webSearch,
    // Catalog status (#350 shape, #450 semantics): ids and decode state
    // only — the full values live on GET /system/execution-options.
    // decodeError is retired with the env seed (constant false — D1 rows
    // carry per-row warnings on the CRUD face instead); defaultProviderId
    // is null forever (no first-key fill, #434).
    catalog: {
      configured: resolution.configured,
      decodeError: resolution.decodeError,
      defaultProviderId: resolution.defaultProviderId,
      defaultModel: resolution.harness.relay.model,
      providers: resolution.providers.map((provider) => provider.id),
      models: resolution.models.map((model) => model.id),
      imageGeneration,
    },
  };
}

export function registerSystemRoutes(app: Hono<AppEnv>): void {
  const routes = new Hono<AppEnv>();

  routes.get("/system/config", async (ctx) => {
    const url = new URL(ctx.req.url);
    const settingsRow = await getAppSettingsRow(ctx.env);
    const overrides = await getKeybindingOverrides(ctx.env);
    const experiments = await getExperiments(ctx.env);
    const stored = await getStoredAppearance(ctx.env);
    const draft = buildSystemConfig(ctx.env, url);
    // #502: the tool-gate vocabulary projects the D1 `tool_capabilities`
    // seat (the row is the single 正本 — an absent row is the all-off omp
    // posture). Read-time resolution, the same posture as the rest of the
    // config face's D1 legs.
    const toolCapabilities = await getToolCapabilities(ctx.env);
    const candidate = {
      generalSettings: toAppSettings(settingsRow),
      keybindings: applyAppKeybindingOverrides(DEFAULT_APP_KEYBINDINGS, overrides),
      defaultKeybindings: DEFAULT_APP_KEYBINDINGS,
      keybindingOverrides: overrides,
      experiments,
      appearance:
        stored !== null
          ? {
              ...defaultAppTheme,
              themeId: isBuiltInThemeId(stored.themeId) ? stored.themeId : defaultAppTheme.themeId,
              faviconColor: stored.faviconColor ?? defaultAppTheme.faviconColor,
            }
          : defaultAppTheme,
      customThemes: draft.customThemes,
      pluginThemes: draft.pluginThemes,
      featureFlags: {
        ...draft.featureFlags,
        toolCapabilities: {
          externalThinking: toolCapabilities.externalThinking,
          contextNotes: toolCapabilities.contextNotes,
          checkpoint: toolCapabilities.checkpoint,
        },
      },
      hostDaemonPort: draft.hostDaemonPort,
      serverUrl: draft.serverUrl,
      // #436: read-time resolution — the cascade's server-body leg names the
      // cloud placeholder (services/host-records.ts resolvePrimaryHostId);
      // buildSystemConfig stays the pure env/URL draft without D1 access.
      primaryHostId: await resolvePrimaryHostId(ctx.env),
      primaryHostPlatform: draft.primaryHostPlatform,
      voiceTranscriptionEnabled: draft.voiceTranscriptionEnabled,
      dataDir: draft.dataDir,
    };
    return ctx.json(systemConfigResponseSchema.parse(candidate));
  });

  // bb mounts settings under /api/v1/settings/* (public-api.ts:1349-1382).
  routes.put("/settings/general", async (ctx) => {
    const payload = await requireJsonBody(ctx, appSettingsSchema);
    await setAppSettings(ctx.env, payload);
    await hub(ctx.env).notifySystem(["config-changed"]);
    const row = await getAppSettingsRow(ctx.env);
    return ctx.json(toAppSettings(row));
  });

  routes.put("/settings/keyboard", async (ctx) => {
    const payload = await requireJsonBody(ctx, appKeybindingOverridesSchema);
    await ctx.env.DB.prepare(
      `INSERT INTO app_settings (id, keybinding_overrides, updated_at) VALUES ('app_settings', ?, ?)
       ON CONFLICT(id) DO UPDATE SET keybinding_overrides = excluded.keybinding_overrides, updated_at = excluded.updated_at`,
    )
      .bind(JSON.stringify(payload), Date.now())
      .run();
    await hub(ctx.env).notifySystem(["config-changed"]);
    const row = await getAppSettingsRow(ctx.env);
    return ctx.json(toAppSettings(row));
  });

  routes.put("/settings/experiments", async (ctx) => {
    const payload = await requireJsonBody(ctx, experimentsSchema);
    await setExperiments(ctx.env, payload);
    await hub(ctx.env).notifySystem(["config-changed"]);
    return ctx.json(await getExperiments(ctx.env));
  });

  routes.put("/settings/appearance", async (ctx) => {
    const payload = await requireJsonBody(ctx, appearancePutSchema);
    if (payload.themeId !== undefined && !isBuiltInThemeId(payload.themeId)) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "Unknown theme id",
      });
    }
    const stored = await getStoredAppearance(ctx.env);
    const fallbackThemeId = builtInThemeIdSchema.options[0] ?? defaultAppTheme.themeId;
    const themeId = payload.themeId ?? stored?.themeId ?? fallbackThemeId;
    const faviconColor =
      payload.faviconColor !== undefined ? payload.faviconColor : (stored?.faviconColor ?? null);
    await setStoredAppearance(ctx.env, { themeId, faviconColor });
    await hub(ctx.env).notifySystem(["config-changed"]);
    return ctx.json(toAppSettings(await getAppSettingsRow(ctx.env)));
  });

  routes.post("/system/config/reload", (ctx) => {
    // bb reloads the bbAppManagedConfig from disk; the Worker config source is
    // env vars, so there is nothing to reload — success semantics preserved.
    return ctx.json({ ok: true });
  });

  routes.get("/system/version", (ctx) => {
    // bb 422s on unknown query params; validate the surface (nothing to
    // reload/force in the Worker — the flag is accepted and ignored).
    parseOr422(z.object({ force: z.enum(["true", "false"]).optional() }), ctx.req.query());
    const currentVersion = ctx.env.SERVER_VERSION ?? "0.0.0-dev";
    return ctx.json(
      systemVersionResponseSchema.parse({
        currentVersion,
        latestVersion: null,
        source: "npm",
        updateAvailable: false,
        isDevelopment: true,
        upgradeCommand: "npm install -g bb@latest",
      }),
    );
  });

  routes.get("/system/execution-options", async (ctx) => {
    // bb validates the query against systemExecutionOptionsQuerySchema
    // (public-api.ts:1408-1409); hostId and environmentId are mutually
    // exclusive. The Worker has no host routing; providerId scopes the #486
    // stored-override selected-only pool (the thread composer always names
    // one) while the primary directory is served regardless.
    const query = parseOr422(systemExecutionOptionsQuerySchema, ctx.req.query());
    // #450: the D1 provider rows ARE the directory — a panel-side provider
    // appears here on the next request (no redeploy, no reload); zero rows
    // serve the honest empty picker.
    const overlay = await loadProviderConfigCatalogOverlay(ctx.env);
    return ctx.json(
      systemExecutionOptionsResponseSchema.parse(
        buildExecutionOptions(
          ctx.env,
          overlay?.providers ?? {},
          projectStoredOverrideRows(
            await listStoredThreadModelOverrides(ctx.env, query.providerId),
          ),
        ),
      ),
    );
  });

  // Read-only projection face (#266). Since #362 the user-face write path is
  // /system/providers (the D1 正本); this face still has no PUT anywhere —
  // POST /system/config/reload remains a deliberate no-op for it.
  routes.get("/system/provider-projections", async (ctx) => {
    const overlay = await loadProviderConfigCatalogOverlay(ctx.env);
    return ctx.json(
      systemProviderProjectionsResponseSchema.parse(
        buildProviderProjections(ctx.env, overlay ?? {
          providers: {},
          imageSourceProviderId: null,
          webSearch: {
            configured: false,
            decodeError: false,
            projection: null,
            engines: null,
          },
        }),
      ),
    );
  });

  registerProviderConfigRoutes(routes);

  app.route("/api/v1", routes);
}

function hub(env: Env) {
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  return stub as DurableObjectStub & {
    notifySystem(changes: string[]): Promise<{ delivered: number }>;
  };
}

/**
 * #362 the provider configurable panel's CRUD face (the user 正本). Writes
 * go straight to D1; every response row is re-read through the loader so the
 * panel sees exactly the stored truth (including skip-with-warning status).
 * All of it rides the standard /api/v1 auth ladder (origin guard + Access
 * gate, app.ts:37-42).
 */
function registerProviderConfigRoutes(routes: Hono<AppEnv>): void {
  const requireValidId = (raw: string): string => {
    if (!providerConfigIdSchema.safeParse(raw).success || !isValidProviderConfigId(raw)) {
      throw new ApiError({
        status: 422,
        code: "validation_failed",
        message: `invalid provider id "${raw}" (expected ^[A-Za-z0-9][A-Za-z0-9._-]*$)`,
      });
    }
    return raw;
  };

  const credentialOf = (apiKey: string | null | undefined): CredentialUpdate => {
    if (apiKey === undefined) return { kind: "keep" };
    if (apiKey === null) return { kind: "clear" };
    return { kind: "set", plaintext: apiKey };
  };

  const writeFieldsOf = (payload: {
    displayName?: string;
    baseUrl?: string;
    api?: string;
    serviceTier?: boolean;
    models?: unknown[];
  }): ProviderConfigWriteFields => ({
    displayName: payload.displayName ?? null,
    baseUrl: payload.baseUrl ?? null,
    api: payload.api ?? null,
    serviceTier: payload.serviceTier ?? false,
    models: payload.models ?? [],
  });

  /** The stored truth after a write (loader shape — status included). */
  const rowAfterWrite = async (env: Env, id: string): Promise<ProviderConfigRow> => {
    const load = await loadProviderConfigOverlay(env);
    const row = load?.rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      throw new ApiError({
        status: 500,
        code: "internal",
        message: `provider config ${id} vanished immediately after write`,
      });
    }
    return providerConfigRowSchema.parse(row);
  };

  const refuseKeyWithoutMasterKey = (env: Env, credential: CredentialUpdate): void => {
    if (
      credential.kind === "set" &&
      (env.PROVIDER_CONFIG_MASTER_KEY === undefined || env.PROVIDER_CONFIG_MASTER_KEY === "")
    ) {
      throw new ApiError({
        status: 422,
        code: "master_key_missing",
        message:
          "PROVIDER_CONFIG_MASTER_KEY is not configured — refusing to store a plaintext API key " +
          "(set the Worker secret first; rows without keys still work in mock mode)",
      });
    }
  };

  /**
   * SEC-W5-003 rebinding gate: /test and /discover-models decrypt the stored
   * credential onto the wire toward the row's CURRENT baseUrl, so a write
   * that moves baseUrl while KEEPING the stored key would hand that key to a
   * caller-chosen endpoint. Moving baseUrl therefore requires re-entering the
   * credential for the new target in the same request, or clearing it — the
   * keep protocol alone is not enough to re-anchor a credential.
   */
  const refuseCredentialReplayAcrossBaseUrl = (
    current: { baseUrl: string | null; hasCredential: boolean },
    nextBaseUrl: string | null,
    credential: CredentialUpdate,
  ): void => {
    if (credential.kind !== "keep" || !current.hasCredential) return;
    if ((nextBaseUrl ?? null) === (current.baseUrl ?? null)) return;
    throw new ApiError({
      status: 422,
      code: "credential_reentry_required",
      message:
        "changing baseUrl would send the stored credential to a new endpoint — " +
        "re-enter apiKey for the new baseUrl in the same request, or clear the credential (apiKey: null)",
    });
  };

  /**
   * Shared probe-face budget (SEC-W5-003): both endpoints consume ONE fixed
   * window keyed by the verified Access principal (gate-on deployments) or
   * the client IP, so neither face is an unlimited outbound-request oracle
   * even before any credential exists.
   */
  const assertProbeSlotAvailable = (ctx: Context<AppEnv>): void => {
    const slot = consumeProbeSlot(
      ctx.get("accessPrincipalId") ?? ctx.req.header("cf-connecting-ip") ?? "anonymous",
    );
    if (slot.allowed) return;
    throw new ApiError({
      status: 429,
      code: "probe_rate_limited",
      message: `probe rate limit exceeded — retry in ${slot.retryAfterSeconds}s`,
      retryable: true,
      details: { retryAfterSeconds: slot.retryAfterSeconds },
    });
  };

  /**
   * #485 the row⇄model family pairing gate (write half of the family split):
   * a write's model entries must belong to the row's EFFECTIVE family — the
   * payload's api seat for POST/PUT, the stored api for a PATCH that moves
   * only models. Cross-family entries answer named 422s instead of leaking
   * into storage: 产图 model ids never enter a chat row (they cannot serve
   * chat turns), and the chat seats (reasoning/input/contextWindow/maxTokens/
   * thinking ladder/per-token cost) never enter an image row.
   */
  const assertModelFamilyPairing = (models: unknown[], effectiveApi: string | null): void => {
    const imageFamily = effectiveApi === IMAGE_SOURCE_API_FAMILY;
    for (const [index, entry] of models.entries()) {
      const label = `model ${String(index + 1)}`;
      const keys = typeof entry === "object" && entry !== null ? Object.keys(entry) : [];
      if (imageFamily) {
        if (relayImageModelSchema.safeParse(entry).success) continue;
        const crossSeats = keys.filter((key) => !relayImageModelKeys.includes(key));
        throw new ApiError({
          status: 422,
          code: "chat_seats_on_image_row",
          message:
            crossSeats.length > 0
              ? `${label} declares chat seat(s) (${crossSeats.join(", ")}) — an api=openai-images row ` +
                `carries image semantics only (id/name/description/sizes/outputFormat/cost.perImage); ` +
                `remove them (they belong on a chat row)`
              : `${label} is not a usable image model row ` +
                `(id/name/description/sizes/outputFormat/cost.perImage)`,
        });
      }
      const parsedChat = relayCatalogModelSchema.safeParse(entry);
      if (!parsedChat.success) {
        const imageSeats = keys.filter(
          (key) =>
            relayImageModelKeys.includes(key) &&
            key !== "id" &&
            key !== "name" &&
            key !== "description",
        );
        throw new ApiError({
          status: 422,
          code: "image_semantics_on_chat_row",
          message:
            imageSeats.length > 0
              ? `${label} declares image semantics (${imageSeats.join(", ")}) — those belong on an ` +
                `api=openai-images row (Settings → Providers → Image Source)`
              : `${label} is not a usable chat model row ` +
                `(${parsedChat.error.issues
                  .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                  .join("; ")})`,
        });
      }
      if (isImageGenerationModelId(parsedChat.data.id)) {
        throw new ApiError({
          status: 422,
          code: "image_family_model_on_chat_row",
          message:
            `model "${parsedChat.data.id}" is an image-generation model (产图族) — it cannot serve ` +
            `chat turns on a chat provider row; move it to an api=openai-images row and select it in ` +
            `Settings → Providers → Image Source`,
        });
      }
    }
  };

  // #448 the 产图源 face: the explicit generate_image source seat. Distinct
  // path (NOT under /system/providers/:id) so a selection is never confused
  // with a provider row. Read = the stored seat + the dispatchable
  // api=openai-images candidates; write = strict {providerId: string|null},
  // validated against the D1 正本 before the seat moves.
  const imageSourceCandidates = async (env: Env): Promise<string[]> => {
    const overlay = await loadProviderConfigCatalogOverlay(env);
    return Object.entries(overlay?.providers ?? {})
      .filter(([, provider]) => provider.api === IMAGE_SOURCE_API_FAMILY)
      .map(([id]) => id)
      .sort();
  };

  routes.get("/system/image-source", async (ctx) => {
    return ctx.json(
      systemImageSourceResponseSchema.parse({
        providerId: await getImageSourceProviderId(ctx.env),
        candidates: await imageSourceCandidates(ctx.env),
      }),
    );
  });

  routes.put("/system/image-source", async (ctx) => {
    const payload = await requireJsonBody(ctx, systemImageSourcePutRequestSchema);
    if (payload.providerId !== null) {
      const id = requireValidId(payload.providerId);
      const target = await getProviderConfigTarget(ctx.env, id);
      if (target === null) {
        throw new ApiError({
          status: 404,
          code: "provider_config_not_found",
          message: `provider config "${id}" not found (POST /system/providers to create)`,
        });
      }
      if (target.api !== IMAGE_SOURCE_API_FAMILY) {
        throw new ApiError({
          status: 422,
          code: "not_an_image_source",
          message: `provider "${id}" declares api "${target.api ?? "default"}" — only "${IMAGE_SOURCE_API_FAMILY}" rows can serve as the image source`,
        });
      }
      if (target.models.length === 0) {
        throw new ApiError({
          status: 422,
          code: "not_dispatchable",
          message: `provider "${id}" declares no models — add a model row before selecting it as the image source`,
        });
      }
    }
    await setImageSourceProviderId(ctx.env, payload.providerId);
    await hub(ctx.env).notifySystem(["config-changed"]);
    return ctx.json(
      systemImageSourceResponseSchema.parse({
        providerId: payload.providerId,
        candidates: await imageSourceCandidates(ctx.env),
      }),
    );
  });

  // #449 the web-search engine-chain face: the D1 `web_search` row is the
  // sole 正本 (zero env fallback — AGENT_DO_WEB_SEARCH is deleted). Read =
  // the effective chain + zero-secret editable engine detail; write = the
  // full ordered chain plus TRI-STATE engine settings (absent = keep the
  // stored value, null = clear, value = set), validated through the SAME
  // resolveWebSearchConfig path the stored-row loader runs.
  const webSearchFaceOf = async (env: Env) => {
    const overlay = await loadProviderConfigCatalogOverlay(env);
    const ws = overlay?.webSearch;
    return systemWebSearchResponseSchema.parse({
      configured: ws?.configured ?? false,
      decodeError: ws?.decodeError ?? false,
      chain: ws?.projection?.chain ?? [],
      timeoutSeconds: ws?.projection?.timeoutSeconds ?? null,
      browserBackedEngines:
        ws?.projection?.browserBackedEngines ?? [...BROWSER_BACKED_ENGINES],
      availableEngines: [...SEARCH_ENGINE_IDS],
      engines: ws?.engines ?? {
        brave: { hasApiKey: false },
        searxng: {
          endpoint: null,
          categories: null,
          language: null,
          safesearch: null,
          hasToken: false,
          hasBasicAuth: false,
        },
      },
    });
  };

  routes.get("/system/web-search", async (ctx) => {
    return ctx.json(await webSearchFaceOf(ctx.env));
  });

  routes.put("/system/web-search", async (ctx) => {
    const payload = await requireJsonBody(ctx, systemWebSearchPutRequestSchema);
    const load = await loadProviderConfigOverlay(ctx.env);
    const row = load?.webSearch;
    if (row?.decodeError) {
      throw new ApiError({
        status: 422,
        code: "web_search_row_broken",
        message:
          "the stored web_search row failed to decode/decrypt — repair it in D1 before editing through this face (keep-semantics cannot read the stored values)",
      });
    }
    const prior = load?.webSearchConfig;
    // Tri-state merge: undefined = keep the stored value, null = clear,
    // value = set. Cleared and unset fields collapse to absent in storage.
    const tri = (
      priorValue: string | undefined,
      next: string | null | undefined,
    ): string | undefined => (next === undefined ? priorValue : (next ?? undefined));
    const braveApiKey = tri(prior?.engines.brave?.apiKey, payload.engines?.brave?.apiKey);
    const sxToken = tri(prior?.engines.searxng?.token, payload.engines?.searxng?.token);
    const sxUser = tri(
      prior?.engines.searxng?.basicUsername,
      payload.engines?.searxng?.basicUsername,
    );
    const sxPass = tri(
      prior?.engines.searxng?.basicPassword,
      payload.engines?.searxng?.basicPassword,
    );
    const sxEndpoint = tri(prior?.engines.searxng?.endpoint, payload.engines?.searxng?.endpoint);
    const sxCategories = tri(
      prior?.engines.searxng?.categories,
      payload.engines?.searxng?.categories,
    );
    const sxLanguage = tri(prior?.engines.searxng?.language, payload.engines?.searxng?.language);
    const sxSafesearch =
      payload.engines?.searxng?.safesearch === undefined
        ? prior?.engines.searxng?.safesearch
        : (payload.engines.searxng.safesearch ?? undefined);
    const effectiveEngines = {
      ...(braveApiKey !== undefined ? { brave: { apiKey: braveApiKey } } : {}),
      searxng: {
        ...(sxEndpoint !== undefined && { endpoint: sxEndpoint }),
        ...(sxToken !== undefined && { token: sxToken }),
        ...(sxUser !== undefined && { basicUsername: sxUser }),
        ...(sxPass !== undefined && { basicPassword: sxPass }),
        ...(sxCategories !== undefined && { categories: sxCategories }),
        ...(sxLanguage !== undefined && { language: sxLanguage }),
        ...(sxSafesearch !== undefined && { safesearch: sxSafesearch }),
      },
    };
    // The single validation path: unknown/browser-backed chain entries,
    // non-url endpoints, and out-of-vocabulary shapes are REFUSED here —
    // rejection, never silent fallback (L1).
    let effective;
    try {
      effective = resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, {
        chain: payload.chain ?? prior?.chain ?? DEFAULT_WEB_SEARCH_CONFIG.chain,
        timeoutSeconds: payload.timeoutSeconds ?? prior?.timeoutSeconds,
        engines: effectiveEngines,
      });
    } catch (error) {
      throw new ApiError({
        status: 422,
        code: "validation_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // Storage split: the secret half rides the AES-GCM column, the
    // non-secret half the plaintext engines column, and the presence map
    // the zero-secret meta column.
    const secrets: WebSearchStoredSecrets = {
      ...(braveApiKey !== undefined ? { brave: { apiKey: braveApiKey } } : {}),
      ...(sxToken !== undefined || sxUser !== undefined || sxPass !== undefined
        ? {
            searxng: {
              ...(sxToken !== undefined && { token: sxToken }),
              ...(sxUser !== undefined && { basicUsername: sxUser }),
              ...(sxPass !== undefined && { basicPassword: sxPass }),
            },
          }
        : {}),
    };
    const engines: WebSearchStoredEngines = {
      ...(sxEndpoint !== undefined ||
      sxCategories !== undefined ||
      sxLanguage !== undefined ||
      sxSafesearch !== undefined
        ? {
            searxng: {
              ...(sxEndpoint !== undefined && { endpoint: sxEndpoint }),
              ...(sxCategories !== undefined && { categories: sxCategories }),
              ...(sxLanguage !== undefined && { language: sxLanguage }),
              ...(sxSafesearch !== undefined && { safesearch: sxSafesearch }),
            },
          }
        : {}),
    };
    const meta: WebSearchSecretsMeta = {
      ...(secrets.brave !== undefined ? { brave: { apiKey: true } } : {}),
      ...(secrets.searxng !== undefined
        ? {
            searxng: {
              token: secrets.searxng.token !== undefined,
              basic:
                secrets.searxng.basicUsername !== undefined ||
                secrets.searxng.basicPassword !== undefined,
            },
          }
        : {}),
    };
    if (
      webSearchHasSecrets(secrets) &&
      (ctx.env.PROVIDER_CONFIG_MASTER_KEY === undefined ||
        ctx.env.PROVIDER_CONFIG_MASTER_KEY === "")
    ) {
      throw new ApiError({
        status: 422,
        code: "master_key_missing",
        message:
          "PROVIDER_CONFIG_MASTER_KEY is not configured — refusing to store engine secrets " +
          "(set the Worker secret first; credential-free engines still work)",
      });
    }
    await setWebSearchConfig(
      ctx.env,
      {
        chain: effective.chain,
        timeoutSeconds: effective.timeoutSeconds,
        engines,
        secrets,
        meta,
      },
      ctx.env.PROVIDER_CONFIG_MASTER_KEY,
    );
    // Hot-apply broadcast (#382): the engine-chain row rides the same
    // overlay fingerprint as the provider rows, so the next turn picks it
    // up (system.ts:348 precedent).
    await hub(ctx.env).notifySystem(["config-changed"]);
    return ctx.json(await webSearchFaceOf(ctx.env));
  });

  // #502 the experimental tool-capability face: the D1 `tool_capabilities`
  // single-row seat is the sole 正本 (zero env fallback — the three
  // AGENT_DO_* gate envs are deleted). Read = the stored gates (+ whether
  // the row exists at all); write = wholesale replace of the three booleans.
  routes.get("/system/tool-capabilities", async (ctx) => {
    return ctx.json(
      systemToolCapabilitiesResponseSchema.parse(await getToolCapabilities(ctx.env)),
    );
  });

  routes.put("/system/tool-capabilities", async (ctx) => {
    const payload = await requireJsonBody(ctx, systemToolCapabilitiesPutRequestSchema);
    await setToolCapabilities(ctx.env, payload);
    // Hot-apply broadcast (#382): the seat rides the same overlay fingerprint
    // as the provider rows, so the next turn picks the gates up (the
    // image-source/web-search writes ride the same path).
    await hub(ctx.env).notifySystem(["config-changed"]);
    return ctx.json(
      systemToolCapabilitiesResponseSchema.parse(await getToolCapabilities(ctx.env)),
    );
  });

  routes.get("/system/providers", async (ctx) => {
    const load = await loadProviderConfigOverlay(ctx.env);
    // #434 (point 6): the display face lists ONLY user rows — the D1 正本.
    // The env seed's read faces are provider-projections and
    // execution-options (the #388 merged-face posture is retired with the
    // seed-row projection; the seed stays redeploy-managed).
    return ctx.json(providerConfigsListResponseSchema.parse({ providers: load?.rows ?? [] }));
  });

  routes.get("/system/providers/:id", async (ctx) => {
    const id = requireValidId(ctx.req.param("id"));
    const load = await loadProviderConfigOverlay(ctx.env);
    const row = load?.rows.find((candidate) => candidate.id === id);
    if (row !== undefined) {
      return ctx.json(providerConfigRowSchema.parse(row));
    }
    // #434: seed ids resolve 404 like any unknown id — there is no config
    // row behind them (the seed lives in env, read through the projections).
    throw new ApiError({
      status: 404,
      code: "provider_config_not_found",
      message: `provider config "${id}" not found`,
    });
  });

  routes.post("/system/providers", async (ctx) => {
    const payload = await requireJsonBody(ctx, providerConfigCreateRequestSchema);
    if (!isValidProviderConfigId(payload.id)) {
      throw new ApiError({
        status: 422,
        code: "validation_failed",
        message: `invalid provider id "${payload.id}"`,
      });
    }
    if (payload.id === SYNTHETIC_RELAY_PROVIDER_ID) {
      throw new ApiError({
        status: 409,
        code: "provider_config_reserved",
        message: `"${SYNTHETIC_RELAY_PROVIDER_ID}" is reserved (sentinel-era journals reference it) and cannot be configured`,
      });
    }
    if ((await getProviderConfigTarget(ctx.env, payload.id)) !== null) {
      throw new ApiError({
        status: 409,
        code: "provider_config_exists",
        message: `provider config "${payload.id}" already exists (PUT/PATCH to edit)`,
      });
    }
    if (payload.models !== undefined) {
      assertModelFamilyPairing(payload.models, payload.api ?? null);
    }
    const credential = credentialOf(payload.apiKey);
    refuseKeyWithoutMasterKey(ctx.env, credential);
    await insertProviderConfig(ctx.env, payload.id, writeFieldsOf(payload), credential);
    // Hot-apply broadcast (#382): the merged directory feeds execution
    // options and the projection, so every write dirties the host's system
    // faces exactly like a settings write (system.ts:348 precedent).
    await hub(ctx.env).notifySystem(["config-changed"]);
    return ctx.json(await rowAfterWrite(ctx.env, payload.id), 201);
  });

  routes.put("/system/providers/:id", async (ctx) => {
    const id = requireValidId(ctx.req.param("id"));
    const payload = await requireJsonBody(ctx, providerConfigReplaceRequestSchema);
    const current = await getProviderConfigMutationContext(ctx.env, id);
    if (current === null) {
      throw new ApiError({
        status: 404,
        code: "provider_config_not_found",
        message: `provider config "${id}" not found (POST /system/providers to create)`,
      });
    }
    if (payload.models !== undefined) {
      assertModelFamilyPairing(payload.models, payload.api ?? null);
    }
    const credential = credentialOf(payload.apiKey);
    refuseKeyWithoutMasterKey(ctx.env, credential);
    // PUT writes the visible face wholesale (writeFieldsOf): an absent
    // baseUrl IS the next value (null), so the gate compares that target.
    refuseCredentialReplayAcrossBaseUrl(current, payload.baseUrl ?? null, credential);
    await replaceProviderConfig(ctx.env, id, writeFieldsOf(payload), credential);
    await hub(ctx.env).notifySystem(["config-changed"]);
    return ctx.json(await rowAfterWrite(ctx.env, id));
  });

  routes.patch("/system/providers/:id", async (ctx) => {
    const id = requireValidId(ctx.req.param("id"));
    const payload = await requireJsonBody(ctx, providerConfigPatchRequestSchema);
    const current = await getProviderConfigMutationContext(ctx.env, id);
    if (current === null) {
      throw new ApiError({
        status: 404,
        code: "provider_config_not_found",
        message: `provider config "${id}" not found`,
      });
    }
    const apiMoving = payload.api !== undefined && (payload.api ?? null) !== current.api;
    if (payload.models !== undefined || apiMoving) {
      // PATCH resolves the family from the payload's api seat when it moves,
      // else from the stored row (a models-only PATCH keeps the row family).
      // A family flip validates the EFFECTIVE model set — the payload's rows
      // when present, else the stored ones — so image ids cannot be stranded
      // on a freshly chat-ified row (or chat seats on a new image row).
      const effectiveModels =
        payload.models ?? (await getProviderConfigTarget(ctx.env, id))?.models ?? [];
      assertModelFamilyPairing(
        effectiveModels,
        payload.api !== undefined ? payload.api : current.api,
      );
    }
    const credential = credentialOf(payload.apiKey);
    refuseKeyWithoutMasterKey(ctx.env, credential);
    // Omitted baseUrl means "not moving" (PATCH semantics): the gate only
    // fires when the payload re-anchors the row somewhere else.
    refuseCredentialReplayAcrossBaseUrl(
      current,
      payload.baseUrl !== undefined ? (payload.baseUrl ?? null) : current.baseUrl,
      credential,
    );
    await patchProviderConfig(
      ctx.env,
      id,
      {
        ...(payload.displayName !== undefined ? { displayName: payload.displayName } : {}),
        ...(payload.baseUrl !== undefined ? { baseUrl: payload.baseUrl } : {}),
        ...(payload.api !== undefined ? { api: payload.api } : {}),
        ...(payload.serviceTier !== undefined ? { serviceTier: payload.serviceTier } : {}),
        ...(payload.models !== undefined ? { models: payload.models } : {}),
      },
      credential,
    );
    await hub(ctx.env).notifySystem(["config-changed"]);
    return ctx.json(await rowAfterWrite(ctx.env, id));
  });

  routes.delete("/system/providers/:id", async (ctx) => {
    const id = requireValidId(ctx.req.param("id"));
    if ((await getProviderConfigTarget(ctx.env, id)) === null) {
      throw new ApiError({
        status: 404,
        code: "provider_config_not_found",
        message: `provider config "${id}" not found`,
      });
    }
    await deleteProviderConfig(ctx.env, id);
    await hub(ctx.env).notifySystem(["config-changed"]);
    return ctx.json({ ok: true });
  });

  routes.post("/system/providers/:id/test", async (ctx) => {
    assertProbeSlotAvailable(ctx);
    const id = requireValidId(ctx.req.param("id"));
    const target = await getProviderConfigTarget(ctx.env, id);
    if (target === null) {
      throw new ApiError({
        status: 404,
        code: "provider_config_not_found",
        message: `provider config "${id}" not found`,
      });
    }
    if (target.baseUrl === null || target.baseUrl === "") {
      return ctx.json(
        providerConfigTestResponseSchema.parse({
          ok: false,
          status: null,
          latencyMs: null,
          error: "row declares no baseUrl — set one before testing",
        }),
      );
    }
    const modelEntry = target.models.find(
      (entry): entry is { id: string } =>
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        typeof entry.id === "string",
    );
    if (modelEntry === undefined) {
      return ctx.json(
        providerConfigTestResponseSchema.parse({
          ok: false,
          status: null,
          latencyMs: null,
          error: "row declares no usable model id — add a model before testing",
        }),
      );
    }
    // A missing/undecryptable key probes WITHOUT credentials: the upstream
    // verdict (e.g. 401) is the honest answer, and the panel shows it as-is.
    const verdict = await probeProviderConnection({
      api: target.api,
      baseUrl: target.baseUrl,
      model: modelEntry.id,
      apiKey: await readProviderConfigSecret(ctx.env, id),
    });
    return ctx.json(providerConfigTestResponseSchema.parse(verdict));
  });

  // PM addition ① (#362): /models discovery. Anchored either on an unsaved
  // row ({baseUrl, apiKey?}) or a saved one ({providerId} — the row's
  // baseUrl plus its DECRYPTED stored secret, which the panel never sees).
  // #447: the probe delegates to a connected host (host.discover_models) for
  // pi-catalog enrichment; `hostId` pins the server, otherwise registered
  // persistent hosts serve in creation order, and the edge's bare probe is
  // the explicit degradation fallback (rows marked metadata-unavailable).
  routes.post("/system/providers/discover-models", async (ctx) => {
    assertProbeSlotAvailable(ctx);
    const payload = await requireJsonBody(ctx, providerConfigDiscoverRequestSchema);
    const verdict =
      "providerId" in payload
        ? await discoverForSavedRow(
            ctx,
            requireValidId(payload.providerId),
            payload.apiKey,
            payload.hostId,
          )
        : await discoverProviderModelsEnriched(ctx.env, {
            baseUrl: payload.baseUrl,
            apiKey: payload.apiKey ?? null,
            api: payload.api ?? null,
            hostId: payload.hostId,
          });
    return ctx.json(providerConfigDiscoverResponseSchema.parse(verdict));
  });

  // #364 the omp models.yml import: parse + map (@cap/provider-app), then
  // every candidate rides the SAME gates and insert/encryption path as the
  // manual CRUD face. Refusals are per-provider HTTP-grade verdicts (the
  // batch keeps applying the rest); one config-changed broadcast covers the
  // whole batch when at least one row landed.
  routes.post("/system/providers/import-models-yml", async (ctx) => {
    const payload = await requireJsonBody(ctx, providerConfigImportRequestSchema);
    let parsed: ModelsYmlImportParse;
    try {
      parsed = parseModelsYml(payload.yaml);
    } catch (error) {
      if (error instanceof ModelsYmlImportError) {
        throw new ApiError({ status: 422, code: error.code, message: error.message });
      }
      throw error;
    }
    const entries: ProviderConfigImportEntry[] = parsed.skips.map((skip) => ({
      id: skip.id,
      verdict: "skipped",
      status: skip.status,
      code: skip.code,
      message: skip.message,
      modelCount: 0,
      hasApiKey: false,
      warnings: [],
    }));
    for (const candidate of parsed.providers) {
      const entryBase = {
        id: candidate.id,
        modelCount: candidate.models.length,
        hasApiKey: candidate.apiKey !== null,
        warnings: candidate.warnings,
      };
      if (candidate.id === SYNTHETIC_RELAY_PROVIDER_ID) {
        entries.push({
          ...entryBase,
          verdict: "skipped",
          status: 409,
          code: "reserved_id",
          message: `"${SYNTHETIC_RELAY_PROVIDER_ID}" is reserved (sentinel-era journals reference it) and cannot be configured`,
        });
        continue;
      }
      if ((await getProviderConfigTarget(ctx.env, candidate.id)) !== null) {
        entries.push({
          ...entryBase,
          verdict: "skipped",
          status: 409,
          code: "already_exists",
          message: `provider "${candidate.id}" already exists — edit or remove the row first`,
        });
        continue;
      }
      // SEC-W5-003: import candidates ride the SAME baseUrl rule as the CRUD
      // faces — an http/intranet target must not become a probe seam.
      if (candidate.baseUrl !== null && !isPublicHttpsBaseUrl(candidate.baseUrl)) {
        entries.push({
          ...entryBase,
          verdict: "skipped",
          status: 422,
          code: "invalid_base_url",
          message: `provider "${candidate.id}": baseUrl must be an https URL naming a public domain — row skipped`,
        });
        continue;
      }
      const credential = credentialOf(candidate.apiKey);
      if (
        credential.kind === "set" &&
        (ctx.env.PROVIDER_CONFIG_MASTER_KEY === undefined ||
          ctx.env.PROVIDER_CONFIG_MASTER_KEY === "")
      ) {
        entries.push({
          ...entryBase,
          verdict: "skipped",
          status: 422,
          code: "master_key_missing",
          message:
            "PROVIDER_CONFIG_MASTER_KEY is not configured — refusing to store a plaintext API key " +
            "(set the Worker secret first, then re-import; rows without keys still work in mock mode)",
        });
        continue;
      }
      // #485: the SAME family pairing the manual CRUD faces enforce — the
      // parser already refuses image ids in chat providers, so this is the
      // backstop that keeps one row-creating path from drifting.
      try {
        assertModelFamilyPairing(candidate.models, candidate.api);
      } catch (error) {
        entries.push({
          ...entryBase,
          verdict: "skipped",
          status: 422,
          code: "family_mismatch",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      await insertProviderConfig(
        ctx.env,
        candidate.id,
        {
          displayName: null,
          baseUrl: candidate.baseUrl,
          api: candidate.api,
          serviceTier: false,
          models: candidate.models,
        },
        credential,
      );
      entries.push({
        ...entryBase,
        verdict: "created",
        status: 201,
        code: "created",
        message: `provider "${candidate.id}" created with ${String(candidate.models.length)} model rows`,
      });
    }
    if (entries.some((entry) => entry.verdict === "created")) {
      await hub(ctx.env).notifySystem(["config-changed"]);
    }
    const created = entries.filter((entry) => entry.verdict === "created").length;
    return ctx.json(
      providerConfigImportResponseSchema.parse({
        providers: entries,
        created,
        skipped: entries.length - created,
      }),
    );
  });
}

/** The {providerId}-anchored discovery branch: resolves the row's baseUrl
 * and its stored secret (unless the panel re-typed a key for this probe).
 * The row's declared api family rides along as the auth-header/enrichment
 * hint. */
async function discoverForSavedRow(
  ctx: Context<AppEnv>,
  id: string,
  typedKey: string | undefined,
  hostId: string | undefined,
) {
  const target = await getProviderConfigTarget(ctx.env, id);
  if (target === null) {
    throw new ApiError({
      status: 404,
      code: "provider_config_not_found",
      message: `provider config "${id}" not found`,
    });
  }
  if (target.baseUrl === null || target.baseUrl === "") {
    return providerConfigDiscoverResponseSchema.parse({
      ok: false,
      status: null,
      latencyMs: null,
      error: "row declares no baseUrl — set one before discovering",
      models: [],
      warnings: [],
    });
  }
  // An explicitly typed key (panel re-entry) wins for this one probe;
  // otherwise the row's decrypted stored secret rides — never echoed back.
  const apiKey = typedKey ?? (await readProviderConfigSecret(ctx.env, id));
  return discoverProviderModelsEnriched(ctx.env, {
    baseUrl: target.baseUrl,
    apiKey,
    api: target.api,
    hostId,
  });
}
