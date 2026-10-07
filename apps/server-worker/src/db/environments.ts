import type { Env } from "../env.js";
import {
  ENVIRONMENT_COLUMN_SQL,
  toEnvironmentDbRow,
  type EnvironmentDbRow,
  type WorkspaceProvisionType,
} from "./rows.js";

/**
 * #288 environments persistence (bb packages/db schema.ts:485-536 via the
 * 0002 migration). The binding unit of `threads → environments → (hosts ×
 * path)`: rows are found-or-created at thread creation (the only producer),
 * read by the thread list/detail faces and GET /environments.
 */

export async function getEnvironmentRow(env: Env, id: string): Promise<EnvironmentDbRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${ENVIRONMENT_COLUMN_SQL} FROM environments WHERE id = ?`,
  )
    .bind(id)
    .first();
  return row ? toEnvironmentDbRow(row) : null;
}

export async function listEnvironmentRows(
  env: Env,
  filters: { projectId?: string } = {},
): Promise<EnvironmentDbRow[]> {
  // #445 data-hygiene ruling: the list face is the bindable-workspace
  // inventory, so a row whose host row is destroyed (tombstoned) must not
  // advertise itself as selectable — GET /hosts excludes destroyed rows on
  // the same principle. Row-level reads (GET /environments/:id) stay
  // unfiltered: an existing thread's binding stays resolvable/debuggable.
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filters.projectId !== undefined) {
    where.push("project_id = ?");
    binds.push(filters.projectId);
  }
  where.push("host_id IN (SELECT id FROM hosts WHERE destroyed_at IS NULL)");
  const sql = `SELECT ${ENVIRONMENT_COLUMN_SQL} FROM environments WHERE ${where.join(
    " AND ",
  )} ORDER BY created_at ASC, id ASC`;
  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return results.map(toEnvironmentDbRow);
}

/** The unique key (project_id, host_id, path); NULL path (personal workspace)
 * needs an IS match — SQLite unique indexes treat NULLs as distinct. */
export async function findEnvironmentRowByProjectHostPath(
  env: Env,
  args: { projectId: string; hostId: string; path: string | null },
): Promise<EnvironmentDbRow | null> {
  const row =
    args.path === null
      ? await env.DB.prepare(
          `SELECT ${ENVIRONMENT_COLUMN_SQL} FROM environments WHERE project_id = ? AND host_id = ? AND path IS NULL`,
        )
          .bind(args.projectId, args.hostId)
          .first()
      : await env.DB.prepare(
          `SELECT ${ENVIRONMENT_COLUMN_SQL} FROM environments WHERE project_id = ? AND host_id = ? AND path = ?`,
        )
          .bind(args.projectId, args.hostId, args.path)
          .first();
  return row ? toEnvironmentDbRow(row) : null;
}

export interface CreateEnvironmentRowArgs {
  id: string;
  projectId: string;
  hostId: string;
  path: string | null;
  workspaceProvisionType: WorkspaceProvisionType;
  status?: EnvironmentDbRow["status"];
}

export async function createEnvironmentRow(
  env: Env,
  args: CreateEnvironmentRowArgs,
): Promise<EnvironmentDbRow> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO environments (${ENVIRONMENT_COLUMN_SQL}) VALUES (${ENVIRONMENT_COLUMN_SQL.split(
      ", ",
    )
      .map(() => "?")
      .join(", ")})`,
  )
    .bind(
      args.id,
      null,
      args.projectId,
      args.hostId,
      args.path,
      0,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      args.workspaceProvisionType,
      args.status ?? "ready",
      now,
      now,
    )
    .run();
  const row = await getEnvironmentRow(env, args.id);
  if (!row) {
    throw new Error(`environment ${args.id} missing after insert`);
  }
  return row;
}

/**
 * bb ensureEnvironment anchor shape: the unique index (project_id, host_id,
 * path) claims a workspace per project; the find-then-create-then-re-read
 * sequence absorbs the create race (loser re-reads the winner's row).
 */
export async function findOrCreateEnvironmentRow(
  env: Env,
  args: CreateEnvironmentRowArgs,
): Promise<EnvironmentDbRow> {
  const existing = await findEnvironmentRowByProjectHostPath(env, {
    projectId: args.projectId,
    hostId: args.hostId,
    path: args.path,
  });
  if (existing !== null) {
    return existing;
  }
  await createEnvironmentRow(env, args).catch(async (error: unknown) => {
    // Unique-index race: another create won the same (project, host, path).
    const raced = await findEnvironmentRowByProjectHostPath(env, {
      projectId: args.projectId,
      hostId: args.hostId,
      path: args.path,
    });
    if (raced === null) {
      throw error;
    }
  });
  const row = await findEnvironmentRowByProjectHostPath(env, {
    projectId: args.projectId,
    hostId: args.hostId,
    path: args.path,
  });
  if (row === null) {
    throw new Error("environment missing after find-or-create");
  }
  return row;
}
