import type { Env } from "../env.js";
import {
  THREAD_COLUMN_SQL,
  toProjectRow,
  toThreadDbRow,
  toThreadSectionRow,
  type ProjectRow,
  type ThreadDbRow,
  type ThreadSectionRow,
} from "./rows.js";

/**
 * Control-plane queries against D1, ported from bb
 * `packages/db/src/data/{projects,threads,thread-sections}.ts`
 * (commit 8473d8c33). Filter/order semantics follow
 * buildListThreadsFilters / buildListThreadsOrderBy (threads.ts:686-757).
 */

export async function getProject(env: Env, projectId: string): Promise<ProjectRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, kind, name, git_remote_url, sort_key, deleted_at, created_at, updated_at FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first();
  return row ? toProjectRow(row) : null;
}

export async function getPersonalProject(env: Env): Promise<ProjectRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, kind, name, git_remote_url, sort_key, deleted_at, created_at, updated_at FROM projects WHERE kind = 'personal' LIMIT 1",
  ).first();
  return row ? toProjectRow(row) : null;
}

export async function listPublicProjects(env: Env): Promise<ProjectRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, kind, name, git_remote_url, sort_key, deleted_at, created_at, updated_at FROM projects WHERE deleted_at IS NULL ORDER BY sort_key ASC, id ASC",
  ).all();
  return results.map(toProjectRow);
}

export async function createProject(
  env: Env,
  args: { id: string; name: string; kind: "standard" | "personal"; gitRemoteUrl: string | null },
): Promise<ProjectRow> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO projects (id, kind, name, git_remote_url, sort_key, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'V', NULL, ?, ?)",
  )
    .bind(args.id, args.kind, args.name, args.gitRemoteUrl, now, now)
    .run();
  return {
    id: args.id,
    kind: args.kind,
    name: args.name,
    gitRemoteUrl: args.gitRemoteUrl,
    sortKey: "V",
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateProject(
  env: Env,
  args: { id: string; name?: string; deletedAt?: number | null },
): Promise<ProjectRow | null> {
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [Date.now()];
  if (args.name !== undefined) {
    sets.push("name = ?");
    binds.push(args.name);
  }
  if (args.deletedAt !== undefined) {
    sets.push("deleted_at = ?");
    binds.push(args.deletedAt);
  }
  binds.push(args.id);
  await env.DB.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return getProject(env, args.id);
}

// --- thread sections -------------------------------------------------------------

export async function listThreadSections(env: Env): Promise<ThreadSectionRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, created_at, updated_at FROM thread_sections ORDER BY created_at ASC, id ASC",
  ).all();
  return results.map(toThreadSectionRow);
}

export async function getThreadSection(
  env: Env,
  sectionId: string,
): Promise<ThreadSectionRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, created_at, updated_at FROM thread_sections WHERE id = ?",
  )
    .bind(sectionId)
    .first();
  return row ? toThreadSectionRow(row) : null;
}

export async function createThreadSection(
  env: Env,
  args: { id: string; name: string },
): Promise<ThreadSectionRow> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO thread_sections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(args.id, args.name, now, now)
    .run();
  return { id: args.id, name: args.name, createdAt: now, updatedAt: now };
}

export async function renameThreadSection(
  env: Env,
  args: { id: string; name: string },
): Promise<ThreadSectionRow | null> {
  await env.DB.prepare("UPDATE thread_sections SET name = ?, updated_at = ? WHERE id = ?")
    .bind(args.name, Date.now(), args.id)
    .run();
  return getThreadSection(env, args.id);
}

export async function deleteThreadSection(env: Env, sectionId: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM thread_sections WHERE id = ?")
    .bind(sectionId)
    .run();
  return result.meta.changes > 0;
}

// --- threads ----------------------------------------------------------------------

