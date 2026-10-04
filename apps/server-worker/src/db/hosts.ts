import type { Env } from "../env.js";
import { toHostDbRow, type HostDbRow } from "./rows.js";

export async function getHostRow(env: Env, hostId: string): Promise<HostDbRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, type, connect_machine_id, max_permission_mode, destroyed_at, last_seen_at, last_rejected_protocol_version, created_at, updated_at FROM hosts WHERE id = ?",
  )
    .bind(hostId)
    .first();
  return row ? toHostDbRow(row) : null;
}

export async function listNonDestroyedHostRows(env: Env): Promise<HostDbRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, type, connect_machine_id, max_permission_mode, destroyed_at, last_seen_at, last_rejected_protocol_version, created_at, updated_at FROM hosts WHERE destroyed_at IS NULL ORDER BY created_at ASC, id ASC",
  ).all();
  return results.map(toHostDbRow);
}

/**
 * #49 bridge: the daemon face (daemon-service enroll + session/open) calls
 * this so the control-plane registry lists a host once its daemon attaches.
 * Insert-if-absent; an existing row only refreshes presence (last_seen_at)
 * and clears a stale protocol rejection (bb session/open stamps the rejected
 * version on mismatch and clears it on success, internal/session.ts:52-98) —
 * name/type/ceiling stay owner-controlled (bb upsertHost keeps an existing
 * row's name, data/hosts.ts:70-91, so a daemon hostname change or re-dial
 * never clobbers a rename), and a destroyed host is never resurrected by a
 * re-attach (bb keeps deletion explicit).
 */
export async function upsertAttachedHost(
  env: Env,
  hostId: string,
  info?: { hostName?: string | null; clearRejected?: boolean },
): Promise<void> {
  const now = Date.now();
  // bb inserts the daemon's self-reported name on first sight only
  // (internal/session.ts:93); with no name reported (raw-rig handshakes) the
  // hostId stays the display fallback.
  const name = typeof info?.hostName === "string" && info.hostName !== "" ? info.hostName : hostId;
  // bb: enroll's upsert preserves the rejection (data/hosts.ts:84 keeps
  // existing columns), only a successful open clears it (internal/session.ts:96-98).
  const clearRejected = info?.clearRejected === true ? ", last_rejected_protocol_version = NULL" : "";
  await env.DB.prepare(
    `INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at,
                        last_seen_at, last_rejected_protocol_version, created_at, updated_at)
     VALUES (?, ?, 'persistent', NULL, 'full', NULL, ?, NULL, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at${clearRejected}
     WHERE hosts.destroyed_at IS NULL`,
  )
    .bind(hostId, name, now, now, now)
    .run();
}

export interface HostUpdate {
  name?: string;
  maxPermissionMode?: HostDbRow["maxPermissionMode"];
  destroyedAt?: number | null;
  lastSeenAt?: number;
  lastRejectedProtocolVersion?: number | null;
}

export async function updateHostRow(
  env: Env,
  hostId: string,
  update: HostUpdate,
): Promise<HostDbRow | null> {
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [Date.now()];
  if (update.name !== undefined) {
    sets.push("name = ?");
    binds.push(update.name);
  }
  if (update.maxPermissionMode !== undefined) {
    sets.push("max_permission_mode = ?");
    binds.push(update.maxPermissionMode);
  }
  if (update.destroyedAt !== undefined) {
    sets.push("destroyed_at = ?");
    binds.push(update.destroyedAt);
  }
  if (update.lastSeenAt !== undefined) {
    sets.push("last_seen_at = ?");
    binds.push(update.lastSeenAt);
  }
  if (update.lastRejectedProtocolVersion !== undefined) {
    sets.push("last_rejected_protocol_version = ?");
    binds.push(update.lastRejectedProtocolVersion);
  }
  binds.push(hostId);
  await env.DB.prepare(`UPDATE hosts SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return getHostRow(env, hostId);
}
