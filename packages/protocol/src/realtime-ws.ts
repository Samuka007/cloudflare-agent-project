import { z } from "zod";
import { pendingInteractionStatusSchema } from "./pending-interactions.js";

/**
 * Realtime fan-out WebSocket (`/ws`), bb-shaped.
 *
 * Frozen from bb archaeology (apps/app/src/lib/ws.ts + packages/domain/src/
 * change-kinds.ts): the SPA keeps a single reconnecting socket to `/ws`, sends
 * ref-counted subscribe/unsubscribe messages, and consumes `changed`
 * notifications as *cache invalidation hints* — actual data is then refetched
 * over HTTP (`GET events?afterSeq=...`). We keep that model: no event payloads
 * ride this socket, so replay/idempotence stays on the HTTP event log.
 */

export const REALTIME_WS_PATH = "/ws";

/** M0-frozen subset of bb THREAD_CHANGE_KINDS; others grow additively. */
export const threadChangeKindSchema = z.enum([
  "thread-created",
  "thread-deleted",
  "events-appended",
  "status-changed",
  "title-changed",
  /** M1.5 T4: a pending interaction registered/resolved/interrupted (#94). */
  "pending-interaction",
]);
export type ThreadChangeKind = z.infer<typeof threadChangeKindSchema>;

export const realtimeSubscriptionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("thread-detail"),
      threadId: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("thread-list") }).strict(),
]);
export type RealtimeSubscriptionTarget = z.infer<typeof realtimeSubscriptionTargetSchema>;

/** Canonical target key (bb `realtimeSubscriptionTargetKey`). */
export function realtimeSubscriptionTargetKey(target: RealtimeSubscriptionTarget): string {
  return target.kind === "thread-list" ? "thread-list" : `thread-detail:${target.threadId}`;
}

export const realtimeClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("subscribe"),
      target: realtimeSubscriptionTargetSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("unsubscribe"),
      target: realtimeSubscriptionTargetSchema,
    })
    .strict(),
]);
export type RealtimeClientMessage = z.infer<typeof realtimeClientMessageSchema>;

export const realtimeThreadChangeMetadataSchema = z
  .object({
    /** Latest event-log seq at broadcast time; hints the refetch cursor. */
    latestSeq: z.number().int().min(0).optional(),
    /**
     * Pending-interaction state patch at broadcast time (bb
     * patchThreadListPendingInteractionState shape): the id + status of the
     * interaction the frame is about, null once none is pending. The SPA
     * renders the question body from its journal refetch, not from this
     * socket (no payloads ride the socket).
     */
    pendingInteraction: z
      .object({
        interactionId: z.string().min(1),
        status: pendingInteractionStatusSchema,
      })
      .nullable()
      .optional(),
  })
  .strict();
export type RealtimeThreadChangeMetadata = z.infer<typeof realtimeThreadChangeMetadataSchema>;

/** The thread-change broadcast only; acks excluded. */
export const realtimeThreadChangedSchema = z
  .object({
    type: z.literal("changed"),
    entity: z.literal("thread"),
    /** Thread id; present for every M0 change kind. */
    id: z.string().min(1),
    changes: z.array(threadChangeKindSchema).min(1),
    metadata: realtimeThreadChangeMetadataSchema.optional(),
  })
  .strict();
export type RealtimeThreadChanged = z.infer<typeof realtimeThreadChangedSchema>;

export const realtimeServerMessageSchema = z.discriminatedUnion("type", [
  realtimeThreadChangedSchema,
  // Subscribe acks: let clients (and tests) observe subscription state before
  // assuming subsequent broadcasts arrive. The bb SPA ignores unknown frames,
  // so this stays additive for it.
  z
    .object({
      type: z.literal("subscribed"),
      target: realtimeSubscriptionTargetSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("unsubscribed"),
      target: realtimeSubscriptionTargetSchema,
    })
    .strict(),
]);
export type RealtimeServerMessage = z.infer<typeof realtimeServerMessageSchema>;

/** Build a `changed` broadcast for thread events having been appended. */
export function threadEventsAppendedMessage(args: {
  threadId: string;
  latestSeq: number;
}): RealtimeThreadChanged {
  return {
    type: "changed",
    entity: "thread",
    id: args.threadId,
    changes: ["events-appended"],
    metadata: { latestSeq: args.latestSeq },
  };
}

/** Build a `changed` broadcast for an interaction lifecycle transition (#94). */
export function pendingInteractionChangedMessage(args: {
  threadId: string;
  latestSeq: number;
  interactionId: string;
  status: z.infer<typeof pendingInteractionStatusSchema>;
}): RealtimeThreadChanged {
  return {
    type: "changed",
    entity: "thread",
    id: args.threadId,
    changes: ["events-appended", "pending-interaction"],
    metadata: {
      latestSeq: args.latestSeq,
      pendingInteraction: {
        interactionId: args.interactionId,
        status: args.status,
      },
    },
  };
}
