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
export type ThreadEventItemStatus = z.infer<typeof threadEventItemStatusSchema>;

export const turnStatusSchema = z.enum(["completed", "failed", "interrupted"]);
export type TurnStatus = z.infer<typeof turnStatusSchema>;

/**
 * Turn phase vocabulary (#184 streaming contract, spec §3): the five journal
 * `turn.phase` markers the agent DO writes around a turn's stream lifecycle.
 * Shared verbatim by the UX envelope (`turn/phase` below) and the realtime
 * `phase-changed` metadata so the three faces cannot drift.
 */
export const turnPhaseSchema = z.enum([
  "stream_started",
  "first_token",
  "terminal",
  "settled",
  "host_lost",
]);
export type TurnPhase = z.infer<typeof turnPhaseSchema>;

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
  /**
   * #274 J1 delegation attribution: the toolCall item (the delegation row)
   * this message belongs to. Absent on root-turn rows; additive so pre-J1
   * journals parse unchanged.
   */
  parentToolCallId: z.string().min(1).optional(),
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
  /**
   * #274 J1: parent delegation row for nested work (a subagent's own tool
   * calls) — bb `parentToolCallId` semantics (#256 G2).
   */
  parentToolCallId: z.string().min(1).optional(),
});

/**
 * bb `reasoning` item (#257 CoT surface): provider-native chain of thought.
 * `summary` stays the bb shape ([] for glm-5.3 — no summaries on the wire);
 * `content` accumulates the reasoning text. Root-projection-only ephemeral
 * state — the pinned SPA renders CoT through the timeline response's
 * `activeThinking`, never as a standalone row.
 */
export const reasoningItemSchema = z.object({
  type: z.literal("reasoning"),
  id: z.string().min(1),
  summary: z.array(z.string()),
  content: z.array(z.string()),
  /**
   * #274 J1: delegation attribution — subagent CoT attaches to the
   * delegation row instead of the root turn's activeThinking.
   */
  parentToolCallId: z.string().min(1).optional(),
});

/**
 * bb `backgroundTaskStatus` (#256 J3; contract port
 * apps/server-worker/src/contract/domain/background-task.ts:37-45): the union
 * of the provider task lifecycle statuses. `paused` stays pending on the item
 * machinery (resumable); `stopped` maps to interrupted (user/system stop, not
 * a failure).
 */
export const backgroundTaskStatusValues = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "killed",
  "stopped",
] as const;
export const backgroundTaskStatusSchema = z.enum(backgroundTaskStatusValues);
export type BackgroundTaskStatus = z.infer<typeof backgroundTaskStatusSchema>;

/**
 * bb `backgroundTask` item (#256 J3; bb verbatim shape is
 * provider-event.ts threadEventBackgroundTaskItemSchema): a materialized
 * background task whose lifecycle outlives its spawning turn. M0 carries the
 * subagent slice (`taskType "local_subagent"`); the workflow-progress fields
 * (workflowName/workflow/usage/outputFile) stay unported until the workflow
 * face has a source — additive scheme A admits them later without a version
 * bump. Placed by a turn-scoped `item/started`; late state arrives through
 * the thread-scoped `item/backgroundTask/progress|completed` family.
 */
export const backgroundTaskItemSchema = z.object({
  type: z.literal("backgroundTask"),
  id: z.string().min(1),
  /** Raw task discriminant ("local_subagent" for background subagent spawns). */
  taskType: z.string().min(1),
  description: z.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  /** Ambient/housekeeping task; consumers hide it from the inline transcript. */
  skipTranscript: z.boolean(),
  /** Terminal summary; absent while the task runs. */
  summary: z.string().optional(),
  error: z.string().optional(),
  /** #274 J1: the delegation toolCall item this task belongs to. */
  parentToolCallId: z.string().min(1).optional(),
});
export type BackgroundTaskItem = z.infer<typeof backgroundTaskItemSchema>;

