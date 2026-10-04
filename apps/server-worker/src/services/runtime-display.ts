import type { Env } from "../env.js";
import type { ThreadDbRow } from "../db/rows.js";
import { getThreadHierarchyDepth } from "../db/control-plane.js";
import type { ThreadListEntry, ThreadRuntimeState } from "../contract/domain/thread.js";
import type { ThreadResponse } from "../contract/api/threads.js";
import type { DaemonServiceDO } from "@cap/daemon-service";

/** bb thread-parent.ts:6. */
export const MAX_THREAD_HIERARCHY_DEPTH = 4;

/**
 * M0 host topology (PM ruling on the #194 S2 ticket): one daemon client per
 * user and every thread's session executes on that single attached host —
 * the identity the command dispatch already pins (seam/agent-do.ts
 * `ORCHESTRATOR_HOST_ID ?? "local"`; a threads.hostId column stays an M2
 * multi-host revisit). The runtime display is therefore ONE host fact per
 * request, not a per-thread session lookup: bb's latest-session join
 * (thread-runtime-display.ts:194-221) collapses into this snapshot.
 */
export interface HostRuntimeSnapshot {
  /**
   * The thread-serving daemon's live socket (daemon-service DO hostLiveness:
   * current session + open WebSocket) — routes/hosts.ts daemonConnected's
   * exact reading.
   */
  connected: boolean;
  /**
   * Non-null while the hub's active-work reconnect grace is running (bb
   * pendingDaemonDisconnects, hub markDaemonDisconnected): the SPA shows
   * "host-reconnecting" and counts down to this instant before flipping to
   * "waiting-for-host".
   */
  graceExpiresAt: number | null;
}

/**
 * The liveness read behind the thread display (bb entity-lookup.ts:71-80 +
 * thread-runtime-display.ts:116-129), collapsed to at most one DO round trip
 * pair per request: liveness from the daemon-service DO, the grace window
 * from the hub. Every failure degrades honestly — a failed RPC reads "not
 * connected" (routes/hosts.ts daemonConnected posture) and a failed grace
 * read reads "no grace"; neither can fake a connected host.
 */
export async function resolveHostRuntimeSnapshot(env: Env): Promise<HostRuntimeSnapshot> {
  const hostId = env.ORCHESTRATOR_HOST_ID ?? "local";
  const namespace = env.DAEMON_SERVICE;
  if (namespace === undefined) {
    return { connected: false, graceExpiresAt: null };
  }
  let connected = false;
  try {
    const stub = namespace.get(namespace.idFromName(hostId)) as DurableObjectStub & DaemonServiceDO;
    connected = (await stub.hostLiveness({ hostId })).connected;
  } catch {
    connected = false;
  }
  if (connected) {
    // markDaemonConnected erases the grace entry, so a connected host cannot
    // be mid-grace; skip the second RPC (bb registerDaemon ordering).
    return { connected, graceExpiresAt: null };
  }
  try {
    const hub = env.HUB.get(env.HUB.idFromName("hub")) as DurableObjectStub & {
      getDaemonDisconnectState(args: {
        hostId: string;
      }): Promise<{ inGrace: boolean; graceExpiresAt: number | null }>;
    };
    const state = await hub.getDaemonDisconnectState({ hostId });
    return { connected, graceExpiresAt: state.inGrace ? state.graceExpiresAt : null };
  } catch {
    return { connected, graceExpiresAt: null };
  }
}

/**
 * bb resolveThreadRuntimeStateFromLatestSession (thread-runtime-display.ts:
 * 194-221) reduced to the M0 host topology — L2 three states for an active
 * thread: the attached host connected echoes "active" (no banner); a drop
 * inside the hub's 30s reconnect grace reads "host-reconnecting" with the
 * countdown instant; past it, "waiting-for-host". Every other status echoes
 * itself verbatim as bb does for non-active threads
 * (thread-runtime-display.ts:96-108).
 */
export function resolveThreadRuntimeState(
  row: ThreadDbRow,
  host: HostRuntimeSnapshot,
): ThreadRuntimeState {
  if (row.status === "active") {
    if (host.connected) {
      return { displayStatus: "active", hostReconnectGraceExpiresAt: null };
    }
    if (host.graceExpiresAt !== null) {
      return {
        displayStatus: "host-reconnecting",
        hostReconnectGraceExpiresAt: host.graceExpiresAt,
      };
    }
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
export function toThreadResponse(row: ThreadDbRow, host: HostRuntimeSnapshot): ThreadResponse {
  return {
    ...toPublicThread(row),
    runtime: resolveThreadRuntimeState(row, host),
    activeBackgroundAgentCount: 0,
    canSpawnChild: true,
  };
}

export async function toThreadResponseWithSpawnCheck(
  env: Env,
  row: ThreadDbRow,
): Promise<ThreadResponse> {
  const [depth, host] = await Promise.all([
    getThreadHierarchyDepth(env, row.id),
    resolveHostRuntimeSnapshot(env),
  ]);
  return {
    ...toThreadResponse(row, host),
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
  host: HostRuntimeSnapshot,
): ThreadListEntry {
  return {
    ...toPublicThread(row),
    runtime: resolveThreadRuntimeState(row, host),
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
