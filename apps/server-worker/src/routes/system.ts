import { Hono } from "hono";
import { z } from "zod";
import {
  BROWSER_BACKED_ENGINES,
  DEFAULT_WEB_SEARCH_CONFIG,
  decodeWebSearchConfig,
  projectWebSearchConfig,
  SYNTHETIC_RELAY_PROVIDER_ID,
  type RelayCatalogProvider,
} from "@cap/agent-do";
import type { WebSearchEngineProjection } from "@cap/agent-do";
import {
  isValidProviderConfigId,
  loadProviderConfigCatalogOverlay,
  loadProviderConfigOverlay,
  projectHarness,
  resolveRelayCatalog,
  resolveRelayCatalogWithOverlay,
  type HarnessEnv,
} from "@cap/provider-app";
import {
  systemProviderProjectionsResponseSchema,
  systemConfigResponseSchema,
  systemExecutionOptionsQuerySchema,
  systemExecutionOptionsResponseSchema,
  systemVersionResponseSchema,
  providerConfigCreateRequestSchema,
  providerConfigIdSchema,
  providerConfigPatchRequestSchema,
  providerConfigReplaceRequestSchema,
  providerConfigRowSchema,
  providerConfigTestResponseSchema,
  providerConfigsListResponseSchema,
  type ProviderConfigRow,
  type SystemExecutionOptionsResponse,
} from "../contract/api/system.js";
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
  getProviderConfigTarget,
  insertProviderConfig,
  patchProviderConfig,
  readProviderConfigSecret,
  replaceProviderConfig,
  type CredentialUpdate,
  type ProviderConfigWriteFields,
} from "../db/provider-configs.js";
import { probeProviderConnection } from "../services/provider-config-test.js";
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
import type { Env, HonoBindings } from "../app-types.js";

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
    primaryHostId: null as string | null,
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
 * to probe, so the catalog is a deployment declaration instead (#350):
 * MODEL_RELAY_CATALOG (public, zero-secret JSON —
 * packages/agent-do/src/provider-catalog.ts) projected through ONE
 * resolution shared with the harness (provider-app resolveRelayCatalog —
 * the #319 dual-face pattern generalized to the catalog layer, roadmap
 * §0.1/§2.3). No declaration → the M0 synthesis: one provider "omp" whose
 * only model is the relay model turns actually run. The response shape is
 * bb-verbatim (server-contract/src/api/system.ts:35-58) so the SPA picker
 * consumes it unmodified (shape fixture:
 * apps/app/src/hooks/useThreadCreationOptions.test.tsx:44-114); the typed
 * return is the compile-time parity guard pinning the catalog ladder
 * vocabulary to bb's ReasoningLevel enum (shared-types.ts:18-27).
 */
export function buildExecutionOptions(
  env: HarnessEnv,
  overlayProviders?: Record<string, RelayCatalogProvider>,
): SystemExecutionOptionsResponse {
  const catalog =
    overlayProviders === undefined
      ? resolveRelayCatalog(env)
      : resolveRelayCatalogWithOverlay(env, overlayProviders);
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
    selectedOnlyModels: [],
    modelLoadError: null,
  };
}

/**
 * GET /system/provider-projections (#266, #255 solution C): aggregate the
 * read-only provider status face. Harness row = projectHarness over
 * resolveHarness (the same total resolution thread turns run) plus the relay
 * host; web_search row = projectWebSearchConfig over decodeWebSearchConfig —
 * chain order, credential-gate booleans, browser-backed exclusions. Zero
 * secret values leave the env: key/token contents never enter the response,
 * and decode failures drop the error text (it can quote raw env content).
 * Daemon-side provider pins (judge/security) are NOT visible here — they live
 * in daemon env, a different trust domain (#255 §6.2, ticket #56).
 */
export function buildProviderProjections(
  env: Pick<Env, "AGENT_DO_WEB_SEARCH"> & HarnessEnv,
  overlayProviders?: Record<string, RelayCatalogProvider>,
) {
  // One resolution for both rows: the harness projection and the catalog
  // status project the same evaluation (same-source, #350).
  const resolution =
    overlayProviders === undefined
      ? resolveRelayCatalog(env)
      : resolveRelayCatalogWithOverlay(env, overlayProviders);
  const harness = projectHarness(resolution.harness);
  // Total over env content: a malformed relay URL degrades to a null host
  // instead of failing the whole read-only face.
  let relayBaseUrlHost: string | null = null;
  try {
    relayBaseUrlHost = new URL(harness.relayBaseUrl).host;
  } catch {
    // env content, not a caller error
  }
  const rawWebSearch = env.AGENT_DO_WEB_SEARCH;
  let webSearch: {
    configured: boolean;
    decodeError: boolean;
    chain: WebSearchEngineProjection[];
    timeoutSeconds: number | null;
    browserBackedEngines: string[];
  };
  if (rawWebSearch === undefined || rawWebSearch === "") {
    webSearch = {
      configured: false,
      decodeError: false,
      ...projectWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG),
    };
  } else {
    try {
      webSearch = {
        configured: true,
        decodeError: false,
        ...projectWebSearchConfig(decodeWebSearchConfig(rawWebSearch)),
      };
    } catch {
      webSearch = {
        configured: true,
        decodeError: true,
        chain: [],
        timeoutSeconds: null,
        browserBackedEngines: [...BROWSER_BACKED_ENGINES],
      };
    }
  }
  return {
    harness: { ...harness, relayBaseUrlHost },
    webSearch,
    // Catalog declaration status (#350): ids and decode state only — the
    // full declared values live on GET /system/execution-options. The
    // decodeError flag is the loud signal when the strict catalog decode
    // failed and the env-only synthesis is being served instead.
    catalog: {
      configured: resolution.configured,
      decodeError: resolution.decodeError,
      defaultProviderId: resolution.defaultProviderId,
      defaultModel: resolution.harness.relay.model,
      providers: resolution.providers.map((provider) => provider.id),
      models: resolution.models.map((model) => model.id),
    },
  };
}

