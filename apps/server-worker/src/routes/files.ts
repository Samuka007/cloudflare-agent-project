import { Hono } from "hono";

import { hostMkdirRequestSchema, hostPathMutationResultSchema } from "../contract/api/files.js";
import { HOST_COMMAND_TIMEOUT_MS, hostOnlineRpcOrThrow } from "../services/host-rpc.js";
import { remapHostFileRouteError } from "../services/host-files.js";
import { requirePrimaryHostId } from "../services/host-records.js";
import { ApiError } from "../shared/api-error.js";
import { requireJsonBody } from "../shared/route-utils.js";
import type { AppEnv } from "../app-types.js";

/**
 * Host file primitives — the bb routes/files.ts family, hosted at
 * /api/v1/files/* (+ /api/v1/file-previews/*).
 *
 * #494 adjudication (2026-10-07, PM ticket with staging observation): the
 * Add-project folder browser's "New folder" calls exactly one face of the
 * family — `sdk.files.mkdir` (RemotePathBrowser.tsx:137 posts
 * { hostId, path }); the listing around it rides GET /hosts/:id/directory
 * (ported in #302) and the post-create refresh re-asks that same listing
 * face. Staging probe (all nine family endpoints, 2026-10-07): every one
 * answered 404 {"code":"not_found","message":"Route not found"} — the whole
 * family was unported, so the browser's folder creation died on a routing
 * 404. Rulings:
 *
 * - POST /files/mkdir — PORTED (this module): the directory lands on the
 *   machine over the daemon (`host.mkdir`, bb anchor
 *   bb/apps/server/src/routes/files.ts:289-308 + host-daemon
 *   path-mutations.ts:78-92). The folder browser's "directory" IS the
 *   machine checkout (add-source ruling #445) — a Cloudflare-side table
 *   would create a folder no later face could write into.
 * - The rest of the family has no SPA consumer in this deployment and stays
 *   deferred WITH an explicit 501 not_implemented answer instead of the bare
 *   router 404 ("Route not found" reads as a routing bug — the #302 dialog
 *   experience this ticket exists to avoid):
 *   - read: the thread host-files/content face serves the supported reads
 *     (B1 #321); a host-scoped rootPath-confined files.read has no consumer,
 *     and rootPath confinement cannot be enforced fail-closed against
 *     daemons predating the field (their schema strips it silently).
 *   - write: no consumer; the wire name `host.write_file` is already
 *     occupied by the B2 #322 thread-scoped image write (a rename would
 *     break the shipped #322/#487 chain for no product gain).
 *   - list / paths: the browser uses single-level hosts/directory listings
 *     (#302); bb's recursive fuzzy listing + ranking is a larger port with
 *     no caller.
 *   - move / remove: RemotePathBrowser has no rename/delete UI.
 *   - previews (+ /file-previews/:id/:filePath): bb keeps preview leases in
 *     server-process memory; a Worker has no stable process to hold them —
 *     opening the face needs a DO/KV lease design first.
 *   The upstream module also registers GET /threads/:id/files/raw (the raw
 *   HTML preview); that path belongs to the thread family and is not part
 *   of this family's routing.
 */
export function registerFileRoutes(app: Hono<AppEnv>): void {
  const routes = new Hono<AppEnv>();

  // bb requirePrivilegedJsonMutation (routes/files.ts:173-200): privileged
  // file mutations demand an application/json body — the origin leg is
  // already the app-level originGuard, so only the content-type leg lands
  // here. GET/HEAD/OPTIONS pass through to the router (bb guard :155-166).
  routes.use("/files/mkdir", async (ctx, next) => {
    const method = ctx.req.method.toUpperCase();
    const contentType = ctx.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      method !== "OPTIONS" &&
      contentType !== "application/json"
    ) {
      throw new ApiError({
        status: 415,
        code: "unsupported_media_type",
        message: "content-type must be application/json",
      });
    }
    await next();
  });

  // bb routes/files.ts:289-308 over the daemon (host.mkdir): absolute path on
  // the machine, optional rootPath confinement, recursive parents opt-in.
  // bb's retryable-transport wait (online-rpc.ts:75-95) is a single-attempt
  // ask here — the SPA's react-query retry covers the just-connecting race.
  routes.post("/files/mkdir", async (ctx) => {
    const payload = await requireJsonBody(ctx, hostMkdirRequestSchema);
    const hostId = payload.hostId ?? (await requirePrimaryHostId(ctx.env));
    try {
      const result = await hostOnlineRpcOrThrow(
        ctx.env,
        hostId,
        {
          type: "host.mkdir",
          path: payload.path,
          recursive: payload.recursive ?? false,
          ...(payload.rootPath !== undefined ? { rootPath: payload.rootPath } : {}),
        },
        HOST_COMMAND_TIMEOUT_MS,
      );
      const parsed = hostPathMutationResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new ApiError({
          status: 500,
          code: "command_result_invalid",
          message: "Host RPC returned a malformed mkdir result",
          details: { issues: parsed.error.issues },
        });
      }
      return ctx.json(parsed.data);
    } catch (error) {
      return remapHostFileRouteError(error);
    }
  });

  // #494: the deferred family members — explicit per-face unsupported
  // answers (see the module header for the ruling behind each one).
  routes.post("/files/read", () => {
    throw new ApiError({
      status: 501,
      code: "not_implemented",
      message: "Host file read is not supported in this deployment yet",
    });
  });
  routes.post("/files/write", () => {
    throw new ApiError({
      status: 501,
      code: "not_implemented",
      message: "Host file write is not supported in this deployment yet",
    });
  });
  routes.post("/files/list", () => {
    throw new ApiError({
      status: 501,
      code: "not_implemented",
      message: "Host file listing is not supported in this deployment yet",
    });
  });
  routes.post("/files/paths", () => {
    throw new ApiError({
      status: 501,
      code: "not_implemented",
      message: "Host path listing is not supported in this deployment yet",
    });
  });
  routes.post("/files/move", () => {
    throw new ApiError({
      status: 501,
      code: "not_implemented",
      message: "Host file move is not supported in this deployment yet",
    });
  });
  routes.post("/files/remove", () => {
    throw new ApiError({
      status: 501,
      code: "not_implemented",
      message: "Host file removal is not supported in this deployment yet",
    });
  });
  routes.post("/files/previews", () => {
    throw new ApiError({
      status: 501,
      code: "not_implemented",
      message: "Host file previews are not supported in this deployment yet",
    });
  });
  routes.get("/file-previews/:id/:filePath{.+}", () => {
    throw new ApiError({
      status: 501,
      code: "not_implemented",
      message: "Host file previews are not supported in this deployment yet",
    });
  });

  app.route("/api/v1", routes);
}
