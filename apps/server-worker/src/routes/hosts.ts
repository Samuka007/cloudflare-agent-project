import { Hono } from "hono";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import {
  DAEMON_PROTOCOL_VERSION,
  mintJoinCode,
  type DaemonServiceDO,
  type HostDirectoryListing,
  type HostRpcCommand,
} from "@cap/daemon-service";
import {
  createHostJoinCodeRequestSchema,
  hostDirectoryListingSchema,
  hostDirectoryQuerySchema,
  updateHostPermissionCeilingRequestSchema,
  updateHostRequestSchema,
} from "../contract/api/hosts.js";
import { createHostId } from "../shared/ids.js";
import { ApiError } from "../shared/api-error.js";
import { parseOr422, requireJsonBody } from "../shared/route-utils.js";
import { getHostRow, listNonDestroyedHostRows, updateHostRow } from "../db/hosts.js";
import { toHostRecord } from "../services/host-records.js";
import type { Env, HonoBindings } from "../app-types.js";

/** bb COMMAND_TIMEOUT_MS (apps/server/src/constants.ts:1) — the host online
 * RPC window (directory browsing today, #302). */
const HOST_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Hosts face (ruling #7 "hosts 最小"): fleet list/get/rename/ceiling/delete.
 * Status derives read-time from the live daemon session — bb's toHostStatus
 * (entity-lookup.ts:71-80) asks the hub for the host's registered daemon
 * session and answers "connected" only for an open one; the port asks the
 * per-host daemon-service DO (hostLiveness: current session + live socket).
 * Rows land via the daemon attach bridge (#49); daemon heartbeats keep
 * last_seen_at advancing through the DO's registry projection (#62).
 * Enrollment itself is the daemon service's /enroll, not served here.
 * Since #386 the fleet is never empty: migration 0004 seeds the cloud
 * placeholder row (`cloud`, type "placeholder") — the removal guard anchors
 * bb's "must have one machine" invariant there, so every REAL machine stays
 * deletable and the row itself carries the empty-machine semantics (never
 * connected, never heartbeats).
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
    // The providers face stays permanently cropped (matrix E8): the web-only
    // deployment never installs or manages codex/claude-code CLIs, so there
    // is no daemon-RPC answer to fake. But the old constant 502
    // host_unavailable was the WRONG crop shape — the compose page polls
    // this on every project-add open (RootComposeView.tsx:902) and the
    // machine settings page rendered a permanent "Status unavailable" error
    // row (MachineSettingsView.tsx:337) for what is really an empty state.
    // #302 hotfix (post-#330 staging crash): the pinned SPA does NOT tolerate
    // an empty record — providerCliEntries maps over the FIXED managed list
    // (codex/claudeCode) and buildProviderCliIssue immediately dereferences
    // `status.installed`, so a missing key is a TypeError that kills the
    // whole SPA (observed: home page "bb hit an error and stopped", reading
    // 'installed' of undefined). bb's server always returns every managed
    // key; mirror that with explicit not-installed entries.
    return ctx.json({
      codex: notInstalledCliStatus("Codex", "codex"),
      claudeCode: notInstalledCliStatus("Claude Code", "claude"),
    });
  });

  // bb providerCliStatusSchema (host-daemon-contract local.ts:217-231) with
  // every field present, describing a CLI this web-only deployment never
  // manages. installSource "notInstalled" is the enum's explicit member for
  // exactly this state.
  const notInstalledCliStatus = (displayName: string, executableName: string) => ({
    displayName,
    executableName,
    executablePath: null,
    installed: false,
    installSource: "notInstalled",
    currentVersion: null,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
  });

  // bb routes/hosts.ts:219-233: the Add-project path browser's single-level
  // listing — the call whose 404 surfaced as the dialog's inline "Route not
  // found" (#302). Omitting `path` lists the host's home directory (resolved
  // on the host). Served over the daemon online-RPC seam (hostOnlineRpc);
  // bb's retryable-transport wait (online-rpc.ts:75-95) is a single-attempt
  // ask here — the SPA's react-query retry covers the just-connecting race.
  routes.get("/hosts/:id/directory", async (ctx) => {
    const query = parseOr422(hostDirectoryQuerySchema, ctx.req.query());
    const command: HostRpcCommand = {
      type: "host.browse_directory",
      ...(query.path !== undefined ? { path: query.path } : {}),
    };
    const hostId = ctx.req.param("id");
    // bb assertUsableHostId (routes/hosts.ts:222-223): unknown/destroyed → 404.
    await requireHost(ctx.env, hostId);
    const stub = daemonStubOrNull(ctx.env, hostId);
    if (stub === null) throw hostUnavailable();
    const outcome = await stub.hostOnlineRpc({
      hostId,
      command,
      timeoutMs: HOST_COMMAND_TIMEOUT_MS,
    });
    switch (outcome.kind) {
      case "host_offline":
        throw hostUnavailable();
      case "timeout":
        // bb online-rpc.ts:154-156.
        throw new ApiError({
          status: 504,
          code: "command_timeout",
          message: "Timed out waiting for command result",
        });
      case "ok": {
        const response = outcome.response;
        if (!response.ok) {
          // bb online-rpc.ts:98-99: a daemon-side dispatch failure surfaces
          // as 502 with the daemon's own code verbatim (invalid_path, ENOENT…).
          throw new ApiError({
            status: 502,
            code: response.errorCode,
            message: response.errorMessage,
            retryable: false,
          });
        }
        if (response.commandType !== command.type) {
          // bb online-rpc.ts:102-108.
          throw new ApiError({
            status: 500,
            code: "command_result_type_mismatch",
            message: `Host RPC ${response.requestId} completed with unexpected type ${response.commandType}`,
          });
        }
        const parsed = hostDirectoryListingSchema.safeParse(response.result);
        if (!parsed.success) {
          throw new ApiError({
            status: 500,
            code: "command_result_invalid",
            message: `Host RPC ${response.requestId} returned a malformed listing`,
            details: { issues: parsed.error.issues },
          });
        }
        return ctx.json(parsed.data satisfies HostDirectoryListing);
      }
    }
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
    // #386: bb's "must have one machine" invariant anchors on the seeded
    // cloud placeholder row, not on a real machine. bb's guard lives at
    // routes/hosts.ts:192-198 against resolvePrimaryHostId
    // (services/hosts/primary-host.ts:70-76, cascade dataDir → only connected
    // → only remaining); the composed port re-anchors the SAME protection on
    // the placeholder: this row is refused with the empty-machine judgment,
    // and every real machine is removable even as the lone/only-connected
    // host — a zero-real-machine fleet falls back to the placeholder with
    // its semantics intact (threads re-bind to `cloud`, host tools answer
    // the honest host_offline).
    if (hostId === CLOUD_PLACEHOLDER_HOST_ID) {
      throw new ApiError({
        status: 400,
        code: "placeholder_host_removal_refused",
        message: "placeholder holds empty-machine semantics",
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
 * bb HostOnlineRpcUnavailableError → ApiError (services/hosts/online-rpc.ts:
 * 162-163): the host online RPC asked a machine with no live daemon session.
 */
function hostUnavailable(): ApiError {
  return new ApiError({
    status: 502,
    code: "host_unavailable",
    message: "Host is not connected",
  });
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

function daemonStubOrNull(env: Env, hostId: string): (DurableObjectStub & DaemonServiceDO) | null {
  const namespace = env.DAEMON_SERVICE;
  if (namespace === undefined) return null;
  return namespace.get(namespace.idFromName(hostId)) as DurableObjectStub & DaemonServiceDO;
}

/** Realtime hub fan-out (threads.ts hub idiom): host changed frames. */
function hub(env: Env) {
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  return stub as DurableObjectStub & {
    notifyHost(hostId: string, changes: string[]): Promise<{ delivered: number }>;
    requestHostProtocolUpdateRetry(args: { hostId: string }): Promise<{ ok: true }>;
  };
}
