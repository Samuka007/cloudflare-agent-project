import { z } from "zod";
import { FIRST_SEQ } from "./ids.js";

/**
 * Append-only thread event log schema.
 *
 * Frozen from bb archaeology (packages/domain/src/provider-event.ts): the
 * envelope separates transport fields (`threadId`, `seq`, `id`, `createdAt`,
 * `type`) from the per-type payload in `data`, exactly like bb's
 * `ThreadEventRow` / `parseStoredThreadEvent`. `seq` is server-owned; daemons
 * and clients must never supply it (bb enforces the same guard on the daemon
 * wire schema).
 *
 * M0 freezes the event types the UX line needs for thread list + conversation
 * + streaming render. The bb namespace convention (`client/`, `turn/`,
 * `item/`, `thread/`, `system/`, `provider/`) is kept so later event types
 * grow additively without reshaping this union.
 */

export const threadEventItemStatusSchema = z.enum([
  "pending",
  "completed",
  "failed",
  "interrupted",
]);
export type ThreadEventItemStatus = z.infer<
  typeof threadEventItemStatusSchema
>;

export const turnStatusSchema = z.enum(["completed", "failed", "interrupted"]);
export type TurnStatus = z.infer<typeof turnStatusSchema>;

/** User input content items (bb `threadEventUserContentSchema`, M0 subset). */
export const promptContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
]);
export type PromptContent = z.infer<typeof promptContentSchema>;

// ---------------------------------------------------------------------------
// Timeline items (bb `threadEventItemSchema` subset — the shapes the SPA
// timeline renders a turn from).
// ---------------------------------------------------------------------------

export const userMessageItemSchema = z.object({
  type: z.literal("userMessage"),
  id: z.string().min(1),
  content: z.array(promptContentSchema).min(1),
});

export const agentMessageItemSchema = z.object({
  type: z.literal("agentMessage"),
  id: z.string().min(1),
  text: z.string(),
});

export const commandExecutionItemSchema = z.object({
  type: z.literal("commandExecution"),
  id: z.string().min(1),
  command: z.string(),
  cwd: z.string().nullable(),
  status: threadEventItemStatusSchema,
  output: z.string(),
  exitCode: z.number().int().nullable(),
  completedAt: z.number().nullable(),
});

export const toolCallItemSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  status: threadEventItemStatusSchema,
  output: z.string(),
  completedAt: z.number().nullable(),
});

export const threadEventItemSchema = z.discriminatedUnion("type", [
  userMessageItemSchema,
  agentMessageItemSchema,
  commandExecutionItemSchema,
  toolCallItemSchema,
]);
export type ThreadEventItem = z.infer<typeof threadEventItemSchema>;

// ---------------------------------------------------------------------------
// Event types + per-type data schemas.
// ---------------------------------------------------------------------------

export const systemErrorCategorySchema = z.enum([
  "machine_disconnected",
  "internal",
  "cancelled",
]);
export type SystemErrorCategory = z.infer<typeof systemErrorCategorySchema>;

const turnIdField = z.string().min(1);

export const threadEventDataSchemas = {
  "client/thread/start": z.object({
    title: z.string(),
  }),
  "client/turn/requested": z.object({
    turnId: turnIdField,
    /** Idempotency key: retried sends with the same id append nothing. */
    clientRequestId: z.string().min(1),
    initiator: z.enum(["user", "agent", "system"]),
    input: z.array(promptContentSchema).min(1),
  }),
  "turn/started": z.object({
    turnId: turnIdField,
  }),
  "turn/completed": z.object({
    turnId: turnIdField,
    status: turnStatusSchema,
    error: z
      .object({
        category: systemErrorCategorySchema,
        message: z.string(),
      })
      .nullable(),
  }),
  "item/started": z.object({
    turnId: turnIdField,
    item: threadEventItemSchema,
  }),
  "item/agentMessage/delta": z.object({
    turnId: turnIdField,
    itemId: z.string().min(1),
    delta: z.string(),
  }),
  "item/completed": z.object({
    turnId: turnIdField,
    item: threadEventItemSchema,
  }),
  "system/error": z.object({
    message: z.string(),
    category: systemErrorCategorySchema,
  }),
} as const;

export const threadEventTypeSchema = z.enum(
  Object.keys(threadEventDataSchemas) as [string, ...string[]],
);
export type ThreadEventType = keyof typeof threadEventDataSchemas;

export type ThreadEventDataByType = {
  [TType in ThreadEventType]: z.infer<(typeof threadEventDataSchemas)[TType]>;
};

/** Transport envelope persisted in the event log and served by `GET events`. */
export const threadEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  seq: z.number().int().min(FIRST_SEQ),
  type: threadEventTypeSchema,
  data: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});
export type ThreadEventEnvelope = z.infer<typeof threadEventEnvelopeSchema>;

export type TypedThreadEvent = {
  [TType in ThreadEventType]: ThreadEventEnvelope & {
    type: TType;
    data: ThreadEventDataByType[TType];
  };
}[ThreadEventType];

export class ThreadEventDataError extends Error {
  constructor(
    public readonly envelope: ThreadEventEnvelope,
    public readonly cause: z.ZodError,
  ) {
    super(`invalid data for event type ${envelope.type} (seq ${envelope.seq})`);
  }
}

/** Validate the envelope and its per-type `data` payload. */
export function parseThreadEvent(input: unknown): TypedThreadEvent {
  const envelope = threadEventEnvelopeSchema.parse(input);
  const dataSchema: z.ZodType =
    threadEventDataSchemas[envelope.type as ThreadEventType];
  const data = dataSchema.parse(envelope.data);
  return { ...envelope, data } as TypedThreadEvent;
}

/**
 * Build a fully-typed event envelope. `seq` must be the server-assigned value;
 * callers derive it from the store before invoking this.
 */
export function buildThreadEvent<TType extends ThreadEventType>(args: {
  id: string;
  threadId: string;
  seq: number;
  type: TType;
  data: ThreadEventDataByType[TType];
  createdAt: number;
}): TypedThreadEvent {
  return { ...args } as TypedThreadEvent;
}

/**
 * Events a daemon pushes upstream must not carry the server-owned `seq` (bb
 * enforces the same invariant). This is the daemon-side event shape: envelope
 * fields minus `seq`, `id` stays client-chosen for traceability.
 */
export type DaemonThreadEventInput = Omit<ThreadEventEnvelope, "seq">;

/**
 * Canonical projection for turn lifecycle consumers: a turn is complete when a
 * `turn/completed` event exists for `turnId`.
 */
export function findTurnCompletedSeq(
  events: ReadonlyArray<ThreadEventEnvelope>,
  turnId: string,
): number | null {
  for (const event of events) {
    if (event.type === "turn/completed" && event.data.turnId === turnId) {
      return event.seq;
    }
  }
  return null;
}
