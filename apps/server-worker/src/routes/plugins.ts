import { Hono } from "hono";
import {
  pluginContributionsResponseSchema,
  pluginListResponseSchema,
} from "../contract/api/plugins.js";
import type { HonoBindings } from "../app-types.js";
import {
  loadStaticRegistryAsset,
  loadStaticRegistryEntry,
} from "../services/plugin-registry.js";

/**
 * Plugins metadata + asset face (#382), bb apps/server/src/routes/plugins.ts
 * anchors reduced to the static registry: GET /plugins serves the registry
 * entry (pre-#382 this pinned bb's experiment-off empty state — an
 * untracked/unstaged plugin is still exactly that), GET /plugins/contributions
 * keeps the empty fast-metadata shape (plugins.ts:196-206), and
 * GET /plugins/:id/assets/:file serves the built frontend bundle with bb's
 * hash-busting cache policy (plugins.ts:297-347): ?h=<current hash> →
 * immutable, anything else → no-store.
 */
export function registerPluginRoutes(app: Hono<{ Bindings: HonoBindings }>): void {
  const routes = new Hono<{ Bindings: HonoBindings }>();

  routes.get("/plugins", async (ctx) => {
    const entry = await loadStaticRegistryEntry(ctx.env);
    return ctx.json(
      pluginListResponseSchema.parse({ plugins: entry === null ? [] : [entry] }),
    );
  });

  // Fast metadata for the CLI help/proxy path and host-rendered UI
  // contributions: no plugin code runs. The static registry contributes no
  // CLI commands or mention providers (bb plugins.ts:198-200 comment).
  routes.get("/plugins/contributions", (ctx) => {
    return ctx.json(
      pluginContributionsResponseSchema.parse({ cliCommands: [], mentionProviders: [] }),
    );
  });

  routes.get("/plugins/:id/assets/:file", async (ctx) => {
    const asset = await loadStaticRegistryAsset(
      ctx.env,
      ctx.req.param("id"),
      ctx.req.param("file"),
    );
    if (asset === null) {
      return ctx.json({ ok: false, error: "unknown plugin asset" }, 404);
    }
    return ctx.newResponse(asset.assetResponse.body, 200, {
      "content-type": asset.contentType,
      // bb plugins.ts:309-312 policy: matching hash is immutable; a stale or
      // absent ?h is no-store so a stale URL can never pin a stale bundle.
      "cache-control":
        ctx.req.query("h") === asset.hash
          ? "public, max-age=31536000, immutable"
          : "no-store",
    });
  });

  app.route("/api/v1", routes);
}
