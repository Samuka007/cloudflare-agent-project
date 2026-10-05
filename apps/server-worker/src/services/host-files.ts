import type { DaemonServiceDO } from "@cap/daemon-service";
import type { HostFileReadResult } from "../contract/api/hosts.js";
import type { Env } from "../env.js";
import { ApiError } from "../shared/api-error.js";

/**
 * B1 (#321): the thread host-file content face's response builder — bb port
 * of apps/server/src/services/hosts/daemon-file-response.ts:5-77. The daemon
 * already did the byte work (read + cap + base64/utf8 + sha256); this module
 * only decodes and frames the HTTP answer, and remaps the daemon dispatch
 * codes onto the route's API surface.
 */

const OCTET_STREAM_MIME_TYPE = "application/octet-stream";

/**
 * bb COMMAND_TIMEOUT_MS (apps/server/src/constants.ts:1) — the host online
 * RPC window. hosts.ts carries its own private twin for the directory face;
 * the thread host-file face shares this one so both stay bb-anchored.
 */
export const HOST_COMMAND_TIMEOUT_MS = 30_000;

/**
 * bb HostOnlineRpcUnavailableError → ApiError (services/hosts/online-rpc.ts:
 * 162-163): the host online RPC asked a machine with no live daemon session.
 */
export function hostFileHostUnavailable(): ApiError {
  return new ApiError({ status: 502, code: "host_unavailable", message: "Host is not connected" });
}

/**
 * hosts.ts daemonStubOrNull, shared: the per-host DaemonServiceDO stub, or
 * null when the deployment carries no daemon namespace.
 */
export function daemonServiceStubOrNull(env: Env, hostId: string): (DurableObjectStub & DaemonServiceDO) | null {
  const namespace = env.DAEMON_SERVICE;
  if (namespace === undefined) return null;
  return namespace.get(namespace.idFromName(hostId)) as DurableObjectStub & DaemonServiceDO;
}

/** bb decodeDaemonFileContent (daemon-file-response.ts:26-35) on the Workers
 * byte face: the Worker has no node Buffer, so utf8 rides the TextEncoder and
 * base64 rides atob. */
export function decodeHostFileContent(result: HostFileReadResult): ArrayBuffer {
  const view =
    result.contentEncoding === "utf8"
      ? new TextEncoder().encode(result.content)
      : Uint8Array.from(atob(result.content), (character) => character.charCodeAt(0));
  return view.slice().buffer;
}

/** bb createDaemonFileContentResponse (daemon-file-response.ts:37-45). */
export function buildHostFileContentResponse(result: HostFileReadResult): Response {
  return new Response(decodeHostFileContent(result), {
    status: 200,
    headers: {
      "content-type": result.mimeType ?? OCTET_STREAM_MIME_TYPE,
      // Host-disk files mutate outside the server's knowledge — every read is
      // authoritative (bb file faces send no cache headers; the SPA's
      // lightbox re-requests per open).
      "cache-control": "no-store",
    },
  });
}

/**
 * bb remapDaemonFileRouteError (daemon-file-response.ts:47-77): a daemon-side
 * dispatch failure keeps its code verbatim but lands on the HTTP status the
 * route contract promises — ENOENT → 404, invalid_path → 400,
 * file_too_large → 413; anything else rethrows.
 */
export function remapHostFileRouteError(error: unknown): never {
  if (!(error instanceof ApiError)) {
    throw error;
  }

  if (error.code === "ENOENT") {
    throw new ApiError({ status: 404, code: error.code, message: error.message });
  }
  if (error.code === "invalid_path") {
    throw new ApiError({ status: 400, code: error.code, message: error.message });
  }
  if (error.code === "file_too_large") {
    throw new ApiError({ status: 413, code: error.code, message: error.message });
  }
  throw error;
}
