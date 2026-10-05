import type { Env } from "../env.js";
import type { ThreadDbRow } from "../db/rows.js";
import { getThreadHierarchyDepth, type ThreadListRow } from "../db/control-plane.js";
import type { ThreadListEntry, ThreadRuntimeState } from "../contract/domain/thread.js";
import type { ThreadResponse } from "../contract/api/threads.js";

/** bb thread-parent.ts:6. */
export const MAX_THREAD_HIERARCHY_DEPTH = 4;

/**
 * The thread runtime display echoes the row's execution status verbatim (bb
 * thread-runtime-display.ts:96-108 for non-active statuses). #148 (streaming
 * contract §9.3) removes the #194 S2 host-aware branch entirely: the host
 * banner's only legitimate source is "no active turn ∧ runtime host offline",
 * and under #73 execution suspension an in-flight turn keeps streaming pure
 * chat while the host is down (host tools settle fast with the offline
 * placeholder) — so active+host-down must read "active", never a
 * reconnecting/waiting banner preempting the streaming surface. The post-turn
 * honest host face (§9.3 row 4) is the bb-side S6 slice's to land together
 * with its SPA follow-up queue/submit gate, reconciled with 消息可发; until
 * then no thread display surface consumes host liveness (the daemon-service
 * DO hostLiveness RPC and the hub grace state machine remain for /hosts and
 * the S6 slice — see host-broadcast.test.ts).
 */
export function resolveThreadRuntimeState(row: ThreadDbRow): ThreadRuntimeState {
  return { displayStatus: row.status, hostReconnectGraceExpiresAt: null };
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

/** bb ThreadResponse assembly (thread-runtime-display.ts:248-264). */
export function toThreadResponse(row: ThreadDbRow): ThreadResponse {
  return {
    ...toPublicThread(row),
    runtime: resolveThreadRuntimeState(row),
    activeBackgroundAgentCount: 0,
    canSpawnChild: true,
  };
}

export async function toThreadResponseWithSpawnCheck(
  env: Env,
  row: ThreadDbRow,
): Promise<ThreadResponse> {
  const depth = await getThreadHierarchyDepth(env, row.id);
  return {
    ...toThreadResponse(row),
    canSpawnChild: depth < MAX_THREAD_HIERARCHY_DEPTH,
  };
}

/**
 * bb ThreadListEntry assembly (thread-runtime-display.ts:441-463). M0: no
 * provisioning — the environment* fields come from the #288 binding join;
 * activity counters zero (background tasks are a daemon surface).
 */
export function toThreadListEntry(
  row: ThreadListRow,
): ThreadListEntry {
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
