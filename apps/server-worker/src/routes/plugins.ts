import { Hono } from "hono";
import {
  pluginContributionsResponseSchema,
  pluginListResponseSchema,
} from "../contract/api/plugins.js";
import type { HonoBindings } from "../app-types.js";

/**
 * Plugins metadata face, bb apps/server/src/routes/plugins.ts:196-206
 * (commit 8473d8c33): the two unguarded reads the SPA composer fires at
 * startup. The port has no plugin system, so the bb experiment-off state —
 * "empty (not an error) while the experiment is off" (plugins.ts:198-200) —
 * is the only state.
 */
export function registerPluginRoutes(app: Hono<{ Bindings: HonoBindings }>): void {
  const routes = new Hono<{ Bindings: HonoBindings }>();

  routes.get("/plugins", (ctx) => {
    return ctx.json(pluginListResponseSchema.parse({ plugins: [] }));
  });

  routes.get("/plugins/contributions", (ctx) => {
    return ctx.json(
      pluginContributionsResponseSchema.parse({ cliCommands: [], mentionProviders: [] }),
    );
  });

  app.route("/api/v1", routes);
}