export interface ThreadListFilters {
  projectId?: string;
  parentThreadId?: string;
  sourceThreadId?: string;
  archived?: boolean;
  sectionId?: string;
  unsectioned?: boolean;
  hasParent?: boolean;
  originKind?: string;
  originPluginId?: string;
  includeHidden?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Filters per bb buildListThreadsFilters: deleted_at always NULL, visible-only
 * unless includeHidden, archived/hasParent tri-state; ordering per
 * buildListThreadsOrderBy (archived → [archivedAt desc, id desc]; else pinned
 * block → createdAt desc, id desc). Pending-interaction existence is joined as
 * a boolean like listThreadsWithPendingInteractionState.
 */
export async function listThreads(
  env: Env,
  filters: ThreadListFilters,
): Promise<(ThreadDbRow & { hasPendingInteraction: boolean })[]> {
  const where: string[] = ["t.deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (!filters.includeHidden) {
    where.push("t.visibility = 'visible'");
  }
  if (filters.projectId !== undefined) {
    where.push("t.project_id = ?");
    binds.push(filters.projectId);
  }
  if (filters.parentThreadId !== undefined) {
    where.push("t.parent_thread_id = ?");
    binds.push(filters.parentThreadId);
  }
  if (filters.sourceThreadId !== undefined) {
    where.push("t.source_thread_id = ?");
    binds.push(filters.sourceThreadId);
  }
  if (filters.sectionId !== undefined) {
    where.push("t.section_id = ?");
    binds.push(filters.sectionId);
  }
  if (filters.unsectioned) {
    where.push("t.section_id IS NULL");
  }
  if (filters.archived !== undefined) {
    where.push(filters.archived ? "t.archived_at IS NOT NULL" : "t.archived_at IS NULL");
  }
  if (filters.hasParent !== undefined) {
    where.push(filters.hasParent ? "t.parent_thread_id IS NOT NULL" : "t.parent_thread_id IS NULL");
  }
  if (filters.originKind !== undefined) {
    where.push("t.origin_kind = ?");
    binds.push(filters.originKind);
  }
  if (filters.originPluginId !== undefined) {
    where.push("t.origin_plugin_id = ?");
    binds.push(filters.originPluginId);
  }

  const orderBy =
    filters.archived === true
      ? "t.archived_at DESC, t.id DESC"
      : "CASE WHEN t.pinned_at IS NOT NULL THEN 0 ELSE 1 END ASC, t.pin_sort_key ASC, t.id ASC, t.created_at DESC, t.id DESC";

  let sql = `SELECT ${THREAD_COLUMN_SQL.split(", ")
    .map((c) => `t.${c}`)
    .join(
      ", ",
    )}, EXISTS(SELECT 1 FROM pending_interactions pi WHERE pi.thread_id = t.id AND pi.status IN ('pending','resolving')) AS has_pending_interaction FROM threads t WHERE ${where.join(" AND ")} ORDER BY ${orderBy}`;
  if (filters.limit !== undefined) {
    sql += " LIMIT ?";
    binds.push(filters.limit);
  }
  if (filters.offset !== undefined) {
    sql += " OFFSET ?";
    binds.push(filters.offset);
  }

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return results.map((row) => ({
    ...toThreadDbRow(row),
    hasPendingInteraction: row.has_pending_interaction === 1,
  }));
}

export async function getThreadRow(env: Env, threadId: string): Promise<ThreadDbRow | null> {
  const row = await env.DB.prepare(`SELECT ${THREAD_COLUMN_SQL} FROM threads WHERE id = ?`)
    .bind(threadId)
    .first();
  return row ? toThreadDbRow(row) : null;
}

export async function countNonDeletedAssignedChildThreads(
  env: Env,
  parentThreadId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM threads WHERE parent_thread_id = ? AND deleted_at IS NULL",
  )
    .bind(parentThreadId)
    .first();
  return row ? Number(row.n) : 0;
}

export async function getThreadHierarchyDepth(env: Env, threadId: string): Promise<number> {
  const row = await env.DB.prepare(
    `WITH RECURSIVE chain(id, depth) AS (
       SELECT id, 0 FROM threads WHERE id = ?
       UNION ALL
       SELECT t.id, chain.depth + 1 FROM threads t JOIN chain ON t.id = chain.id WHERE t.parent_thread_id IS NOT NULL AND depth < 64
     )
     SELECT c.id AS child_id, (SELECT COUNT(*) FROM chain) AS depth FROM chain c WHERE c.depth = 0`,
  )
    .bind(threadId)
    .first();
  if (row) {
    return Number(row.depth);
  }
  // Fallback: walk parents in SQL-free small steps.
  let depth = 0;
  let currentId: string | null = threadId;
  while (currentId && depth < 64) {
    const parent: { parent_thread_id: string | null } | null = await env.DB.prepare(
      "SELECT parent_thread_id FROM threads WHERE id = ?",
    )
      .bind(currentId)
      .first();
    if (!parent?.parent_thread_id) {
      break;
    }
    currentId = parent.parent_thread_id;
    depth += 1;
  }
  return depth;
}

export interface CreateThreadRecordArgs {
  id: string;
  projectId: string;
  providerId: string;
  title: string | null;
  sectionId: string | null;
  parentThreadId: string | null;
  sourceThreadId: string | null;
  originKind: string | null;
  originPluginId: string | null;
  visibility: ThreadDbRow["visibility"];
  status?: ThreadDbRow["status"];
}

/** bb createThread (packages/db/src/data/threads.ts:290-342) semantics. */
export async function createThreadRecord(
  env: Env,
  args: CreateThreadRecordArgs,
): Promise<ThreadDbRow> {
  const now = Date.now();
  const status = args.status ?? "starting";
  await env.DB.prepare(
    `INSERT INTO threads (${THREAD_COLUMN_SQL}) VALUES (${THREAD_COLUMNS_PLACEHOLDER})`,
  )
    .bind(
      args.id,
      args.projectId,
      null,
      args.providerId,
      null,
      null,
      args.title,
      null,
      args.sectionId,
      status,
      args.parentThreadId,
      args.sourceThreadId,
      args.originKind,
      args.originPluginId,
      args.visibility,
      null,
      null,
      null,
      null,
      now,
      now,
      now,
      now,
    )
    .run();
  const row = await getThreadRow(env, args.id);
  if (!row) {
    throw new Error(`thread ${args.id} missing after insert`);
  }
  return row;
}

