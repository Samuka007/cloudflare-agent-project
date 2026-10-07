import type { DaemonServiceDO, HostRpcCommand } from "@cap/daemon-service";
import { ApiError } from "../shared/api-error.js";
import { getHostRow } from "../db/hosts.js";
import type { HostDbRow } from "../db/rows.js";
import type { Env } from "../env.js";

/**
 * #445: the host online-RPC seam the add-source face shares with the
 * directory browser — bb assertUsableHostId (services/hosts/primary-host.ts:
 * 90-98) plus the HostOnlineRpcUnavailableError → ApiError mapping (services/
 * hosts/online-rpc.ts:153-167) the #302 directory route inlined. Extracted
 * verbatim so every host-RPC route answers the same error contract.
 */

/** bb COMMAND_TIMEOUT_MS (apps/server/src/constants.ts:1) — the standard
 * host online-RPC window. Long-running asks (clone) pass their own. */
export const HOST_COMMAND_TIMEOUT_MS = 30_000;

/**
 * bb requireNonDestroyedHostWithStatus (entity-lookup.ts:115-131): unknown →
 * 404 host_not_found; destroyed → 404 host_unavailable with the destroyed
 * details (lifecycle-api-errors.ts:149-158) so the SPA's destroyed-host
 * branch renders instead of the generic fallback.
 */
export async function requireHostRow(env: Env, hostId: string): Promise<HostDbRow> {
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
 * bb assertUsableHostId (services/hosts/primary-host.ts:90-98): any
 * non-destroyed persistent host is accepted; connectivity stays a
 * dispatch-time concern. The cloud placeholder (type "placeholder") is
 * refused with bb's unusableHostError — it holds no daemon to ask.
 */
export async function requireUsableHostRow(env: Env, hostId: string): Promise<HostDbRow> {
  const row = await requireHostRow(env, hostId);
  if (row.type !== "persistent") {
    throw new ApiError({
      status: 400,
      code: "unsupported_host",
      message: "Host cannot run threads",
    });
  }
  return row;
}

/** bb HostOnlineRpcUnavailableError → ApiError (services/hosts/online-rpc.ts:
 * 162-163): the host online RPC asked a machine with no live daemon session. */
function hostUnavailable(): ApiError {
  return new ApiError({
    status: 502,
    code: "host_unavailable",
    message: "Host is not connected",
  });
}

function daemonStubOrNull(env: Env, hostId: string): (DurableObjectStub & DaemonServiceDO) | null {
  const namespace = env.DAEMON_SERVICE;
  if (namespace === undefined) return null;
  return namespace.get(namespace.idFromName(hostId)) as DurableObjectStub & DaemonServiceDO;
}

/**
 * One usable-host check + one host-rpc round trip, answering the RPC result
 * verbatim (the caller validates the command's result schema). Error
 * contract (bb online-rpc.ts:153-167): no live session → 502 host_unavailable;
 * waiter timeout → 504 command_timeout; daemon-side dispatch failure → 502
 * with the daemon's own code verbatim; a mismatched result type → 500
 * command_result_type_mismatch.
 */
export async function hostOnlineRpcOrThrow(
  env: Env,
  hostId: string,
  command: HostRpcCommand,
  timeoutMs: number,
): Promise<unknown> {
  await requireUsableHostRow(env, hostId);
  const stub = daemonStubOrNull(env, hostId);
  if (stub === null) throw hostUnavailable();
  const outcome = await stub.hostOnlineRpc({ hostId, command, timeoutMs });
  switch (outcome.kind) {
    case "host_offline":
      throw hostUnavailable();
    case "timeout":
      throw new ApiError({
        status: 504,
        code: "command_timeout",
        message: "Timed out waiting for command result",
      });
    case "ok": {
      const response = outcome.response;
      if (!response.ok) {
        throw new ApiError({
          status: 502,
          code: response.errorCode,
          message: response.errorMessage,
          retryable: false,
        });
      }
      if (response.commandType !== command.type) {
        throw new ApiError({
          status: 500,
          code: "command_result_type_mismatch",
          message: `Host RPC ${response.requestId} completed with unexpected type ${response.commandType}`,
        });
      }
      return response.result;
    }
  }
}
