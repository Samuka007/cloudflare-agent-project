import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import type { ThreadTabsResponse, ThreadTab } from "../../contract/api/thread-tabs";
import {
  environmentWorkspaceDisplayKindSchema,
  resolveEnvironmentWorkspaceDisplayKind,
} from "../../contract/domain/environment";
import {
  threadOriginKindSchema,
  threadSchema,
  type ThreadStatus,
  type ThreadVisibility,
} from "../../contract/domain/thread";
import { environments, threadTabs, threads } from "../schema";

/**
 * Threads aggregate repository — the drizzle-era data access for `threads`,
 * `thread_tabs` and the pending push-write fields (#595, db campaign T3;
 * schema: src/db/schema.ts, ruling: #593/#591).
 *
 * Deep module: callers see plain records and intent-named methods; every
 * drizzle query builder, CASE expression and recursive walk stays behind
 * this file. Behavior ports the legacy port verbatim (src/db/control-plane.ts,
 * src/db/thread-tabs.ts) so the T5 route re-point is mechanical:
 *
 * - list filters follow bb buildListThreadsFilters (deleted always out;
 *   visible-only unless includeHidden; an explicit visibility overrides the
 *   gate) and bb buildListThreadsOrderBy (archived view: [archivedAt desc,
 *   id desc]; otherwise the #337 pinned block: CASE-scoped pinned keys, then
 *   createdAt desc, id desc — the ordering incident dossier lives in
 *   docs/research/thread-list-ordering-window.md);
 * - update returns the bb change-kind mapping for the hub broadcast
 *   (title/sectionId/visibility → "title-changed" deduped, lastReadAt →
 *   "read-state-changed", parent → "parent-changed", binding →
 *   "environment-changed", overrides → "execution-changed") plus the #477
 *   flip guards (expectedStatus / expectedUpdatedAt) — a guard that filters
 *   the write still returns the row as it now stands, which is exactly how
 *   the send route tells a lost race;
 * - tabs are a compare-and-set on revision; GET of a missing row answers
 *   {revision: 0, tabs: []}.
 *
 * Greenfield deltas (documented reversals per the #562 discipline):
 * - hasPendingInteraction derives from the row's pending fields
 *   (`pending_since IS NOT NULL`) — the pending_interactions mirror table is
 *   not ported (#591 ruling); T8 wires the AgentDO flip through
 *   pushPendingState.
 * - hierarchyDepth walks parents with bb resolveParentDepth semantics (chain
 *   node count including self, cycle-safe): the port's recursive CTE
 *   self-joined `t.id = chain.id` and counted one row per cap iteration, and
 *   its JS fallback was off by one vs bb — no test pinned either
 *   (canSpawnChild only compares against MAX_THREAD_HIERARCHY_DEPTH), so the
 *   repo restores the bb truth.
 *
 * Records are zod-derived twins of the domain faces (#591 — no hand-written
 * second copy): the stored extension adds exactly the columns the wire
 * `Thread` face omits.
 */

export const threadRecordSchema = threadSchema.extend({
  modelOverride: z.string().nullable(),
  reasoningLevelOverride: z.string().nullable(),
  pinSortKey: z.string().nullable(),
  pendingSince: z.number().nullable(),
  pendingFoldSeq: z.number().int().nonnegative(),
});
export type ThreadRecord = z.infer<typeof threadRecordSchema>;

export const threadListRecordSchema = threadRecordSchema.extend({
  hasPendingInteraction: z.boolean(),
  environmentHostId: z.string().nullable(),
  environmentName: z.string().nullable(),
  environmentBranchName: z.string().nullable(),
  environmentWorkspaceDisplayKind: environmentWorkspaceDisplayKindSchema,
});
export type ThreadListRecord = z.infer<typeof threadListRecordSchema>;

