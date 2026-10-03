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

export interface HostUpdate {
  name?: string;
  maxPermissionMode?: HostDbRow["maxPermissionMode"];
  destroyedAt?: number | null;
  lastSeenAt?: number;
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
  binds.push(hostId);
  await env.DB.prepare(`UPDATE hosts SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return getHostRow(env, hostId);
}
