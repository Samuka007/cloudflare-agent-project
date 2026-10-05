import type { Env } from "../env.js";

/**
 * project_sources persistence (bb packages/db schema.ts projectSources).
 * M0: host-binding rows only; the source/file/skill faces that consume them
 * are OUT of the M0 face (ruling #7).
 */
export interface ProjectSourceResponse {
  id: string;
  projectId: string;
  isDefault: boolean;
  type: "local_path";
  hostId: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

function toProjectSourceResponse(row: Record<string, unknown>): ProjectSourceResponse {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    isDefault: Number(row.is_default) !== 0,
    type: "local_path",
    hostId: String(row.host_id),
    path: String(row.path),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function listProjectSources(
  env: Env,
  projectId: string,
): Promise<ProjectSourceResponse[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, project_id, is_default, type, host_id, path, created_at, updated_at FROM project_sources WHERE project_id = ? ORDER BY created_at ASC, id ASC",
  )
    .bind(projectId)
    .all();
  return results.map(toProjectSourceResponse);
}

/** #288: the project-level workspace binding default — the source checkout
 * resolution falls back to when a thread creation carries no explicit
 * environment (layer doc §2.1 priority chain, position 2). */
export async function getDefaultProjectSource(
  env: Env,
  projectId: string,
): Promise<ProjectSourceResponse | null> {
  const row = await env.DB.prepare(
    "SELECT id, project_id, is_default, type, host_id, path, created_at, updated_at FROM project_sources WHERE project_id = ? AND is_default = 1 ORDER BY created_at ASC, id ASC LIMIT 1",
  )
    .bind(projectId)
    .first();
  if (row === null) {
    return null;
  }
  return toProjectSourceResponse(row);
}
