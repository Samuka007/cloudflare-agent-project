import type { Env } from "../env.js";
import { toThreadTabsDbRow, type ThreadTabsDbRow } from "./rows.js";
import type { ThreadTabsResponse } from "../contract/api/thread-tabs.js";
import type { ThreadTab } from "../contract/api/thread-tabs.js";

/**
 * thread_tabs persistence (bb packages/db/src/data/thread-tabs.ts:14-69).
 * GET returns {revision: 0, tabs: []} when no row exists; PUT is a compare-
 * and-set on revision → {outcome: "conflict", revision} on mismatch.
 */
export async function getStoredThreadTabs(env: Env, threadId: string): Promise<ThreadTabsResponse> {
  const row = await env.DB.prepare(
    "SELECT thread_id, tabs_json, revision, updated_at FROM thread_tabs WHERE thread_id = ?",
  )
    .bind(threadId)
    .first();
  if (!row) {
    return { revision: 0, tabs: [] };
  }
  const stored = toThreadTabsDbRow(row);
  return { revision: stored.revision, tabs: JSON.parse(stored.tabsJson) as ThreadTab[] };
}

export type ReplaceThreadTabsResult =
  { outcome: "stored"; stored: ThreadTabsResponse } | { outcome: "conflict"; revision: number };

export async function replaceStoredThreadTabs(
  env: Env,
  args: { threadId: string; expectedRevision: number; tabs: ThreadTab[] },
): Promise<ReplaceThreadTabsResult> {
  const now = Date.now();
  const tabsJson = JSON.stringify(args.tabs);
  // Compare-and-set on revision survives any future executor change (bb
  // comment, data/threads.ts:1942-1944 — same discipline, D1 edition).
  const update = await env.DB.prepare(
    `UPDATE thread_tabs SET tabs_json = ?, revision = revision + 1, updated_at = ?
     WHERE thread_id = ? AND revision = ?`,
  )
    .bind(tabsJson, now, args.threadId, args.expectedRevision)
    .run();
  if ((update.meta.changes ?? 0) > 0) {
    const stored = await getStoredThreadTabs(env, args.threadId);
    return { outcome: "stored", stored };
  }
  const existing = await env.DB.prepare("SELECT revision FROM thread_tabs WHERE thread_id = ?")
    .bind(args.threadId)
    .first();
  if (existing === null) {
    if (args.expectedRevision !== 0) {
      return { outcome: "conflict", revision: 0 };
    }
    await env.DB.prepare(
      "INSERT INTO thread_tabs (thread_id, tabs_json, revision, updated_at) VALUES (?, ?, 1, ?)",
    )
      .bind(args.threadId, tabsJson, now)
      .run();
    return { outcome: "stored", stored: { revision: 1, tabs: args.tabs } };
  }
  return { outcome: "conflict", revision: Number(existing.revision) };
}

export type { ThreadTabsDbRow };
