import {
  CLOUD_PLACEHOLDER_HOST_ID,
  type CreateThreadEnvironmentArgs,
} from "@cap/protocol";
import { ApiError } from "../shared/api-error.js";
import { createEnvironmentId } from "../shared/ids.js";
import { getHostRow } from "../db/hosts.js";
import {
  findOrCreateEnvironmentRow,
  getEnvironmentRow,
} from "../db/environments.js";
import { getDefaultProjectSource } from "../db/project-sources.js";
import type { EnvironmentDbRow } from "../db/rows.js";
import type { Env } from "../env.js";

/**
 * #288 binding resolution (control-plane-layer.md §2.1): the binding source
 * chain is resolved ONCE at thread creation, on the server-worker creation
 * path — "解析函数是控制面代码，不是 DO RPC". The resolved machineId freezes
 * into the trajectory (`thread.created.machineId`, replay truth) and the
 * environments row is the control-plane half (threads.environment_id); one
 * resolution feeds both (inventory §2.A6 对账).
 *
 * Priority chain (§2.1):
 *   1. thread-explicit host choice (`host` / `reuse`)
 *   2. project-level workspace binding default — the project's default source
 *      checkout (`project_sources.is_default`; bb resolveProjectWorkspaceTarget
 *      anchor; layer doc §6 leaves the field shape to implementation)
 *   3. the cloud placeholder — pure function, zero D1 (#377: no deployment
 *      machine exists to fall back on; "命中部署默认时连 D1 都不碰" stays)
 *
 * Scope (inventory §4): `unmanaged` + `personal` land here; managed-worktree
 * provisioning is a separate ticket and fails explicitly instead of silently
 * degrading.
 */

export interface ResolvedThreadBinding {
  /** Execution half: freezes into `thread.created.machineId`. */
  machineId: string;
  /** Control-plane half: `threads.environment_id`; null for the deployment
   * default (no row materializes for the deployment machine — §2.3). */
  environmentId: string | null;
  /** The full row when one was found-or-created. */
  environment: EnvironmentDbRow | null;
}

async function requireNonDestroyedHost(env: Env, hostId: string): Promise<void> {
  // bb requireNonDestroyedHostWithStatus (routes/hosts.ts:288): unknown and
  // destroyed hosts answer the same plain host_not_found on work faces.
  const row = await getHostRow(env, hostId);
  if (row === null) {
    throw new ApiError({ status: 404, code: "host_not_found", message: "Host not found" });
  }
  if (row.destroyedAt !== null) {
    throw new ApiError({ status: 404, code: "host_not_found", message: "Host not found" });
  }
}

async function materializeWorkspaceRow(
  env: Env,
  args: {
    projectId: string;
    hostId: string;
    path: string | null;
    workspaceProvisionType: EnvironmentDbRow["workspaceProvisionType"];
  },
): Promise<EnvironmentDbRow> {
  const row = await findOrCreateEnvironmentRow(env, {
    id: createEnvironmentId(),
    projectId: args.projectId,
    hostId: args.hostId,
    path: args.path,
    workspaceProvisionType: args.workspaceProvisionType,
    status: "ready",
  });
  return row;
}

export async function resolveThreadBinding(
  env: Env,
  args: {
    projectId: string;
    environment?: CreateThreadEnvironmentArgs;
  },
): Promise<ResolvedThreadBinding> {
  const requested = args.environment;

  if (requested?.type === "reuse") {
    // bb thread-provisioning-environment.ts:1153-1163: 404 on unknown, 409 on
    // a cross-project reuse.
    const row = await getEnvironmentRow(env, requested.environmentId);
    if (row === null) {
      throw new ApiError({
        status: 404,
        code: "environment_not_found",
        message: "Environment not found",
      });
    }
    if (row.projectId !== args.projectId) {
      throw new ApiError({
        status: 409,
        code: "invalid_request",
        message: "Environment belongs to a different project",
      });
    }
    return { machineId: row.hostId, environmentId: row.id, environment: row };
  }

  if (requested?.type === "host") {
    if (requested.workspace.type === "managed-worktree") {
      // Inventory §4: worktree provisioning is NOT ticket-1 scope — explicit
      // failure beats a silently wrong workspace.
      throw new ApiError({
        status: 422,
        code: "validation_failed",
        message:
          "managed-worktree provisioning is not implemented; use unmanaged or personal workspaces",
      });
    }
    // Personal with no explicit host = the cloud placeholder (#377): no
    // composition machine exists to own bb's host-dataDir scratch. §2.3
    // zero-D1 default on the BINDING face: no registry validation, no
    // environments row — the machineId names the seeded placeholder hosts row
    // itself (#386), and a real host arrives only through an explicit hostId
    // claim (the attach bridge lands the fleet row when its daemon connects).
    if (requested.workspace.type === "personal" && requested.hostId === undefined) {
      return { machineId: CLOUD_PLACEHOLDER_HOST_ID, environmentId: null, environment: null };
    }
    const hostId = requested.hostId;
    if (hostId === undefined) {
      throw new ApiError({
        status: 422,
        code: "validation_failed",
        message: "hostId is required unless workspace.type is personal",
      });
    }
    await requireNonDestroyedHost(env, hostId);
    const row = await materializeWorkspaceRow(env, {
      projectId: args.projectId,
      hostId,
      path: requested.workspace.type === "unmanaged" ? requested.workspace.path : null,
      workspaceProvisionType: requested.workspace.type,
    });
    return { machineId: row.hostId, environmentId: row.id, environment: row };
  }

  // `project-default` or omitted: the project's default source checkout, then
  // the cloud placeholder row (zero D1 on the deployment default, #377;
  // the row itself seeded by #386).
  const source = await getDefaultProjectSource(env, args.projectId);
  if (source === null) {
    return { machineId: CLOUD_PLACEHOLDER_HOST_ID, environmentId: null, environment: null };
  }
  await requireNonDestroyedHost(env, source.hostId);
  const row = await materializeWorkspaceRow(env, {
    projectId: args.projectId,
    hostId: source.hostId,
    path: source.path,
    workspaceProvisionType: "unmanaged",
  });
  return { machineId: row.hostId, environmentId: row.id, environment: row };
}
