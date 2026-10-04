import type { PendingInteractionRow } from "@cap/protocol";
import {
  pendingInteractionSchema,
  type PendingInteraction,
} from "../contract/domain/pending-interactions.js";
import { ApiError } from "../shared/api-error.js";

/**
 * Journal fold → bb public PendingInteraction (#225). The SPA parses these
 * routes leniently (transport.readJson) but renders from the field names, so
 * the projection is validated against the bb provider row before it leaves
 * the server — bb parseListRows posture: one unparseable row skips out of a
 * list, and is a hard error on the single-row faces (producer bug, not a
 * client concern).
 */
export function toPublicPendingInteraction(row: PendingInteractionRow): PendingInteraction {
  return pendingInteractionSchema.parse({
    id: row.id,
    threadId: row.threadId,
    status: row.status,
    statusReason: row.statusReason,
    createdAt: row.createdAt,
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt } : {}),
    resolvedAt: row.resolvedAt,
    turnId: row.turnId,
    providerId: row.origin.providerId,
    providerThreadId: row.origin.providerThreadId,
    providerRequestId: row.origin.providerRequestId,
    payload: row.payload,
    resolution: row.resolution,
  });
}

/** bb listPendingThreadInteractions: statuses pending|resolving — the fold
 * has no resolving state (the DO resolves synchronously), so pending only. */
export function toPublicPendingInteractions(
  rows: readonly PendingInteractionRow[],
): PendingInteraction[] {
  const interactions: PendingInteraction[] = [];
  for (const row of rows) {
    if (row.status !== "pending") continue;
    try {
      interactions.push(toPublicPendingInteraction(row));
    } catch (error) {
      console.error("skipping unparseable pending interaction", row.id, error);
    }
  }
  return interactions;
}

/** bb getThreadInteraction: unknown id or another thread's row → 404. */
export function requirePublicInteractionRow(
  rows: readonly PendingInteractionRow[],
  threadId: string,
  interactionId: string,
): PendingInteractionRow {
  const row = rows.find((candidate) => candidate.id === interactionId);
  if (row?.threadId !== threadId) {
    throw new ApiError({
      status: 404,
      code: "invalid_request",
      message: "Pending interaction not found",
    });
  }
  return row;
}
