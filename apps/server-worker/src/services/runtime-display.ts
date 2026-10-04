import type { Env } from "../env.js";
import type { ThreadDbRow } from "../db/rows.js";
import { getThreadHierarchyDepth } from "../db/control-plane.js";
import type { ThreadListEntry, ThreadRuntimeState } from "../contract/domain/thread.js";
import type { ThreadResponse } from "../contract/api/threads.js";

/** bb thread-parent.ts:6. */
export const MAX_THREAD_HIERARCHY_DEPTH = 4;

/**
 * bb resolveThreadRuntimeStateFromLatestSession (thread-runtime-display.ts:
 * 194-221) reduced to the M0 host topology: no daemon sessions exist yet
 * (lane #30), so an active thread has no connected host and displays
 * "waiting-for-host"; every other status echoes itself verbatim as bb does
 * for non-active threads (thread-runtime-display.ts:96-108). The DO-side
 * grace window (hub markDaemonDisconnected) is carried for #30 to wire in.
 */
export function resolveThreadRuntimeState(row: ThreadDbRow): ThreadRuntimeState {
  if (row.status === "active") {
    return { displayStatus: "waiting-for-host", hostReconnectGraceExpiresAt: null };
  }
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
 * environments (family OUT) → environment* fields null with display kind
 * "other"; activity counters zero (background tasks are a daemon surface).
 */
export function toThreadListEntry(
  row: ThreadDbRow & { hasPendingInteraction: boolean },
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
    environmentHostId: null,
    environmentName: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "other",
  };
}
