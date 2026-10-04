import { Hono } from "hono";
import { z } from "zod";
import { systemConfigResponseSchema } from "../contract/api/system.js";
import { systemVersionResponseSchema } from "../contract/api/system.js";
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
 * POST /system/config/reload, GET /system/version. Theme catalog faces are
 * reduced to the built-in catalog (no fs themeRoot, no plugin themes).
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

  app.route("/api/v1", routes);
}

function hub(env: Env) {
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  return stub as DurableObjectStub & {
    notifySystem(changes: string[]): Promise<{ delivered: number }>;
  };
}
