import type { Env } from "../env";

/**
 * The hosts-registry liveness stamp, server side (db campaign T7, #599).
 *
 * The daemon-service DO's heartbeat used to UPDATE the hosts table directly
 * over the shared HOSTS_DB binding (bb markHostSeen port) — making the table
 * layout a cross-worker ABI. Now the stamp rides the ControlPlane RPC face
 * and the ≥30s SQL throttle is THIS module's policy (#591 ruling: markSeen
 * 节流内聚 Hosts repo): the daemon side fires per heartbeat, the server
 * decides which stamps land, and the 5s heartbeat can never burn the
 * registry's write quota (staleness ceiling while connected stays this
 * window + heartbeat jitter).
 *
 * T9 (#601) moves the write into HostsRepository.markSeen (drizzle); the
 * face does not move.
 */

/** bb stamps per WS message into its local SQLite; the port projects the 5s
 * heartbeat into the registry at most once per window (#62). */
export const LIVENESS_PROJECTION_INTERVAL_MS = 30_000;

export async function markHostSeenInRegistry(env: Env, hostId: string, at: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE hosts SET last_seen_at = ?, updated_at = ? WHERE id = ? AND (last_seen_at IS NULL OR ? - last_seen_at >= ?)",
  )
    .bind(at, at, hostId, at, LIVENESS_PROJECTION_INTERVAL_MS)
    .run();
}
