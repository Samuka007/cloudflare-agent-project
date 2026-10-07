import { ApiError } from "../shared/api-error.js";
import { getProject } from "../db/control-plane.js";
import type { ProjectRow } from "../db/rows.js";
import type { Env } from "../env.js";

/**
 * bb services/lib/entity-lookup.ts narrowed to the project faces the port
 * serves: requirePublicProject (:182-194) and requirePublicStandardProject
 * (:196-205, the personal singleton answers the same plain project_not_found
 * as an unknown id). Shared by the projects routes and the hosts add-source
 * discovery routes (#445).
 */

export async function requirePublicProject(env: Env, projectId: string): Promise<ProjectRow> {
  const row = await getProject(env, projectId);
  if (!row) {
    throw new ApiError({ status: 404, code: "project_not_found", message: "Project not found" });
  }
  if (row.deletedAt !== null) {
    throw new ApiError({
      status: 410,
      code: "project_unavailable",
      message: "Project is pending deletion",
      details: { reason: "pending_deletion", deletedAt: row.deletedAt },
    });
  }
  return row;
}

export async function requirePublicStandardProject(
  env: Env,
  projectId: string,
): Promise<ProjectRow> {
  const row = await requirePublicProject(env, projectId);
  if (row.kind !== "standard") {
    throw new ApiError({ status: 404, code: "project_not_found", message: "Project not found" });
  }
  return row;
}