export function registerSystemRoutes(app: Hono<{ Bindings: HonoBindings }>): void {
  const routes = new Hono<{ Bindings: HonoBindings }>();

  routes.get("/system/config", async (ctx) => {
    const url = new URL(ctx.req.url);
    const settingsRow = await getAppSettingsRow(ctx.env);
    const overrides = await getKeybindingOverrides(ctx.env);
    const experiments = await getExperiments(ctx.env);
    const stored = await getStoredAppearance(ctx.env);
    const draft = buildSystemConfig(ctx.env, url);
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
      featureFlags: draft.featureFlags,
      hostDaemonPort: draft.hostDaemonPort,
      serverUrl: draft.serverUrl,
      primaryHostId: draft.primaryHostId,
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
    // exclusive. The Worker has no host routing, so the parsed value is
    // discarded and the primary catalog is served regardless.
    parseOr422(systemExecutionOptionsQuerySchema, ctx.req.query());
    // #362: the D1 provider overlay rides over the env seed — a panel-side
    // provider appears here on the next request (no redeploy, no reload).
    const overlay = await loadProviderConfigCatalogOverlay(ctx.env);
    return ctx.json(
      systemExecutionOptionsResponseSchema.parse(buildExecutionOptions(ctx.env, overlay?.providers)),
    );
  });

  // Read-only projection face (#266). Since #362 the user-face write path is
  // /system/providers (the D1 正本); this face still has no PUT anywhere —
  // the env-declared deployment seed stays redeploy-only (control-plane-layer
  // §3.2), and POST /system/config/reload remains a deliberate no-op for it.
  routes.get("/system/provider-projections", async (ctx) => {
    const overlay = await loadProviderConfigCatalogOverlay(ctx.env);
    return ctx.json(
      systemProviderProjectionsResponseSchema.parse(
        buildProviderProjections(ctx.env, overlay?.providers),
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
function registerProviderConfigRoutes(routes: Hono<{ Bindings: HonoBindings }>): void {
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

  const writeFieldsOf = (
    payload: {
      displayName?: string;
      baseUrl?: string;
      api?: string;
      serviceTier?: boolean;
      models?: unknown[];
    },
  ): ProviderConfigWriteFields => ({
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

  routes.get("/system/providers", async (ctx) => {
    const load = await loadProviderConfigOverlay(ctx.env);
    return ctx.json(providerConfigsListResponseSchema.parse({ providers: load?.rows ?? [] }));
  });

  routes.get("/system/providers/:id", async (ctx) => {
    const id = requireValidId(ctx.req.param("id"));
    const load = await loadProviderConfigOverlay(ctx.env);
    const row = load?.rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      throw new ApiError({
        status: 404,
        code: "provider_config_not_found",
        message: `provider config "${id}" not found`,
      });
    }
    return ctx.json(providerConfigRowSchema.parse(row));
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
        message: `"${SYNTHETIC_RELAY_PROVIDER_ID}" is the deployment-default seam id and cannot be configured`,
      });
    }
    if ((await getProviderConfigTarget(ctx.env, payload.id)) !== null) {
      throw new ApiError({
        status: 409,
        code: "provider_config_exists",
        message: `provider config "${payload.id}" already exists (PUT/PATCH to edit)`,
      });
    }
    const credential = credentialOf(payload.apiKey);
    refuseKeyWithoutMasterKey(ctx.env, credential);
    await insertProviderConfig(ctx.env, payload.id, writeFieldsOf(payload), credential);
    return ctx.json(await rowAfterWrite(ctx.env, payload.id), 201);
  });

  routes.put("/system/providers/:id", async (ctx) => {
    const id = requireValidId(ctx.req.param("id"));
    const payload = await requireJsonBody(ctx, providerConfigReplaceRequestSchema);
    if ((await getProviderConfigTarget(ctx.env, id)) === null) {
      throw new ApiError({
        status: 404,
        code: "provider_config_not_found",
        message: `provider config "${id}" not found (POST /system/providers to create)`,
      });
    }
    const credential = credentialOf(payload.apiKey);
    refuseKeyWithoutMasterKey(ctx.env, credential);
    await replaceProviderConfig(ctx.env, id, writeFieldsOf(payload), credential);
    return ctx.json(await rowAfterWrite(ctx.env, id));
  });

  routes.patch("/system/providers/:id", async (ctx) => {
    const id = requireValidId(ctx.req.param("id"));
    const payload = await requireJsonBody(ctx, providerConfigPatchRequestSchema);
    if ((await getProviderConfigTarget(ctx.env, id)) === null) {
      throw new ApiError({
        status: 404,
        code: "provider_config_not_found",
        message: `provider config "${id}" not found`,
      });
    }
    const credential = credentialOf(payload.apiKey);
    refuseKeyWithoutMasterKey(ctx.env, credential);
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
    return ctx.json({ ok: true });
  });

  routes.post("/system/providers/:id/test", async (ctx) => {
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
}
