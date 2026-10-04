import { Hono } from "hono";
import {
  updateHostPermissionCeilingRequestSchema,
  updateHostRequestSchema,
} from "../contract/api/hosts.js";
import { hostSchema } from "../contract/domain/host.js";
import { ApiError } from "../shared/api-error.js";
import { requireJsonBody } from "../shared/route-utils.js";
import { getHostRow, listNonDestroyedHostRows, updateHostRow } from "../db/hosts.js";
import type { Env, HonoBindings } from "../app-types.js";

/**
 * Minimal hosts face (ruling #7 "hosts 最小"): fleet list/get/rename/ceiling/
 * delete. Status is "disconnected" for every host — bb derives it from open
 * daemon sessions (entity-lookup.ts toHostStatus) and no daemon lane exists
 * in M0. Rows land via the daemon attach bridge (#49): the daemon face calls
 * upsertAttachedHost on enroll/session-open; enrollment itself is the daemon
 * service's /enroll, not served here.
 */
export function registerHostRoutes(app: Hono<{ Bindings: HonoBindings }>): void {
  const routes = new Hono<{ Bindings: HonoBindings }>();

  routes.get("/hosts", async (ctx) => {
    const rows = await listNonDestroyedHostRows(ctx.env);
    return ctx.json(
      rows.map((row) =>
        hostSchema.parse({
          id: row.id,
          name: row.name,
          type: row.type,
          status: "disconnected",
          maxPermissionMode: row.maxPermissionMode,
          lastSeenAt: row.lastSeenAt,
          lastRejectedProtocolVersion: row.lastRejectedProtocolVersion,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }),
      ),
    );
  });

  routes.get("/hosts/:id", async (ctx) => {
    const row = await requireHost(ctx.env, ctx.req.param("id"));
    return ctx.json(
      hostSchema.parse({
        id: row.id,
        name: row.name,
        type: row.type,
        status: "disconnected",
        maxPermissionMode: row.maxPermissionMode,
        lastSeenAt: row.lastSeenAt,
        lastRejectedProtocolVersion: row.lastRejectedProtocolVersion,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    );
  });

  routes.patch("/hosts/:id", async (ctx) => {
    const payload = await requireJsonBody(ctx, updateHostRequestSchema);
    await requireHost(ctx.env, ctx.req.param("id"));
    const updated = await updateHostRow(ctx.env, ctx.req.param("id"), {
      name: payload.name,
    });
    if (!updated) {
      throw new ApiError({ status: 404, code: "host_not_found", message: "Host not found" });
    }
    return ctx.json(
      hostSchema.parse({
        id: updated.id,
        name: updated.name,
        type: updated.type,
        status: "disconnected",
        maxPermissionMode: updated.maxPermissionMode,
        lastSeenAt: updated.lastSeenAt,
        lastRejectedProtocolVersion: updated.lastRejectedProtocolVersion,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      }),
    );
  });

  routes.patch("/hosts/:id/permission-ceiling", async (ctx) => {
    const payload = await requireJsonBody(ctx, updateHostPermissionCeilingRequestSchema);
    await requireHost(ctx.env, ctx.req.param("id"));
    const updated = await updateHostRow(ctx.env, ctx.req.param("id"), {
      maxPermissionMode: payload.maxPermissionMode,
    });
    if (!updated) {
      throw new ApiError({ status: 404, code: "host_not_found", message: "Host not found" });
    }
    return ctx.json(
      hostSchema.parse({
        id: updated.id,
        name: updated.name,
        type: updated.type,
        status: "disconnected",
        maxPermissionMode: updated.maxPermissionMode,
        lastSeenAt: updated.lastSeenAt,
        lastRejectedProtocolVersion: updated.lastRejectedProtocolVersion,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      }),
    );
  });

  routes.delete("/hosts/:id", async (ctx) => {
    await requireHost(ctx.env, ctx.req.param("id"));
    // bb delete marks destroyedAt (soft destroy), it does not hard-delete.
    await updateHostRow(ctx.env, ctx.req.param("id"), { destroyedAt: Date.now() });
    return ctx.json({ ok: true });
  });

  app.route("/api/v1", routes);
}

async function requireHost(env: Env, hostId: string) {
  const row = await getHostRow(env, hostId);
  if (row?.destroyedAt !== null) {
    throw new ApiError({ status: 404, code: "host_not_found", message: "Host not found" });
  }
  return row;
}
