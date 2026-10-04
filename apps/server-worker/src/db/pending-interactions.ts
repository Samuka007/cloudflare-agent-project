import type { Env } from "../env.js";
import type { PendingInteractionRow } from "@cap/protocol";

/**
 * pending_interactions mirror (#225). The D1 table exists as the join source
 * for the thread-list `hasPendingInteraction` EXISTS probe (migration comment:
 * "tables that later milestones need for joins"). Row truth stays in the
 * per-thread agent DO journal — this mirror self-heals whenever the
 * interactions routes read the fold, so the sidebar badge is correct after
 * any thread-detail visit; live updates ride the interactions-changed
 * metadata patch instead. Best-effort: a mirror failure never fails a read.
 */
export async function mirrorPendingInteraction(
  env: Env,
  row: PendingInteractionRow,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO pending_interactions
         (id, thread_id, origin_kind, turn_id, provider_id, provider_thread_id,
          provider_request_id, status, payload, resolution, status_reason,
          created_at, expires_at, resolved_at, updated_at)
       VALUES (?, ?, 'provider', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status,
         payload = excluded.payload,
         resolution = excluded.resolution,
         status_reason = excluded.status_reason,
         expires_at = excluded.expires_at,
         resolved_at = excluded.resolved_at,
         updated_at = excluded.updated_at`,
    )
      .bind(
        row.id,
        row.threadId,
        row.turnId,
        row.origin.providerId,
        row.origin.providerThreadId,
        row.origin.providerRequestId,
        row.status,
        JSON.stringify(row.payload),
        row.resolution === null ? null : JSON.stringify(row.resolution),
        row.statusReason,
        row.createdAt,
        row.expiresAt,
        row.resolvedAt,
        row.resolvedAt ?? Date.now(),
      )
      .run();
  } catch (error) {
    console.error("pending-interactions mirror sync failed", error);
  }
}
