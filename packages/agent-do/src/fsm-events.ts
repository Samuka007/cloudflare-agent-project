import { z } from "zod";
import { promptContentSchema } from "@cap/protocol";

/**
 * Agent-DO internal event vocabulary (docs/design/unified-turn-state.md §1.1,
 * "M0 事件类型全集").
 *
 * The envelope shape mirrors packages/protocol `ThreadEventEnvelope`
 * (bb ThreadEventRow: `{id, threadId, seq, type, data, createdAt}`) so the
 * storage row is protocol-shaped, but the event *types* are the FSM-level
 * vocabulary the turn state machine and the #23 §7 invariants are written
 * against. The protocol UX union (`turn/started`, `item/*`, …) is a
 * projection of this log — see `ux-projection.ts`; packages/protocol stays
 * the frozen contract for clients and is never redefined here.
 *
 * Large payloads (delta text, tool output) may be offloaded to R2; affected
 * string fields then hold a {@link BlobRef} placeholder resolved transparently
 * on read.
 */

export const blobRefSchema = z.object({
  __blob__: z.object({
    key: z.string().min(1),
    size: z.number().int().positive(),
    sha256: z.string().min(1),
  }),
});
export type BlobRef = z.infer<typeof blobRefSchema>;

export function isBlobRef(value: unknown): value is BlobRef {
  return blobRefSchema.safeParse(value).success;
}

const toolResultStatusSchema = z.enum(["ok", "error", "timeout", "cancelled", "outcome_unknown"]);
export type ToolResultStatus = z.infer<typeof toolResultStatusSchema>;

export const turnFailedReasonSchema = z.enum([
  "interrupted_mid_stream",
  "model_error",
  "turn_watchdog_expired",
]);
export type TurnFailedReason = z.infer<typeof turnFailedReasonSchema>;

export const dispatchOutcomeSchema = z.enum(["accepted", "completed_cached", "host_offline"]);

const toolCallDataSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

/**
 * omp TodoPhase/TodoItem verbatim (pi-tui tools/todo.ts:25-44). The
 * display-only `details`/`notes` members are absent: cloneTask drops them,
 * so they never enter tool state (coding-agent tools/todo.ts:93-97).
 */
export const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "abandoned", "blocked"]),
  blocker: z.string().optional(),
});

export const todoPhaseSchema = z.object({
  name: z.string(),
  tasks: z.array(todoItemSchema),
});