export interface ThreadListFilters {
  projectId?: string;
  parentThreadId?: string;
  sourceThreadId?: string;
  archived?: boolean;
  sectionId?: string;
  unsectioned?: boolean;
  hasParent?: boolean;
  originKind?: z.infer<typeof threadOriginKindSchema>;
  originPluginId?: string;
  /** Exact visibility match; overrides the includeHidden default gate. */
  visibility?: ThreadVisibility;
  includeHidden?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateThreadArgs {
  id: string;
  projectId: string;
  /** #288 binding row resolved at creation; null = deployment default. */
  environmentId: string | null;
  providerId: string;
  /** #351: the explicit create-time selection overrides (null = unset). */
  modelOverride: string | null;
  reasoningLevelOverride: string | null;
  title: string | null;
  titleFallback: string | null;
  sectionId: string | null;
  parentThreadId: string | null;
  sourceThreadId: string | null;
  originKind: z.infer<typeof threadOriginKindSchema> | null;
  originPluginId: string | null;
  visibility: ThreadVisibility;
  status?: ThreadStatus;
}

export interface ThreadMetadataUpdate {
  title?: string | null;
  sectionId?: string | null;
  parentThreadId?: string | null;
  /** #288 rebind: the new binding row (change kind "environment-changed"). */
  environmentId?: string | null;
  /** #351: explicit selection overrides (change kind "execution-changed"). */
  modelOverride?: string | null;
  reasoningLevelOverride?: string | null;
  visibility?: ThreadVisibility;
  lastReadAt?: number | null;
  status?: ThreadStatus;
  /**
   * #477 flip guard: apply the write only while the row still carries this
   * status. The dispatch flips race the agent DO's terminal-turn settlement
   * (settleControlPlaneRowAfterTerminalTurn) — an instant turn seals before
   * the flip runs, and an unguarded flip would resurrect `active` over the
   * settlement's `idle`, re-arming the stuck-Working face.
   */
  expectedStatus?: ThreadStatus;
  /**
   * #477 flip guard for the send face: the pre-dispatch status cannot
   * discriminate "not yet dispatched" from "dispatched and already settled"
   * (both read `idle`), so the flip also pins the row version it observed.
   * Any control-plane write in between (the settlement is one) shifts the
   * stamp and voids the flip.
   */
  expectedUpdatedAt?: number;
}

/** Rows stand as they are after the (possibly guarded-away) write. */
export interface ThreadUpdateResult {
  row: ThreadRecord;
  changedKinds: string[];
}

export interface ReplaceThreadTabsArgs {
  threadId: string;
  expectedRevision: number;
  tabs: ThreadTab[];
}

export type TabsReplaceResult =
  { outcome: "stored"; stored: ThreadTabsResponse } | { outcome: "conflict"; revision: number };

/**
 * The pending badge state folded from an AgentDO journal position.
 * pendingSince = createdAt of the earliest unresolved interaction (null
 * clears the badge); foldSeq = the journal seq the values were folded from.
 */
export interface PendingPushInput {
  pendingSince: number | null;
  foldSeq: number;
}

export interface PendingPushResult {
  /** "stale" = a late out-of-order retry landed nowhere (seq not ahead). */
  outcome: "applied" | "stale";
  row: ThreadRecord;
}

export interface ThreadsRepo {
  get(threadId: string): Promise<ThreadRecord | null>;
  list(filters: ThreadListFilters): Promise<ThreadListRecord[]>;
  /**
   * #486: distinct stored model overrides across live threads — the
   * selected-only pool seeds for stored selections the catalog no longer
   * declares.
   */
  listStoredModelOverrides(providerId?: string): Promise<string[]>;
  countNonDeletedChildren(parentThreadId: string): Promise<number>;
  /** bb resolveParentDepth semantics: chain node count including self. */
  hierarchyDepth(threadId: string): Promise<number>;
  create(args: CreateThreadArgs): Promise<ThreadRecord>;
  /** bb change-kind mapping + #477 guards; null when the thread is missing. */
  update(threadId: string, update: ThreadMetadataUpdate): Promise<ThreadUpdateResult | null>;
  /** Idempotent: an already-deleted (or missing) thread answers null. */
  markDeleted(threadId: string): Promise<ThreadRecord | null>;
  /** bb pinThread: pinSortKey = prefirst order key ("!" < any alphanumeric). */
  pin(threadId: string, pinnedAt: number | null): Promise<ThreadRecord | null>;
  unpin(threadId: string): Promise<ThreadRecord | null>;
  setArchived(threadId: string, archived: boolean): Promise<ThreadRecord | null>;
  /**
   * #591 pending push-write: monotonic CAS on pendingFoldSeq — a write lands
   * only when the incoming seq is strictly ahead of the stored one, so a
   * late out-of-order retry (including a DO replay) cannot resurrect stale
   * values. Does not touch updated_at (badge metadata, not content — the
   * legacy mirror never moved thread bookkeeping either).
   */
  pushPendingState(threadId: string, input: PendingPushInput): Promise<PendingPushResult | null>;
  /**
   * #591 T8: the pending badge half of the list face — the read side of
   * pushPendingState (`pending_since IS NOT NULL`). Unknown ids (threads that
   * predate the drizzle-era control plane) answer false.
   */
  pendingBadges(threadIds: readonly string[]): Promise<Map<string, boolean>>;

