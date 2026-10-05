import { Hono } from "hono";
import {
  DAEMON_PROTOCOL_VERSION,
  mintJoinCode,
  type DaemonServiceDO,
} from "@cap/daemon-service";
import {
  createHostJoinCodeRequestSchema,
  updateHostPermissionCeilingRequestSchema,
  updateHostRequestSchema,
} from "../contract/api/hosts.js";
import { createHostId } from "../shared/ids.js";
import { hostSchema } from "../contract/domain/host.js";
import type { Host } from "../contract/domain/host.js";
import type { HostDbRow } from "../db/rows.js";
import { ApiError } from "../shared/api-error.js";
import { parseOr422, requireJsonBody } from "../shared/route-utils.js";
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

  // bb routes/hosts.ts:111-124: the add-a-machine mint — owner-gated like the
  // rest of the public API ("this route intentionally does not require
  // loopback access"), answers 201 {joinCode, hostId, expiresAt}. The code is
  // a one-time 15-minute enrollment credential (#258's non-key layer; the M1
  // per-host key registry stays cropped, #195 S7). Minting names a hostId but
  // creates no host row — bb issuePersistentHostEnrollKey: "a mint must not
  // leave phantom 'pending' machines behind" (host-enrollment.ts:12-17); the
  // row is born at enroll time through the daemon attach bridge, which is
  // exactly the moment the dialog's live flip looks for (S1 broadcast).
  routes.post("/hosts/join-codes", async (ctx) => {
    parseOr422(createHostJoinCodeRequestSchema, await ctx.req.json().catch(() => null));
    if (ctx.env.DAEMON_EDGE_KV === undefined) {
      // Fail closed: a mint whose record never lands would hand the user a
      // code that 401s at enroll. Only env-key-only deployments lack the KV.
      throw new ApiError({
        status: 503,
        code: "join_codes_unavailable",
        message: "Join codes need the edge KV binding, which this deployment lacks",
      });
    }
    const issued = await mintJoinCode(ctx.env.DAEMON_EDGE_KV, createHostId());
    return ctx.json(
      { joinCode: issued.code, hostId: issued.hostId, expiresAt: issued.expiresAt },
      201,
    );
  });

  routes.get("/hosts", async (ctx) => {
    const rows = await listNonDestroyedHostRows(ctx.env);
    return ctx.json(await Promise.all(rows.map((row) => toHostRecord(ctx.env, row))));
  });

  routes.get("/hosts/:id", async (ctx) => {
    const row = await requireHost(ctx.env, ctx.req.param("id"));
    return ctx.json(await toHostRecord(ctx.env, row));
  });

  // bb contract path (public-api.ts:679); the SPA fork is pinned, so the
  // server conforms to the bb route shape (#195 S5, was /provider-cli-status).
  routes.get("/hosts/:id/provider-clis/status", async (ctx) => {
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
    await requireMutableHost(ctx.env, ctx.req.param("id"));
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
    await requireMutableHost(ctx.env, ctx.req.param("id"));
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

  // bb routes/hosts.ts:166-186: retry-update is armed only for a daemon that
  // is waiting on a protocol update — two 409 gates, then the hub flag.
  routes.post("/hosts/:id/retry-update", async (ctx) => {
    const row = await requireMutableHost(ctx.env, ctx.req.param("id"));
    if (row.lastRejectedProtocolVersion === null) {
      throw new ApiError({
        status: 409,
        code: "host_update_not_needed",
        message: "The machine is not waiting for a protocol update",
      });
    }
    if (row.lastRejectedProtocolVersion >= DAEMON_PROTOCOL_VERSION) {
      throw new ApiError({
        status: 409,
        code: "host_cannot_self_update",
        message: "The machine daemon is not older than this server",
      });
    }
    await hub(ctx.env).requestHostProtocolUpdateRetry({ hostId: row.id });
    return ctx.json({ ok: true });
  });

  routes.delete("/hosts/:id", async (ctx) => {
    const hostId = ctx.req.param("id");
    await requireMutableHost(ctx.env, hostId);
    // bb routes/hosts.ts:192-198: the primary host (here: the bb cascade
    // minus the server dataDir term — the only connected host, else the only
    // remaining host) cannot be removed.
    if ((await resolvePrimaryHostId(ctx.env)) === hostId) {
      throw new ApiError({
        status: 400,
        code: "primary_host_removal_refused",
        message: "The primary host cannot be removed",
      });
    }
    // bb routes/hosts.ts:200-203 also revokes the host's auth keys here. The
    // POC credential model has one deployment-wide env key (the DO mirror is
    // deployment-scoped, not per-host), so there is nothing per-host to
    // revoke — that step lands with M1's key registry (G8 family; recorded
    // in docs/research/bb-host-surface.md §8). A deleted host's row still
    // never resurrects (upsertAttachedHost guard) and stays out of /hosts.
    const stub = daemonStubOrNull(ctx.env, hostId);
    if (stub !== null) {
      // bb routes/hosts.ts:204-207 → handleHostRemoved: terminal disconnect —
      // close the daemon session (journal + sockets + one host-disconnected
      // broadcast) before the row tombstones, so /hosts loses the row and the
      // DO holds no live socket (#195 S4). A hiccup here must not block the
      // tombstone: the destroyed row never resurrects (upsert guard) and
      // hostLiveness degrades on its own once the socket dies.
      await stub.closeSession({ hostId, reason: "expired" }).catch((error: unknown) => {
        console.error(`host session close failed for ${hostId}:`, error);
      });
    }
    // bb delete marks destroyedAt (soft destroy), it does not hard-delete.
    await updateHostRow(ctx.env, hostId, { destroyedAt: Date.now() });
    // bb destroyHost broadcasts host-disconnected (data/hosts.ts:229-230);
    // bb ships this second frame even when the close above already did.
    await hub(ctx.env).notifyHost(ctx.req.param("id"), ["host-disconnected"]);
    return ctx.json({ ok: true });
  });

  app.route("/api/v1", routes);
}

/**
 * bb requireNonDestroyedHostWithStatus (entity-lookup.ts:115-131): unknown →
 * 404 host_not_found; destroyed → 404 host_unavailable with the destroyed
 * details (lifecycle-api-errors.ts:149-158) so the SPA's destroyed-host
 * branch renders instead of the generic fallback.
 */
async function requireHost(env: Env, hostId: string) {
  const row = await getHostRow(env, hostId);
  if (row === null) {
    throw new ApiError({ status: 404, code: "host_not_found", message: "Host not found" });
  }
  if (row.destroyedAt !== null) {
    throw new ApiError({
      status: 404,
      code: "host_unavailable",
      message: "Host is unavailable",
      details: {
        reason: "destroyed",
        hostStatus: null,
        suspendedAt: null,
        destroyedAt: row.destroyedAt,
      },
    });
  }
  return row;
}

/**
 * bb requireMutableHost (routes/hosts.ts:40-46): the mutation routes answer
 * a plain host_not_found for unknown AND destroyed rows — only the read face
 * distinguishes the tombstone.
 */
async function requireMutableHost(env: Env, hostId: string) {
  const row = await getHostRow(env, hostId);
  if (row?.destroyedAt !== null) {
    throw new ApiError({ status: 404, code: "host_not_found", message: "Host not found" });
  }
  return row;
}

/**
 * bb resolvePrimaryHostId (services/hosts/primary-host.ts:70-76) minus the
 * server dataDir term the composed port does not have: the only connected
 * host, else the only public (non-destroyed) host; null with neither.
 */
async function resolvePrimaryHostId(env: Env): Promise<string | null> {
  const rows = await listNonDestroyedHostRows(env);
  if (rows.length === 0) return null;
  const connected = await Promise.all(rows.map((row) => daemonConnected(env, row.id)));
  const connectedIds = rows.filter((_, index) => connected[index]).map((row) => row.id);
  if (connectedIds.length === 1) return connectedIds[0] ?? null;
  if (rows.length === 1) return rows[0]?.id ?? null;
  return null;
}

function daemonStubOrNull(env: Env, hostId: string): (DurableObjectStub & DaemonServiceDO) | null {
  const namespace = env.DAEMON_SERVICE;
  if (namespace === undefined) return null;
  return namespace.get(namespace.idFromName(hostId)) as DurableObjectStub & DaemonServiceDO;
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
    requestHostProtocolUpdateRetry(args: { hostId: string }): Promise<{ ok: true }>;
  };
}