export const threadEventItemSchema = z.discriminatedUnion("type", [
  userMessageItemSchema,
  agentMessageItemSchema,
  commandExecutionItemSchema,
  toolCallItemSchema,
  reasoningItemSchema,
  backgroundTaskItemSchema,
]);
export type ThreadEventItem = z.infer<typeof threadEventItemSchema>;

// ---------------------------------------------------------------------------
// Event types + per-type data schemas.
// ---------------------------------------------------------------------------

export const systemErrorCategorySchema = z.enum(["machine_disconnected", "internal", "cancelled"]);
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
  /**
   * #197 D3: 1:1 projection of the agent journal's `turn.phase` marker rows
   * (spec §4) — additive; clients that ignore unknown types skip them. The
   * `events?afterSeq` ux view therefore carries phases, which is what makes
   * them part of the cursor catch-up authority (spec §8.3).
   */
  "turn/phase": z.object({
    turnId: turnIdField,
    phase: turnPhaseSchema,
    /** stream_started / first_token belong to this model call. */
    modelCallId: z.number().int().positive().optional(),
    /** terminal phase outcome detail; host_lost is always "host_offline". */
    reason: z.string().min(1).optional(),
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
    /** #274 J1: delegation attribution (see agentMessageItemSchema). */
    parentToolCallId: z.string().min(1).optional(),
  }),
  /**
   * #257 CoT stream: the reasoning half of a model call, projected 1:1 from
   * the journal's `model.thinking` rows (bb event name `item/reasoning/
   * textDelta`; M0 folds summary into the omitted bb field). `itemId` is the
   * reasoning lifecycle `itm-rs-<turnId>:<modelCallId>` — the timeline
   * service folds these into the response's `activeThinking` tail field.
   */
  "item/reasoning/textDelta": z.object({
    turnId: turnIdField,
    itemId: z.string().min(1),
    delta: z.string(),
    /** #274 J1: delegation attribution (see reasoningItemSchema). */
    parentToolCallId: z.string().min(1).optional(),
  }),
  "item/completed": z.object({
    turnId: turnIdField,
    item: threadEventItemSchema,
  }),
  /**
   * #275 J3 thread-scoped background-task family (bb same-name-same-shape;
   * scope ruling thread-event-scope.ts:102-111 — tasks outlive their spawning
   * turn, so late events must not interleave into later turns' ranges). Each
   * event carries the full current item state; consumers replace, not merge.
   * No `turnId`: the row body was placed by the spawning turn's item/started.
   */
  "item/backgroundTask/progress": z.object({
    item: backgroundTaskItemSchema,
  }),
  "item/backgroundTask/completed": z.object({
    item: backgroundTaskItemSchema,
  }),
  /**
   * #308 context-window fill (bb same-name event, domain type
   * `threadEventContextWindowUsageSchema`): the provider-reported (or
   * wire-estimated, `estimated: true`) token count against the configured
   * window. Emitted 1:1 from a `model.call_completed{usage}` journal row when
   * both sides are known; rows never guess — no window, no row. bb's domain
   * shape allows null members for partial ACP reporters; our projection only
   * emits complete rows, so both members are strict numbers here. The SPA
   * consumes the value via the timeline response's `contextWindowUsage` tail
   * field (thread-scoped last-row-wins fold, `threadScopeRationaleByType`
   * policy "thread-or-turn").
   */
  "thread/contextWindowUsage/updated": z.object({
    contextWindowUsage: z.object({
      usedTokens: z.number().int().nonnegative(),
      modelContextWindow: z.number().int().positive(),
      estimated: z.boolean(),
    }),
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
  const dataSchema: z.ZodType = threadEventDataSchemas[envelope.type as ThreadEventType];
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
  events: readonly ThreadEventEnvelope[],
  turnId: string,
): number | null {
  for (const event of events) {
    if (event.type === "turn/completed" && event.data.turnId === turnId) {
      return event.seq;
    }
  }
  return null;
}