  /** Missing row answers {revision: 0, tabs: []}. */
  getTabs(threadId: string): Promise<ThreadTabsResponse>;
  /** Compare-and-set on revision (bb discipline, D1 edition). */
  replaceTabs(args: ReplaceThreadTabsArgs): Promise<TabsReplaceResult>;
}

export function createThreadsRepo(db: D1Database): ThreadsRepo {
  const drizzleDb = drizzle(db);

  const repo: ThreadsRepo = {
    async get(threadId) {
      const row = await drizzleDb.select().from(threads).where(eq(threads.id, threadId)).get();
      return row ?? null;
    },

    async list(filters) {
      const conditions = [isNull(threads.deletedAt)];
      if (filters.visibility !== undefined) {
        conditions.push(eq(threads.visibility, filters.visibility));
      } else if (!filters.includeHidden) {
        conditions.push(eq(threads.visibility, "visible"));
      }
      if (filters.projectId !== undefined) {
        conditions.push(eq(threads.projectId, filters.projectId));
      }
      if (filters.parentThreadId !== undefined) {
        conditions.push(eq(threads.parentThreadId, filters.parentThreadId));
      }
      if (filters.sourceThreadId !== undefined) {
        conditions.push(eq(threads.sourceThreadId, filters.sourceThreadId));
      }
      if (filters.sectionId !== undefined) {
        conditions.push(eq(threads.sectionId, filters.sectionId));
      }
      if (filters.unsectioned === true) {
        conditions.push(isNull(threads.sectionId));
      }
      if (filters.archived !== undefined) {
        conditions.push(
          filters.archived ? isNotNull(threads.archivedAt) : isNull(threads.archivedAt),
        );
      }
      if (filters.hasParent !== undefined) {
        conditions.push(
          filters.hasParent ? isNotNull(threads.parentThreadId) : isNull(threads.parentThreadId),
        );
      }
      if (filters.originKind !== undefined) {
        conditions.push(eq(threads.originKind, filters.originKind));
      }
      if (filters.originPluginId !== undefined) {
        conditions.push(eq(threads.originPluginId, filters.originPluginId));
      }

      // #337 root cause: the unpinned block must order by recency (bb
      // buildActiveProjectThreadOrderBy: pinned block, then createdAt desc,
      // id desc — data/threads.ts:735-750). bb's CASE-scoped pinned keys
      // (buildPinnedThreadOrderBy) stay verbatim: NULL for unpinned rows on
      // the pinned keys, so recency decides the unpinned order.
      const orderBy =
        filters.archived === true
          ? [desc(threads.archivedAt), desc(threads.id)]
          : [
              sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN 0 ELSE 1 END ASC`,
              sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN ${threads.pinSortKey} END ASC`,
              sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN ${threads.id} END ASC`,
              desc(threads.createdAt),
              desc(threads.id),
            ];

      // #288: bb threadWithPendingInteractionBaseQuery (data/threads.ts:533-552)
      // — LEFT JOIN environments so the list face can inline the binding
      // fields (environmentHostId/Name/BranchName + display kind) per thread.
      const rows = await drizzleDb
        .select({
          thread: threads,
          environmentHostId: environments.hostId,
          environmentName: environments.name,
          environmentBranchName: environments.branchName,
          environmentIsWorktree: environments.isWorktree,
          environmentProvisionType: environments.workspaceProvisionType,
        })
        .from(threads)
        .leftJoin(environments, eq(threads.environmentId, environments.id))
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(filters.limit ?? -1)
        .offset(filters.offset ?? 0)
        .all();

      return rows.map((row) => ({
        ...row.thread,
        // Greenfield badge derivation: the mirror table's EXISTS probe is
        // replaced by the row's own pending fields (#591 ruling).
        hasPendingInteraction: row.thread.pendingSince !== null,
        environmentHostId: row.environmentHostId,
        environmentName: row.environmentName,
        environmentBranchName: row.environmentBranchName,
        environmentWorkspaceDisplayKind: resolveEnvironmentWorkspaceDisplayKind({
          environment: {
            isWorktree: row.environmentIsWorktree,
            workspaceProvisionType: row.environmentProvisionType,
          },
        }),
      }));
    },

    async listStoredModelOverrides(providerId) {
      const conditions = [isNotNull(threads.modelOverride), isNull(threads.deletedAt)];
      if (providerId !== undefined) {
        conditions.push(eq(threads.providerId, providerId));
      }
      const rows = await drizzleDb
        .selectDistinct({ modelOverride: threads.modelOverride })
        .from(threads)
        .where(and(...conditions))
        .all();
      return rows
        .map((row) => row.modelOverride)
        .filter((model): model is string => model !== null);
    },

    async countNonDeletedChildren(parentThreadId) {
      const rows = await drizzleDb
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.parentThreadId, parentThreadId), isNull(threads.deletedAt)))
        .all();
      return rows.length;
    },

    async hierarchyDepth(threadId) {
      // bb resolveParentDepth (thread-parent.ts:76-105): count chain nodes
      // including self; cycle-safe; the legacy 64 cap stays as the walk bound.
      let depth = 0;
      let currentId: string | null = threadId;
      const visited = new Set<string>();
      while (currentId !== null && depth < 64 && !visited.has(currentId)) {
        visited.add(currentId);
        const row = await drizzleDb
          .select({ parentThreadId: threads.parentThreadId })
          .from(threads)
          .where(eq(threads.id, currentId))
          .get();
        if (!row) {
          break;
        }
        depth += 1;
        currentId = row.parentThreadId;
      }
      return depth;
    },

    async create(args) {
      // bb createThread (packages/db/src/data/threads.ts:290-342) semantics:
      // the fresh row is born read (lastReadAt = now), attention clock starts
      // now, pending badge off (pendingSince NULL, fold seq 0).
      const now = Date.now();
      await drizzleDb
        .insert(threads)
        .values({
          id: args.id,
          projectId: args.projectId,
          environmentId: args.environmentId,
          providerId: args.providerId,
          modelOverride: args.modelOverride,
          reasoningLevelOverride: args.reasoningLevelOverride,
          title: args.title,
          titleFallback: args.titleFallback,
          sectionId: args.sectionId,
          status: args.status ?? "starting",
          parentThreadId: args.parentThreadId,
          sourceThreadId: args.sourceThreadId,
          originKind: args.originKind,
          originPluginId: args.originPluginId,
          visibility: args.visibility,
          archivedAt: null,
          pinnedAt: null,
          pinSortKey: null,
          deletedAt: null,
          lastReadAt: now,
          latestAttentionAt: now,
          pendingSince: null,
          pendingFoldSeq: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const row = await repo.get(args.id);
      if (!row) {
        throw new Error(`thread ${args.id} missing after insert`);
      }
      return row;
    },

    async update(threadId, update) {
      const current = await repo.get(threadId);
      if (!current) {
        return null;
      }
      // bb updateThread change-kind mapping (packages/db/src/data/threads.ts:
      // 1610-1677); returns the changed kinds for broadcasting.
      const changedKinds: string[] = [];
      if (update.title !== undefined) {
        changedKinds.push("title-changed");
      }
      if (update.sectionId !== undefined && !changedKinds.includes("title-changed")) {
        changedKinds.push("title-changed");
      }
      if (update.visibility !== undefined && !changedKinds.includes("title-changed")) {
        changedKinds.push("title-changed");
      }
      if (update.parentThreadId !== undefined) {
        changedKinds.push("parent-changed");
      }
      if (update.environmentId !== undefined) {
        changedKinds.push("environment-changed");
      }
      if (update.modelOverride !== undefined || update.reasoningLevelOverride !== undefined) {
        changedKinds.push("execution-changed");
      }
      if (update.lastReadAt !== undefined) {
        changedKinds.push("read-state-changed");
      }
      const guardConditions = [eq(threads.id, threadId)];
      if (update.expectedStatus !== undefined) {
        guardConditions.push(eq(threads.status, update.expectedStatus));
      }
      if (update.expectedUpdatedAt !== undefined) {
        guardConditions.push(eq(threads.updatedAt, update.expectedUpdatedAt));
      }
      await drizzleDb
        .update(threads)
        .set({
          updatedAt: Date.now(),
          ...(update.title !== undefined ? { title: update.title } : {}),
          ...(update.sectionId !== undefined ? { sectionId: update.sectionId } : {}),
          ...(update.parentThreadId !== undefined ? { parentThreadId: update.parentThreadId } : {}),
          ...(update.environmentId !== undefined ? { environmentId: update.environmentId } : {}),
          ...(update.modelOverride !== undefined ? { modelOverride: update.modelOverride } : {}),
          ...(update.reasoningLevelOverride !== undefined
            ? { reasoningLevelOverride: update.reasoningLevelOverride }
            : {}),
          ...(update.visibility !== undefined ? { visibility: update.visibility } : {}),
          ...(update.lastReadAt !== undefined ? { lastReadAt: update.lastReadAt } : {}),
          ...(update.status !== undefined ? { status: update.status } : {}),
        })
        .where(and(...guardConditions))
        .run();
      // A guard that filtered the write still returns the row as it now
      // stands — the send route detects the lost race via row.status.
      const row = await repo.get(threadId);
      if (!row) {
        throw new Error(`thread ${threadId} missing after update`);
      }
      return { row, changedKinds };
    },

    async markDeleted(threadId) {
      const current = await repo.get(threadId);
      if (current?.deletedAt !== null) {
        return null;
      }
      await drizzleDb
        .update(threads)
        .set({ deletedAt: Date.now(), updatedAt: Date.now() })
        .where(eq(threads.id, threadId))
        .run();
      return await repo.get(threadId);
    },

    async pin(threadId, pinnedAt) {
      const current = await repo.get(threadId);
      if (!current) {
        return null;
      }
      if (current.pinnedAt !== null) {
        return current;
      }
      const at = pinnedAt ?? Date.now();
      // Order key sorts before every existing pinned key: "!" < any
      // alphanumeric.
      await drizzleDb
        .update(threads)
        .set({
          pinnedAt: at,
          pinSortKey: `!${at.toString(36)}`,
          updatedAt: Date.now(),
        })
        .where(eq(threads.id, threadId))
        .run();
      return await repo.get(threadId);
    },

    async unpin(threadId) {
      const current = await repo.get(threadId);
      if (!current) {
        return null;
      }
      if (current.pinnedAt === null) {
        return current;
      }
      await drizzleDb
        .update(threads)
        .set({ pinnedAt: null, pinSortKey: null, updatedAt: Date.now() })
        .where(eq(threads.id, threadId))
        .run();
      return await repo.get(threadId);
    },

    async setArchived(threadId, archived) {
      const current = await repo.get(threadId);
      if (!current) {
        return null;
      }
      if (archived && current.archivedAt !== null) {
        return current;
      }
      if (!archived && current.archivedAt === null) {
        return current;
      }
      await drizzleDb
        .update(threads)
        .set({ archivedAt: archived ? Date.now() : null, updatedAt: Date.now() })
        .where(eq(threads.id, threadId))
        .run();
      return await repo.get(threadId);
    },

    async pushPendingState(threadId, input) {
      const result = await drizzleDb
        .update(threads)
        .set({ pendingSince: input.pendingSince, pendingFoldSeq: input.foldSeq })
        .where(and(eq(threads.id, threadId), lt(threads.pendingFoldSeq, input.foldSeq)))
        .run();
      const row = await repo.get(threadId);
      if (!row) {
        return null;
      }
      return { outcome: result.meta.changes > 0 ? "applied" : "stale", row };
    },

    async pendingBadges(threadIds) {
      if (threadIds.length === 0) {
        return new Map();
      }
      const rows = await drizzleDb
        .select({ id: threads.id, pendingSince: threads.pendingSince })
        .from(threads)
        .where(inArray(threads.id, [...threadIds]))
        .all();
      return new Map(rows.map((row) => [row.id, row.pendingSince !== null]));
    },

    async getTabs(threadId) {
      // thread_tabs (bb data/thread-tabs.ts:14-69): GET of a missing row
      // answers the empty revision-0 face.
      const row = await drizzleDb
        .select()
        .from(threadTabs)
        .where(eq(threadTabs.threadId, threadId))
        .get();
      if (!row) {
        return { revision: 0, tabs: [] };
      }
      return { revision: row.revision, tabs: JSON.parse(row.tabsJson) as ThreadTab[] };
    },

    async replaceTabs(args) {
      const now = Date.now();
      const tabsJson = JSON.stringify(args.tabs);
      // Compare-and-set on revision survives any future executor change (bb
      // comment, data/threads.ts:1942-1944 — same discipline, D1 edition).
      const update = await drizzleDb
        .update(threadTabs)
        .set({
          tabsJson,
          revision: sql`${threadTabs.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(threadTabs.threadId, args.threadId),
            eq(threadTabs.revision, args.expectedRevision),
          ),
        )
        .run();
      if (update.meta.changes > 0) {
        return { outcome: "stored", stored: await repo.getTabs(args.threadId) };
      }
      const existing = await drizzleDb
        .select({ revision: threadTabs.revision })
        .from(threadTabs)
        .where(eq(threadTabs.threadId, args.threadId))
        .get();
      if (!existing) {
        if (args.expectedRevision !== 0) {
          return { outcome: "conflict", revision: 0 };
        }
        await drizzleDb
          .insert(threadTabs)
          .values({ threadId: args.threadId, tabsJson, revision: 1, updatedAt: now })
          .run();
        return { outcome: "stored", stored: { revision: 1, tabs: args.tabs } };
      }
      return { outcome: "conflict", revision: existing.revision };
    },
  };

  return repo;
}
