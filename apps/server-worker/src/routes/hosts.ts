import { Hono } from "hono";
import type { DaemonServiceDO } from "@cap/daemon-service";
import {
  updateHostPermissionCeilingRequestSchema,
  updateHostRequestSchema,
} from "../contract/api/hosts.js";
import { hostSchema } from "../contract/domain/host.js";
import type { Host } from "../contract/domain/host.js";
import type { HostDbRow } from "../db/rows.js";
import { ApiError } from "../shared/api-error.js";
import { requireJsonBody } from "../shared/route-utils.js";
import { getHostRow, listNonDestroyedHostRows, updateHostRow } from "../db/hosts.js";
import type { Env, HonoBindings } from "../app-types.js";

/**
 * Hosts face (ruling #7 "hosts 最小"): fleet list/get/rename/ceiling/delete.
 * Status derives read-time from the live daemon session — bb's toHostStatus
 * (entity-lookup.ts:71-80) asks the hub for the host's registered daemon
 * session and answers "connected" only for an open one; the port asks the
 * per-host daemon-service DO (hostLiveness: current session + live socket).
 * Rows land via the daemon attach bridge (#49); daemon heartbeats keep
 * last_seen_at advancing through the DO's registry projection (#62).
 * Enrollment itself is the daemon service's /enroll, not served here.
 */
export function registerHostRoutes(app: Hono<{ Bindings: HonoBindings }>): void {
  const routes = new Hono<{ Bindings: HonoBindings }>();

  routes.get("/hosts", async (ctx) => {
    const rows = await listNonDestroyedHostRows(ctx.env);
    return ctx.json(await Promise.all(rows.map((row) => toHostRecord(ctx.env, row))));
  });

  routes.get("/hosts/:id", async (ctx) => {
    const row = await requireHost(ctx.env, ctx.req.param("id"));
    return ctx.json(await toHostRecord(ctx.env, row));
  });

  routes.get("/hosts/:id/provider-cli-status", async (ctx) => {
    // bb assertUsableHostId (routes/hosts.ts:288): unknown/destroyed host → 404.
    await requireHost(ctx.env, ctx.req.param("id"));
    // bb providerCliStatus RPCs provider_cli.status to the host daemon
    // (routes/hosts.ts:286-297); without a connected daemon the retryable RPC
    // surfaces 502 host_unavailable "Host is not connected" (services/hosts/
    // online-rpc.ts:162-163). The M0 control plane has no daemon-RPC
    // transport (providers face permanently cropped, matrix E8), so every
    // host is exactly that offline state. The SPA's own bb mechanism renders
    // the degraded "Status unavailable" row for the error
    // (MachineSettingsView.tsx:332-356) instead of a hard failure — the
    // #76 hide-via-bb-mechanism ruling.
    throw new ApiError({
      status: 502,
      code: "host_unavailable",
      message: "Host is not connected",
    });
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
    // bb routes/hosts.ts:144-145: host metadata shares the connection-change
    // invalidation path, so a rename rides host-connected.
    await hub(ctx.env).notifyHost(updated.id, ["host-connected"]);
    return ctx.json(await toHostRecord(ctx.env, updated));
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
    // bb routes/hosts.ts:161-162: same connection-change invalidation path
    // for the permission ceiling.
    await hub(ctx.env).notifyHost(updated.id, ["host-connected"]);
    return ctx.json(await toHostRecord(ctx.env, updated));
  });

  routes.delete("/hosts/:id", async (ctx) => {
    await requireHost(ctx.env, ctx.req.param("id"));
    // bb delete marks destroyedAt (soft destroy), it does not hard-delete.
    await updateHostRow(ctx.env, ctx.req.param("id"), { destroyedAt: Date.now() });
    // bb destroyHost broadcasts host-disconnected (data/hosts.ts:229-230).
    // The daemon-session shutdown terminal (closeSession + key revocation)
    // is S4's scope and stays out here.
    await hub(ctx.env).notifyHost(ctx.req.param("id"), ["host-disconnected"]);
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

/**
 * bb toHostRecord reads the status out of the live session before shaping
 * the response (entity-lookup.ts:82-94); same here, one DO round trip per
 * host. Every non-connected answer — no DAEMON_SERVICE binding in this
 * deployment, a failed or cold RPC, no current session — degrades to
 * "disconnected", exactly bb's reading for an unregistered host.
 */
async function toHostRecord(env: Env, row: HostDbRow): Promise<Host> {
  return hostSchema.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    status: (await daemonConnected(env, row.id)) ? "connected" : "disconnected",
    maxPermissionMode: row.maxPermissionMode,
    lastSeenAt: row.lastSeenAt,
    lastRejectedProtocolVersion: row.lastRejectedProtocolVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

async function daemonConnected(env: Env, hostId: string): Promise<boolean> {
  const namespace = env.DAEMON_SERVICE;
  if (namespace === undefined) return false;
  const stub = namespace.get(namespace.idFromName(hostId)) as DurableObjectStub & DaemonServiceDO;
  try {
    return (await stub.hostLiveness({ hostId })).connected;
  } catch {
    return false;
  }
}

/** Realtime hub fan-out (threads.ts hub idiom): host changed frames. */
function hub(env: Env) {
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  return stub as DurableObjectStub & {
    notifyHost(hostId: string, changes: string[]): Promise<{ delivered: number }>;
  };
}
