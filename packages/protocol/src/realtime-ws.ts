import { z } from "zod";
import { turnPhaseSchema } from "./events.js";
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
  /** #197 D3: a `turn.phase` journal row landed (low-frequency, never coalesced). */
  "phase-changed",
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
    /**
     * #197 D2 Tier-B hint (bb same-named metadata semantics): journal event
     * types in the appended batch, so a refetching client can pull only the
     * queries it cares about. Plain strings — the agent journal vocabulary,
     * not the bb provider-event enum.
     */
    eventTypes: z.array(z.string()).optional(),
    /**
     * #197 D3: present whenever `changes` contains "phase-changed" — the
     * `turn.phase` row's payload, verbatim.
     */
    phase: z
      .object({
        turnId: z.string().min(1),
        phase: turnPhaseSchema,
        modelCallId: z.number().int().positive().optional(),
        reason: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();
export type RealtimeThreadChangeMetadata = z.infer<typeof realtimeThreadChangeMetadataSchema>;

/**
 * #197 D2 Tier-A payload frame (spec §6.1, server→client only): one journal
 * `model.delta` row per frame, inline. Frames are at-least-once and DO→DO
 * RPC is unordered — clients reconcile by `seq` (dedupe ≤ cursor; ambiguity
 * → catch-up fetch `events?afterSeq`), never by frame order.
 */
export const realtimeThreadDeltaSchema = z
  .object({
    type: z.literal("delta"),
    entity: z.literal("thread"),
    id: z.string().min(1),
    turnId: z.string().min(1),
    /** `itm-am-<turnId>:<modelCallId>` (ux-projection delta item, isomorphic). */
    itemId: z.string().min(1),
    /** Journal seq of this model.delta row — the D4 reconciliation cursor unit. */
    seq: z.number().int().min(1),
    /**
     * Inline text; omitted on R2-bypass rows (≥ r2BypassBytes) — the frame is
     * then a freshness signal only and the client must fetch.
     */
    text: z.string().optional(),
    /** Thread high-water seq at fan-out time; refetch-cursor hint, never a cursor. */
    latestSeq: z.number().int().min(0),
  })
  .strict();
export type RealtimeThreadDelta = z.infer<typeof realtimeThreadDeltaSchema>;

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
  realtimeThreadDeltaSchema,
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

/** Build the Tier-A `delta` payload frame for one inline model.delta row. */
export function threadDeltaMessage(args: {
  threadId: string;
  turnId: string;
  itemId: string;
  seq: number;
  text?: string;
  latestSeq: number;
}): RealtimeThreadDelta {
  return {
    type: "delta",
    entity: "thread",
    id: args.threadId,
    turnId: args.turnId,
    itemId: args.itemId,
    seq: args.seq,
    ...(args.text !== undefined ? { text: args.text } : {}),
    latestSeq: args.latestSeq,
  };
}

/** Build the D3 `phase-changed` broadcast for one turn.phase journal row. */
export function threadPhaseChangedMessage(args: {
  threadId: string;
  latestSeq: number;
  phase: {
    turnId: string;
    phase: z.infer<typeof turnPhaseSchema>;
    modelCallId?: number;
    reason?: string;
  };
}): RealtimeThreadChanged {
  return {
    type: "changed",
    entity: "thread",
    id: args.threadId,
    changes: ["phase-changed"],
    metadata: { latestSeq: args.latestSeq, phase: args.phase },
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
