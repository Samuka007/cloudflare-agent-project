import type { Env } from "../env.js";

/**
 * project_sources persistence (bb packages/db schema.ts projectSources).
 * #445: the add-source face joins the read half — create/update/delete port
 * bb packages/db/src/data/project-sources.ts with the hub notification kept
 * at the route layer (D1 has no transactions; bb's tx becomes a sequential
 * statement chain, the UNIQUE(project_id, host_id) index the same backstop).
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

/** bb getProjectSourceByHost (data/project-sources.ts:198-215). */
export async function getProjectSourceByHost(
  env: Env,
  projectId: string,
  hostId: string,
): Promise<ProjectSourceResponse | null> {
  const row = await env.DB.prepare(
    "SELECT id, project_id, is_default, type, host_id, path, created_at, updated_at FROM project_sources WHERE project_id = ? AND host_id = ? LIMIT 1",
  )
    .bind(projectId, hostId)
    .first();
  return row ? toProjectSourceResponse(row) : null;
}

/** bb getProjectSourceForProject (data/project-sources.ts:108-124): the row
 * must belong to BOTH ids — the cross-project sourceId probe 404s. */
export async function getProjectSourceForProject(
  env: Env,
  args: { projectId: string; sourceId: string },
): Promise<ProjectSourceResponse | null> {
  const row = await env.DB.prepare(
    "SELECT id, project_id, is_default, type, host_id, path, created_at, updated_at FROM project_sources WHERE id = ? AND project_id = ?",
  )
    .bind(args.sourceId, args.projectId)
    .first();
  return row ? toProjectSourceResponse(row) : null;
}

/** bb countProjectSources (data/project-sources.ts:130-141). */
export async function countProjectSources(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM project_sources WHERE project_id = ?")
    .bind(projectId)
    .first();
  return Number(row?.n ?? 0);
}

/**
 * bb createProjectSource (data/project-sources.ts:36-76): the first source
 * of a project becomes its default (later adds keep the incumbent); answers
 * null only when the (project_id, host_id) UNIQUE index rejects a duplicate
 * — the route maps that to bb's 409 project_source_host_conflict.
 */
export async function createProjectSourceRow(
  env: Env,
  args: { projectId: string; hostId: string; path: string },
): Promise<ProjectSourceResponse | null> {
  const now = Date.now();
  const existing = await countProjectSources(env, args.projectId);
  const shouldBeDefault = existing === 0;
  if (shouldBeDefault) {
    await env.DB.prepare(
      "UPDATE project_sources SET is_default = 0, updated_at = ? WHERE project_id = ?",
    )
      .bind(now, args.projectId)
      .run();
  }
  const id = `src_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  try {
    await env.DB.prepare(
      "INSERT INTO project_sources (id, project_id, is_default, type, host_id, path, created_at, updated_at) VALUES (?, ?, ?, 'local_path', ?, ?, ?, ?)",
    )
      .bind(id, args.projectId, shouldBeDefault ? 1 : 0, args.hostId, args.path, now, now)
      .run();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed") &&
      error.message.includes("project_sources.project_id") &&
      error.message.includes("project_sources.host_id")
    ) {
      return null;
    }
    throw error;
  }
  const row = await env.DB.prepare(
    "SELECT id, project_id, is_default, type, host_id, path, created_at, updated_at FROM project_sources WHERE id = ?",
  )
    .bind(id)
    .first();
  if (row === null) {
    throw new Error(`project source ${id} missing after insert`);
  }
  return toProjectSourceResponse(row);
}

/**
 * bb updateProjectSource (data/project-sources.ts:150-196): isDefault=true
 * demotes every sibling first; answers null for an unknown id.
 */
export async function updateProjectSourceRow(
  env: Env,
  sourceId: string,
  input: { path?: string; isDefault?: true },
): Promise<ProjectSourceResponse | null> {
  const existing = await env.DB.prepare("SELECT project_id FROM project_sources WHERE id = ?")
    .bind(sourceId)
    .first();
  if (existing === null) {
    return null;
  }
  const now = Date.now();
  if (input.isDefault === true) {
    await env.DB.prepare(
      "UPDATE project_sources SET is_default = 0, updated_at = ? WHERE project_id = ? AND id != ?",
    )
      .bind(now, String(existing.project_id), sourceId)
      .run();
  }
  await env.DB.prepare(
    "UPDATE project_sources SET updated_at = ?, path = COALESCE(?, path), is_default = CASE WHEN ? THEN 1 ELSE is_default END WHERE id = ?",
  )
    .bind(now, input.path ?? null, input.isDefault === true ? 1 : 0, sourceId)
    .run();
  const row = await env.DB.prepare(
    "SELECT id, project_id, is_default, type, host_id, path, created_at, updated_at FROM project_sources WHERE id = ?",
  )
    .bind(sourceId)
    .first();
  return row ? toProjectSourceResponse(row) : null;
}

/**
 * bb deleteProjectSource (data/project-sources.ts:232-276): deleting the
 * default promotes the earliest remaining source (created_at, id order).
 */
export async function deleteProjectSourceRow(env: Env, sourceId: string): Promise<boolean> {
  const existing = await env.DB.prepare(
    "SELECT project_id, is_default FROM project_sources WHERE id = ?",
  )
    .bind(sourceId)
    .first();
  if (existing === null) {
    return false;
  }
  await env.DB.prepare("DELETE FROM project_sources WHERE id = ?").bind(sourceId).run();
  if (Number(existing.is_default) !== 0) {
    await env.DB.prepare(
      "UPDATE project_sources SET is_default = 1, updated_at = ? WHERE id = (SELECT id FROM project_sources WHERE project_id = ? ORDER BY created_at ASC, id ASC LIMIT 1)",
    )
      .bind(Date.now(), String(existing.project_id))
      .run();
  }
  return true;
}

/**
 * #468: bb's projectSources.hostId is `references hosts.id,
 * { onDelete: "cascade" }` (packages/db schema.ts:450-483; schema.test.ts:
 * 344-346 pins sources vanishing with their host), so a deleted machine
 * takes its source rows across ALL projects with it. The port tombstones
 * the host (routes/hosts.ts soft destroy) and runs this equivalent from the
 * delete face. Deliberately NO default promotion — bb's cascade doesn't
 * promote (only the SPA-driven deleteProjectSource does, :232-276): the
 * surviving sources keep is_default=0 and the project's binding default
 * resolves to nothing, which the #377 cloud placeholder terminal owns
 * (thread-binding.ts #468 branch).
 */
export async function deleteProjectSourceRowsByHost(env: Env, hostId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT project_id FROM project_sources WHERE host_id = ?",
  )
    .bind(hostId)
    .all();
  await env.DB.prepare("DELETE FROM project_sources WHERE host_id = ?").bind(hostId).run();
  return results.map((row) => String(row.project_id));
}