export const agentEventDataSchemas = {
  "thread.created": z.object({
    title: z.string(),
    /** Machine this thread's tool executions are bound to (M0: single). */
    machineId: z.string().min(1),
  }),

  "turn.input": z.object({
    turnId: z.string().min(1),
    /** Client-generated idempotency key; retries append nothing. */
    inputId: z.string().min(1),
    content: z.array(promptContentSchema).min(1),
  }),

  "turn.steer": z.object({
    turnId: z.string().min(1),
    inputId: z.string().min(1),
    content: z.array(promptContentSchema).min(1),
  }),

  "turn.cancel_requested": z.object({ turnId: z.string().min(1) }),

  "turn.completed": z.object({ turnId: z.string().min(1) }),

  "turn.failed": z.object({
    turnId: z.string().min(1),
    reason: turnFailedReasonSchema,
    /** True when the turn failed via ruling-A seal (never a model re-call). */
    sealed: z.boolean().optional(),
  }),

  "turn.cancelled": z.object({ turnId: z.string().min(1) }),

  "model.call_started": z.object({
    turnId: z.string().min(1),
    /** Steer event seqs consumed by this call (§2.3, I9). */
    consumedSteerSeqs: z.array(z.number().int().positive()),
  }),

  "model.delta": z.object({
    turnId: z.string().min(1),
    modelCallId: z.number().int().positive(),
    text: z.union([z.string(), blobRefSchema]),
  }),

  "model.call_completed": z.object({
    turnId: z.string().min(1),
    modelCallId: z.number().int().positive(),
    text: z.string(),
    /** Complete, fully-parsed tool calls only (§2.2, ruling B). */
    toolCalls: z.array(toolCallDataSchema),
  }),

  "model.call_sealed": z.object({
    turnId: z.string().min(1),
    modelCallId: z.number().int().positive(),
    /** Persisted delta prefix size in UTF-8 bytes at seal time. */
    prefixChars: z.number().int().nonnegative(),
  }),

  "model.call_failed": z.object({
    turnId: z.string().min(1),
    modelCallId: z.number().int().positive(),
    error: z.string(),
    retryable: z.boolean(),
    /** True when this failure is the model-stream half of a cancellation. */
    aborted: z.boolean().optional(),
  }),

  "model.call_retry": z.object({
    turnId: z.string().min(1),
    failedModelCallId: z.number().int().positive(),
    attempt: z.number().int().positive(),
  }),

  "tool.call": z.object({
    turnId: z.string().min(1),
    modelCallId: z.number().int().positive(),
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
    /** Execution timeout policy owned by the agent DO (§5.1). */
    timeoutMs: z.number().int().positive(),
  }),

  "tool.dispatch": z.object({
    turnId: z.string().min(1),
    executionId: z.string().min(1),
    /** 1-based dispatch attempt count for this executionId. */
    attempt: z.number().int().positive(),
    /** Transport-level pairing id; never an idempotency key (§0). */
    requestId: z.string().min(1),
    outcome: dispatchOutcomeSchema,
  }),

  "tool.exec_started": z.object({
    turnId: z.string().min(1),
    executionId: z.string().min(1),
    pid: z.number().int().positive().optional(),
    pidStartedAt: z.number().int().positive().optional(),
  }),

  "tool.output": z.object({
    turnId: z.string().min(1),
    executionId: z.string().min(1),
    offset: z.number().int().nonnegative(),
    chunk: z.union([z.string(), blobRefSchema]),
  }),

  "tool.result": z.object({
    turnId: z.string().min(1),
    executionId: z.string().min(1),
    status: toolResultStatusSchema,
    exitCode: z.number().int().nullable(),
    output: z.union([z.string(), blobRefSchema]),
    outputTruncated: z.boolean().optional(),
  }),

  /**
   * Edge `context_notes` journal entry — omp ContextNotesEntry verbatim
   * (packages/coding-agent/src/session/context-notes.ts:8-11). Thread-scoped
   * like thread.created: notebook revisions outlive turns and are projected
   * by the edge executor (tools/edge.ts latestContextNotes), not by the FSM.
   */
  experimental_context_notes: z.object({
    version: z.literal(1),
    text: z.string(),
  }),

  /**
   * M1.5 T2 JobRegistry journal family (proposal §3 T2: "jobs live in DO
   * storage (journal)") — thread-scoped like experimental_context_notes:
   * registered by the T16+ spawn/eval background paths, projected by
   * tools/job-registry.ts, never FSM state (jobs outlive turns).
   */
  "job.registered": z.object({
    jobId: z.string().min(1),
    /** Owning agent id (omp AsyncJob ownerId); null = unowned. */
    ownerId: z.string().min(1).nullable(),
    kind: z.enum(["job", "service"]),
    label: z.string(),
  }),

  "job.settled": z.object({
    jobId: z.string().min(1),
    status: z.enum(["ok", "error", "cancelled"]),
    output: z.string(),
  }),

  "job.delivered": z.object({
    jobId: z.string().min(1),
    /** Wait (or ordinary async-delivery) execution that consumed the result. */
    byExecutionId: z.string().min(1),
  }),

  /**
   * Peer message inbox — the journal-backed wake-source seam (proposal §3 T2:
   * no cross-DO RPC except wake sources). Delivery appends before any waiter
   * wakes, so a message survives eviction and replay re-projects it.
   */
  "peer.message": z.object({
    messageId: z.string().min(1),
    /** Recipient agent id within this DO. */
    ownerId: z.string().min(1),
    from: z.string().min(1),
    text: z.string(),
  }),

  "peer.message_consumed": z.object({
    messageId: z.string().min(1),
    byExecutionId: z.string().min(1),
  }),

  /**
   * Edge `todo` canonical snapshot — the DO journal's projection of omp
   * "durable canonical todo snapshot on tool-result details"
   * (coding-agent tools/todo.ts canonicalTodoPhases; DO tool.result rows
   * carry no details field, so the snapshot rides its own typed entry).
   * Written only by successful non-view mutations, before the tool.result
   * lands. Thread-scoped like thread.created; folded by the todo projection
   * (tools/session-tree.ts todoJournalState), not by the FSM. `executionId`
   * keys re-ask idempotency: a crash between this append and the result row
   * leaves the snapshot discoverable by its owning execution, so the re-run
   * completes instead of re-applying a non-idempotent op.
   */
  todo_phases: z.object({
    version: z.literal(1),
    executionId: z.string().min(1),
    op: z.enum(["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"]),
    phases: z.array(todoPhaseSchema),
  }),
} as const;

export type AgentEventType = keyof typeof agentEventDataSchemas;
export type AgentEventDataByType = {
  [T in AgentEventType]: z.infer<(typeof agentEventDataSchemas)[T]>;
};

/** Transport envelope — same field shape as protocol ThreadEventRow. */
export interface AgentEventRecord<TType extends AgentEventType = AgentEventType> {
  id: string;
  threadId: string;
  seq: number;
  type: TType;
  data: AgentEventDataByType[TType];
  createdAt: number;
}

/** Envelope fields minus server-owned `seq` (append input). */
export interface AgentEventInput<TType extends AgentEventType = AgentEventType> {
  type: TType;
  data: AgentEventDataByType[TType];
}

/** Fully discriminated event union — narrowing works in switch on `type`. */
export type AnyAgentEvent = {
  [T in AgentEventType]: AgentEventRecord<T>;
}[AgentEventType];

/**
 * Validate + type a raw log row. The write path parses before INSERT and the
 * read path parses after SELECT, so nothing downstream ever touches an
 * unchecked shape.
 */
export function parseAgentEvent(input: {
  threadId: string;
  seq: number;
  id: string;
  type: string;
  data: unknown;
  createdAt: number;
}): AnyAgentEvent {
  const type = input.type as AgentEventType;
  // `input.type` is an untrusted storage string; the Partial-record view
  // keeps the undefined guard meaningful for out-of-vocabulary types.
  const schemaTable: Partial<
    Record<AgentEventType, (typeof agentEventDataSchemas)[AgentEventType]>
  > = agentEventDataSchemas;
  const dataSchema = schemaTable[type];
  if (dataSchema === undefined) {
    throw new Error(`unknown agent event type ${input.type} (seq ${input.seq})`);
  }
  return {
    id: input.id,
    threadId: input.threadId,
    seq: input.seq,
    type,
    data: dataSchema.parse(input.data),
    createdAt: input.createdAt,
  } as AnyAgentEvent;
}
