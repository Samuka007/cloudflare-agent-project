import { Hono } from "hono";
import { ApiError } from "../shared/api-error.js";
import { environmentSchema } from "../contract/domain/environment.js";
import { getEnvironmentRow, listEnvironmentRows } from "../db/environments.js";
import type { AppEnv } from "../app-types.js";

/**
 * #288 environments minimal set (inventory §2.A2 read face): project-scoped
 * list + bb's `GET /environments/:id` (public-api.ts:768-776). Shapes are the
 * domain Environment row — the provisioning/status sub-resources (bb's other
 * 10 routes) stay deferred until their daemon faces exist.
 *
 * #445 data-hygiene ruling: the list face carries only rows whose host is
 * still live (the bindable-workspace inventory); the id face answers any
 * stored row (existing thread bindings stay readable, honestly, even after
 * the host tombstones — tools then answer host_offline, #436 posture).
 */
export function registerEnvironmentRoutes(app: Hono<AppEnv>): void {
  const routes = new Hono<AppEnv>();

  routes.get("/environments", async (ctx) => {
    const projectId = ctx.req.query("projectId");
    if (projectId?.length === 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "projectId must not be empty",
      });
    }
    const rows = await listEnvironmentRows(ctx.env, projectId ? { projectId } : {});
    return ctx.json(rows.map((row) => environmentSchema.parse(row)));
  });

  routes.get("/environments/:id", async (ctx) => {
    const row = await getEnvironmentRow(ctx.env, ctx.req.param("id"));
    if (row === null) {
      throw new ApiError({
        status: 404,
        code: "environment_not_found",
        message: "Environment not found",
      });
    }
    return ctx.json(environmentSchema.parse(row));
  });

  app.route("/api/v1", routes);
}
