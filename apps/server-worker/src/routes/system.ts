import { Hono } from "hono";
import { z } from "zod";
import {
  BROWSER_BACKED_ENGINES,
  DEFAULT_WEB_SEARCH_CONFIG,
  decodeWebSearchConfig,
  envFlag,
  projectWebSearchConfig,
} from "@cap/agent-do";
import type { WebSearchEngineProjection } from "@cap/agent-do";
import { projectHarness, resolveHarness, type HarnessEnv } from "@cap/provider-app";
import {
  systemProviderProjectionsResponseSchema,
  systemConfigResponseSchema,
  systemExecutionOptionsQuerySchema,
  systemExecutionOptionsResponseSchema,
  systemVersionResponseSchema,
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
 * to probe, so M0 serves the static staging truth instead: one provider "omp"
 * whose only model is the relay model turns actually run
 * (MODEL_RELAY_MODEL, the same var packages/agent-do/src/worker.ts:41 reads).
 * The response shape is bb-verbatim (server-contract/src/api/system.ts:35-58)
 * so the SPA picker consumes it unmodified (shape fixture:
 * apps/app/src/hooks/useThreadCreationOptions.test.tsx:44-114).
 */
export function buildExecutionOptions(
  env: Pick<Env, "MODEL_RELAY_MODEL" | "MODEL_RELAY_IMAGE_INPUT">,
) {
  const model = env.MODEL_RELAY_MODEL ?? "glm-5.3-anth";
  // A4 (#319): the projected capability is the SAME deployment declaration
  // the provider-app harness reads (same 1/true/on convention, one owner:
  // @cap/agent-do config.envFlag) — both faces of the relay verdict.
  const supportsImageInput = envFlag(env.MODEL_RELAY_IMAGE_INPUT);
  return {
    providers: [
      {
        id: "omp",
        displayName: "omp",
        logoUrl: null,
        capabilities: {
          supportsArchive: false,
          supportsRename: false,
          supportsServiceTier: false,
          supportsUserQuestion: false,
          supportsFork: false,
          supportsImageInput,
          // min(1) required (domain/provider-types.ts:72); the harness turns
          // run at the "full" default (env.ts HARNESS_PERMISSION_MODE).
          supportedPermissionModes: ["full"],
        },
        composerActions: [],
        available: true,
      },
    ],
    // "full" is bb's value when the machine is uncapped or none routed
    // (server-contract/src/api/system.ts:37-41) — the Worker has no machine
    // permission cap.
    permissionCeiling: "full",
    models: [
      {
        id: model,
        model,
        displayName: model,
        description: "",
        // The glm relay runs thinking { type: "disabled" }
        // (packages/agent-do/src/worker.ts:43); "none" is bb's level for no
        // extended thinking (domain/shared-types.ts:13-20), so the picker
        // offers exactly that.
        supportedReasoningEfforts: [{ reasoningEffort: "none", description: "" }],
        defaultReasoningEffort: "none",
        isDefault: true,
      },
    ],
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
export function buildProviderProjections(env: Pick<Env, "AGENT_DO_WEB_SEARCH"> & HarnessEnv) {
  const harness = projectHarness(resolveHarness(env));
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
  return { harness: { ...harness, relayBaseUrlHost }, webSearch };
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

  routes.get("/system/execution-options", (ctx) => {
    // bb validates the query against systemExecutionOptionsQuerySchema
    // (public-api.ts:1408-1409); hostId and environmentId are mutually
    // exclusive. The Worker has no host routing, so the parsed value is
    // discarded and the primary catalog is served regardless.
    parseOr422(systemExecutionOptionsQuerySchema, ctx.req.query());
    return ctx.json(systemExecutionOptionsResponseSchema.parse(buildExecutionOptions(ctx.env)));
  });

  // Read-only projection face (#266): no PUT exists anywhere on this path —
  // provider edits ride the deployment env (control-plane-layer §3.2), and
  // POST /system/config/reload is a deliberate no-op for the same reason.
  routes.get("/system/provider-projections", (ctx) => {
    return ctx.json(
      systemProviderProjectionsResponseSchema.parse(buildProviderProjections(ctx.env)),
    );
  });

  app.route("/api/v1", routes);
}

function hub(env: Env) {
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  return stub as DurableObjectStub & {
    notifySystem(changes: string[]): Promise<{ delivered: number }>;
  };
}