const THREAD_COLUMNS_PLACEHOLDER = THREAD_COLUMN_SQL.split(", ")
  .map(() => "?")
  .join(", ");

export interface ThreadMetadataUpdate {
  title?: string | null;
  sectionId?: string | null;
  parentThreadId?: string | null;
  visibility?: ThreadDbRow["visibility"];
  lastReadAt?: number | null;
  status?: ThreadDbRow["status"];
}

/**
 * bb updateThread change-kind mapping (packages/db/src/data/threads.ts:
 * 1610-1677): title/sectionId/visibility → "title-changed", lastReadAt →
 * "read-state-changed", parent → "parent-changed". Returns the changed kinds
 * for broadcasting.
 */
export async function updateThreadRecord(
  env: Env,
  threadId: string,
  update: ThreadMetadataUpdate,
): Promise<{ row: ThreadDbRow; changedKinds: string[] } | null> {
  const current = await getThreadRow(env, threadId);
  if (!current) {
    return null;
  }
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [Date.now()];
  const changedKinds: string[] = [];
  if (update.title !== undefined) {
    sets.push("title = ?");
    binds.push(update.title);
    changedKinds.push("title-changed");
  }
  if (update.sectionId !== undefined) {
    sets.push("section_id = ?");
    binds.push(update.sectionId);
    if (!changedKinds.includes("title-changed")) {
      changedKinds.push("title-changed");
    }
  }
  if (update.visibility !== undefined) {
    sets.push("visibility = ?");
    binds.push(update.visibility);
    if (!changedKinds.includes("title-changed")) {
      changedKinds.push("title-changed");
    }
  }
  if (update.parentThreadId !== undefined) {
    sets.push("parent_thread_id = ?");
    binds.push(update.parentThreadId);
    changedKinds.push("parent-changed");
  }
  if (update.lastReadAt !== undefined) {
    sets.push("last_read_at = ?");
    binds.push(update.lastReadAt);
    changedKinds.push("read-state-changed");
  }
  if (update.status !== undefined) {
    sets.push("status = ?");
    binds.push(update.status);
  }
  await env.DB.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, threadId)
    .run();
  const row = await getThreadRow(env, threadId);
  if (!row) {
    throw new Error(`thread ${threadId} missing after update`);
  }
  return { row, changedKinds };
}

export async function markThreadDeleted(env: Env, threadId: string): Promise<ThreadDbRow | null> {
  const current = await getThreadRow(env, threadId);
  if (current?.deletedAt !== null) {
    return null;
  }
  await env.DB.prepare("UPDATE threads SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .bind(Date.now(), Date.now(), threadId)
    .run();
  return getThreadRow(env, threadId);
}

/** bb pinThread (data/threads.ts:1415-1459): pinSortKey = prefirst order key. */
export async function pinThread(
  env: Env,
  threadId: string,
  pinnedAt: number | null,
): Promise<ThreadDbRow | null> {
  const current = await getThreadRow(env, threadId);
  if (!current) {
    return null;
  }
  if (current.pinnedAt !== null) {
    return current;
  }
  const at = pinnedAt ?? Date.now();
  // Order key sorts before every existing pinned key: "!" < any alphanumeric.
  await env.DB.prepare(
    "UPDATE threads SET pinned_at = ?, pin_sort_key = ?, updated_at = ? WHERE id = ?",
  )
    .bind(at, `!${at.toString(36)}`, Date.now(), threadId)
    .run();
  return getThreadRow(env, threadId);
}

export async function unpinThread(env: Env, threadId: string): Promise<ThreadDbRow | null> {
  const current = await getThreadRow(env, threadId);
  if (!current) {
    return null;
  }
  if (current.pinnedAt === null) {
    return current;
  }
  await env.DB.prepare(
    "UPDATE threads SET pinned_at = NULL, pin_sort_key = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(Date.now(), threadId)
    .run();
  return getThreadRow(env, threadId);
}

export async function setThreadArchived(
  env: Env,
  threadId: string,
  archived: boolean,
): Promise<ThreadDbRow | null> {
  const current = await getThreadRow(env, threadId);
  if (!current) {
    return null;
  }
  if (archived && current.archivedAt !== null) {
    return current;
  }
  if (!archived && current.archivedAt === null) {
    return current;
  }
  await env.DB.prepare("UPDATE threads SET archived_at = ?, updated_at = ? WHERE id = ?")
    .bind(archived ? Date.now() : null, Date.now(), threadId)
    .run();
  return getThreadRow(env, threadId);
}
