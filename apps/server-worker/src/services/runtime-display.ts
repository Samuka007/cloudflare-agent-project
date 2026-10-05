import type { Env } from "../env.js";
import type { ThreadDbRow } from "../db/rows.js";
import { getEnvironmentRow } from "../db/environments.js";
import { getThreadHierarchyDepth, type ThreadListRow } from "../db/control-plane.js";
import type { ThreadListEntry, ThreadRuntimeState } from "../contract/domain/thread.js";
import type { ThreadResponse } from "../contract/api/threads.js";
import { daemonConnected } from "./host-records.js";

/** bb thread-parent.ts:6. */
export const MAX_THREAD_HIERARCHY_DEPTH = 4;

/**
 * The thread runtime display echoes the row's execution status verbatim
 * (bb thread-runtime-display.ts:96-108 for non-active statuses) EXCEPT for
 * the §9.3 row-4 suspension face below. #148 (streaming contract §9.3)
 * removed the #194 S2 host-aware branch for open turns: under #73 execution
 * suspension an in-flight turn keeps streaming pure chat while the host is
 * down (host tools settle fast with the offline placeholder) — so
 * active+host-down must read "active", never a banner preempting the
 * streaming surface (rows 1-3; thr_jk45qe4786 regression guard). #291 lands
 * row 4 — the post-turn honest host face: a bound host down with no open
 * turn renders bb's host-reconnecting face, reconciled with 消息可发 (the
 * pinned SPA keeps its composer in queue mode on that status). The
 * daemon-service DO hostLiveness RPC is the truth source, read-time like bb
 * toHostStatus; the hub grace state machine stays out of the display (the
 * 30s active-work grace governs the pre-#148 waiting-for-host design, not
 * the half-stop face — see host-broadcast.test.ts).
 */
export function resolveThreadRuntimeState(row: ThreadDbRow): ThreadRuntimeState {
  return { displayStatus: row.status, hostReconnectGraceExpiresAt: null };
}

/**
 * Statuses that admit the §9.3 row-4 face. `active`/`stopping` still have an
 * open turn — rows 1-3 forbid the banner there (#148, preserved verbatim);
 * everything else has no active turn, so a down host is the honest display.
 */
function admitsHostFace(status: ThreadDbRow["status"]): boolean {
  return status !== "active" && status !== "stopping";
}

/**
 * #291 execution-suspension display face (streaming contract §9.3 row 4,
 * CONTEXT.md 执行悬置): a thread with no active turn whose bound host is
 * offline renders bb's `host-reconnecting` runtime status — the pinned SPA
 * turns that into the "Host disconnected. Waiting for reconnection..."
 * banner (pending tone) while keeping the composer in queue mode, which is
 * exactly the #73 Q1 half-stop ruling: 消息可发 (the queued send starts a
 * pure-chat turn), 模型可回, Host Execution rejected with the honest
 * placeholder rows. `waiting-for-host` is deliberately never emitted: the
 * pinned SPA locks that face's composer to stop-only, contradicting 消息可发.
 * The §9.3 banner legality gate stays absolute: an active/stopping row — or
 * one without a fleet binding (environmentId null: the #288 zero-D1
 * deployment default) — always echoes its execution status.
 */
export async function resolveThreadRuntimeStateAsync(
  env: Env,
  row: ThreadDbRow,
): Promise<ThreadRuntimeState> {
  if (row.environmentId === null || !admitsHostFace(row.status)) {
    return resolveThreadRuntimeState(row);
  }
  const environment = await getEnvironmentRow(env, row.environmentId);
  if (environment === null) {
    return resolveThreadRuntimeState(row);
  }
  if (await daemonConnected(env, environment.hostId)) {
    return resolveThreadRuntimeState(row);
  }
  return { displayStatus: "host-reconnecting", hostReconnectGraceExpiresAt: null };
}

/** bb toPublicThread (thread-runtime-display.ts:143-166). */
export function toPublicThread(row: ThreadDbRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    environmentId: row.environmentId,
    providerId: row.providerId,
    title: row.title,
    titleFallback: row.titleFallback,
    sectionId: row.sectionId,
    status: row.status,
    parentThreadId: row.parentThreadId,
    sourceThreadId: row.sourceThreadId,
    originKind: row.originKind,
    originPluginId: row.originPluginId,
    visibility: row.visibility,
    archivedAt: row.archivedAt,
    pinnedAt: row.pinnedAt,
    deletedAt: row.deletedAt,
    lastReadAt: row.lastReadAt,
    latestAttentionAt: row.latestAttentionAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function toThreadResponseWithSpawnCheck(
  env: Env,
  row: ThreadDbRow,
): Promise<ThreadResponse> {
  const depth = await getThreadHierarchyDepth(env, row.id);
  return {
    ...(await toThreadResponseAsync(env, row)),
    canSpawnChild: depth < MAX_THREAD_HIERARCHY_DEPTH,
  };
}

/** bb ThreadResponse assembly with the #291 host face on the runtime leg. */
async function toThreadResponseAsync(env: Env, row: ThreadDbRow): Promise<ThreadResponse> {
  return {
    ...toPublicThread(row),
    runtime: await resolveThreadRuntimeStateAsync(env, row),
    activeBackgroundAgentCount: 0,
    canSpawnChild: true,
  };
}

/**
 * bb ThreadListEntry assembly (thread-runtime-display.ts:441-463). M0: no
 * provisioning — the environment* fields come from the #288 binding join;
 * activity counters zero (background tasks are a daemon surface).
 */
function toThreadListEntry(row: ThreadListRow): ThreadListEntry {
  return {
    ...toPublicThread(row),
    runtime: resolveThreadRuntimeState(row),
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    pinSortKey: row.pinSortKey,
    hasPendingInteraction: row.hasPendingInteraction,
    environmentHostId: row.environmentHostId,
    environmentName: row.environmentName,
    environmentBranchName: row.environmentBranchName,
    environmentWorkspaceDisplayKind: row.environmentWorkspaceDisplayKind,
  };
}

/**
 * #291 list-face assembly: the suspension banner also rides the sidebar rows
 * ("List rows render status/runtime badges"), so the batch resolves host
 * liveness once per DISTINCT bound host and maps every row against the cache
 * — one DO round trip per host per list read, never per thread. Rows without
 * a binding join host (dangling environment, the zero-D1 default) skip the
 * face and echo.
 */
export async function toThreadListEntries(
  env: Env,
  rows: readonly ThreadListRow[],
): Promise<ThreadListEntry[]> {
  const hostIds = new Set<string>();
  for (const row of rows) {
    if (row.environmentHostId !== null && admitsHostFace(row.status)) {
      hostIds.add(row.environmentHostId);
    }
  }
  const liveness = new Map<string, boolean>();
  await Promise.all(
    [...hostIds].map(async (hostId) => {
      liveness.set(hostId, await daemonConnected(env, hostId));
    }),
  );
  return rows.map((row) => {
    if (
      row.environmentHostId === null ||
      !admitsHostFace(row.status) ||
      liveness.get(row.environmentHostId) !== false
    ) {
      return toThreadListEntry(row);
    }
    return {
      ...toThreadListEntry(row),
      runtime: { displayStatus: "host-reconnecting", hostReconnectGraceExpiresAt: null },
    };
  });
}
