/**
 * #62 hosts-registry liveness projection — the port's `markHostSeen`
 * (bb packages/db/src/data/hosts.ts:113-122): the daemon's heartbeat
 * refreshes the control-plane registry's last_seen_at, so /hosts can show
 * "last seen" truth instead of a stamp frozen at attach time.
 *
 * bb refreshes on every daemon WS message into its local SQLite
 * (apps/server/src/ws/daemon-protocol.ts:129-136 → sessions.ts:203-223);
 * this port projects the dedicated heartbeat frame into the registry D1 and
 * self-throttles in SQL — the UPDATE lands only when the stored stamp is at
 * least `minIntervalMs` old — so a 5s heartbeat cannot burn the registry's
 * write quota while last_seen_at still advances once per window.
 *
 * The hosts table contract is owned by apps/server-worker
 * (migrations/0001_control_plane.sql, #26); rows are created by the #49
 * attach bridge's upsertAttachedHost. This module only ever UPDATEs: a host
 * that never attached simply has no row to stamp.
 */
export async function markHostSeen(
  db: D1Database,
  hostId: string,
  at: number,
  minIntervalMs: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE hosts
       SET last_seen_at = ?, updated_at = ?
       WHERE id = ? AND (last_seen_at IS NULL OR ? - last_seen_at >= ?)`,
    )
    .bind(at, at, hostId, at, minIntervalMs)
    .run();
}
