import { z } from "zod";
import {
  turnPhaseSchema,
  pendingInteractionPayloadSchema,
  pendingInteractionResolutionSchema,
  promptContentSchema,
} from "@cap/protocol";

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

/**
 * #276 J5 subagent activity summary unit — one wrapped child event of a
 * `task.subagent_event` row (omp `subagent_event` frame isomorph: child
 * event + outer task ids). The child DO's flush fold derives these units
 * from its own journal at turn boundaries; every field is journal-derived so
 * a re-flush after a crash re-derives identical units (parent dedups by
 * `kind`+`sourceSeq`). Text/output ride summary-capped (never journal
 * oversize — settleSpawn doctrine).
 */
export const subagentActivityUnitSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool_started"),
    /** Child journal seq of the source row — dedup + ordering key. */
    sourceSeq: z.number().int().positive(),
    /** Child turn scope the row belongs to (ux placement). */
    turnId: z.string().min(1),
    /** Child-side ux item id (executionIdFor over the child journal). */
    executionId: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("tool_completed"),
    sourceSeq: z.number().int().positive(),
    turnId: z.string().min(1),
    executionId: z.string().min(1),
    tool: z.string().min(1),
    status: toolResultStatusSchema,
    /** Summary-capped inline output (blob rows resolved before capping). */
    output: z.string(),
    /** Source tool.result row timestamp (deterministic across re-flush). */
    completedAt: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("thinking"),
    sourceSeq: z.number().int().positive(),
    turnId: z.string().min(1),
    modelCallId: z.number().int().positive(),
    /** The model call's accumulated CoT text, summary-capped. */
    text: z.string(),
  }),
  z.object({
    kind: z.literal("message"),
    sourceSeq: z.number().int().positive(),
    turnId: z.string().min(1),
    modelCallId: z.number().int().positive(),
    /** The model call's completed answer text, summary-capped. */
    text: z.string(),
  }),
]);
export type SubagentActivityUnit = z.infer<typeof subagentActivityUnitSchema>;

export const agentEventDataSchemas = {
  "thread.created": z.object({
    title: z.string(),
    /** Machine this thread's tool executions are bound to (M0: single). */
    machineId: z.string().min(1),
  }),

  /**
   * #288 explicit rebind (layer doc §2.1): the ONLY way a binding moves — an
   * owner operation appends this row, replay migrates `state.machineId`, and
   * every later dispatch resolves the new machine with zero per-dispatch
   * lookups. In-flight executions settle by executionId self-routing and are
   * unaffected (bb: "The switch moves the thread mid-turn"). The system side
   * never appends this row itself; product policy for offline hosts is #73.
   */
  "thread.rebound": z.object({
    machineId: z.string().min(1),
    /** Control-plane half (`threads.environment_id`), for log-level 对账. */
    environmentId: z.string().min(1).optional(),
  }),

  /**
   * #309 manual compact — the content-bearing checkpoint row (omp
   * CompactionEntry reduced to our seq-keyed journal; bb's `thread/compacted`
   * is content-free because bb delegates the transcript to the provider, but
   * this stack rebuilds every request from the log, so the boundary must be
   * journal-derivable, #116). Appended after the compact turn's summarization
   * call completes. `hideThroughSeq` = `firstKeptEntryId` as a seq boundary
   * (checkpointResultSeq precedent): rows ≤ it left the active context, the
   * compact turn itself and later rows stay visible — the summary rides the
   * request as the compact turn's own history, no branchCut overlay needed.
   * Thread-scoped, never FSM state (model.usage_receipt no-op precedent).
   */
  "thread/compacted": z.object({
    /** The compact turn that produced this checkpoint. */
    turnId: z.string().min(1),
    hideThroughSeq: z.number().int().nonnegative(),
    /** Last known usage total before the cut; null = never measured. */
    tokensBefore: z.number().int().nonnegative().nullable(),
    /** bytes/4 estimate over the post-cut visible tail (estimated: true). */
    tokensAfter: z.number().int().nonnegative(),
    /** Window denominator for the estimated usage row; null = unknown. */
    contextWindow: z.number().int().positive().nullable(),
    method: z.enum(["manual"]),
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

  /**
   * #197 D3 turn-phase family (streaming contract spec §3): zero-payload
   * marker rows (≤120 bytes) written by the driver/recovery-relevant paths
   * only, always AFTER the fact row they mark (persist-then-mark, P1). They
   * are UX truth, never FSM state — applyEvent records them on the turn
   * runtime without touching `status`. `stream_started` repeats per model
   * call by design (retry = new row = new stream card); the others are
   * once-per-turn by writer discipline.
   */
  "turn.phase": z.object({
    turnId: z.string().min(1),
    phase: turnPhaseSchema,
    /** stream_started / first_token belong to this model call. */
    modelCallId: z.number().int().positive().optional(),
    /** terminal outcome detail; host_lost is always "host_offline". */
    reason: z.string().min(1).optional(),
  }),

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

  /**
   * #257 CoT stream — the provider's native reasoning deltas for one model
   * call (Anthropic `thinking_delta`), journaled under the same flush
   * discipline as `model.delta` so the log replays the full stream. Guarded
   * exactly like `model.delta` (call must be running) but folds nothing:
   * answer-prefix accounting (`deltaChars`) stays answer-only. The ux
   * projection renders these as `item/reasoning/textDelta` rows.
   */
  "model.thinking": z.object({
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

  /**
   * #308 provider-side token accounting for one completed call — its own
   * journal row (bb's contextWindowUsage rows are first-class log rows too),
   * appended right after the `model.call_completed` it describes. Receipt
   * when the provider reported usage, bytes/4 wire estimate when it didn't
   * (`estimated: true`); providers without any usage face append nothing.
   * Thread-auditable via turnId/modelCallId; folded 1:1 into the ux
   * `thread/contextWindowUsage/updated` row (own seq — the events view's
   * strict unique-seq contract), never FSM state. contextWindow null = the
   * deployment cannot name a percentage; the ux projection omits the row
   * rather than guessing.
   */
  "model.usage_receipt": z.object({
    turnId: z.string().min(1),
    modelCallId: z.number().int().positive(),
    usage: z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheReadInputTokens: z.number().int().nonnegative(),
      cacheCreationInputTokens: z.number().int().nonnegative(),
      contextWindow: z.number().int().positive().nullable(),
      estimated: z.boolean(),
    }),
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
    /**
     * #289 host:path override deviation (control-plane-layer.md §2.2): when
     * a path argument overrode the thread binding for THIS single dispatch,
     * the target machineId. Absent = the dispatch rode the bound machine.
     * The binding itself is never rewritten — the next dispatch resolves
     * `state.machineId` again (explicit binding state in trajectory).
     */
    overriddenMachineId: z.string().min(1).optional(),
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

  /**
   * M1.5 T16 task/subagent journal family (proposal §3 T16) — thread-scoped
   * like the JobRegistry family: spawn plans outlive turns, projected by
   * tools/task/*, never FSM state.
   *
   * `task.spawn_planned` is the journal-first CAS for one spawn: idempotent by
   * `executionId` (recovery re-dispatch re-adopts the same child — never a
   * second spawn), while a *re-sent* task call gets a fresh executionId and
   * deliberately spawns a new child (omp zero-dedup semantics, matrix §2.4:
   * follow-up should `write agent://<id>`, not re-spawn). `machineId` carries
   * the bb same-host constructive default: the child inherits the parent's
   * machine binding (bb-fleet-shape §7).
   */
  "task.spawn_planned": z.object({
    executionId: z.string().min(1),
    /** Child DO address and spawn dedup key (one id serves both roles). */
    spawnId: z.string().min(1),
    /** Uniquified omp agent id (dup `-2`, nested `Parent.Child`). */
    agentId: z.string().min(1),
    agent: z.string().min(1),
    childThreadId: z.string().min(1),
    parentThreadId: z.string().min(1),
    machineId: z.string().min(1),
    mode: z.enum(["blocking", "background"]),
    /** T2 JobRegistry id for background spawns; null = blocking inline. */
    jobId: z.string().min(1).nullable(),
    task: z.string().min(1),
    /** omp solutionSpace — forwarded to the child's auto thinking classifier. */
    solutionSpace: z.string(),
    /** Ordered model preference; explicit selectors never fall back to the parent model (omp task.md §model). */
    model: z.string().optional(),
    /**
     * T18 batch shared context (`{context, tasks[]}` container): rendered
     * into every child's assignment CONTEXT section. Journaled per plan row
     * so a recovery re-dispatch re-renders the identical assignment.
     * Optional: flat spawns and pre-T18 journals omit it.
     */
    context: z.string().min(1).optional(),
    /**
     * Accepted-but-T17-activated structured contract (recorded, not yet
     * validated). JSON-encoded on the journal: event data must stay
     * RPC-serializable (no top-level `unknown`), and the raw caller value
     * lives only in the in-memory spawn plan.
     */
    outputSchemaJson: z.string().min(1).optional(),
    schemaMode: z.enum(["permissive", "strict"]).optional(),
    /**
     * T20 #110: present iff the spawn prepared a daemon-side isolated
     * workspace. JSON-encoded `SpawnIsolationInfo` — same serialization
     * rule as outputSchemaJson (RPC-serializable event data only).
     */
    isolationJson: z.string().min(1).optional(),
    /**
     * #274 J1 delegation attribution: the spawning `task` tool call's UX
     * item id — the BARE call executionId (batch per-item plans suffix a
     * `#index` onto their own executionId dedup key; this stays the
     * un-suffixed anchor the delegation row is keyed by). Optional:
     * pre-J1 journals omit it.
     */
    parentToolCallId: z.string().min(1).optional(),
    depth: z.number().int().nonnegative(),
  }),

  /**
   * Terminal backflow row for one spawn, appended by the child-completion
   * wake source (AgentDO.completeSubagent) BEFORE any waiter wakes (iron
   * rule 1). Idempotent by `spawnId` — duplicate callbacks append nothing
   * (cross-DO message dedup, T16 acceptance).
   */
  "task.spawn_settled": z.object({
    spawnId: z.string().min(1),
    jobId: z.string().min(1).nullable(),
    agentId: z.string().min(1),
    childThreadId: z.string().min(1),
    status: z.enum(["ok", "error"]),
    /** Inline delivery text — already summary-capped by the executor. */
    output: z.string(),
    outputTruncated: z.boolean().optional(),
    /**
     * #274 J1: attribution carried from the plan so terminal rows fold into
     * the delegation row without a spawnId→plan join. Optional: pre-J1
     * journals omit it.
     */
    parentToolCallId: z.string().min(1).optional(),
  }),

  /**
   * Background-completion follow-up (omp ASYNC_RESULT_MESSAGE_TYPE
   * "async-result"): the model-visible injection into the parent's next run.
   * The translate projection attaches it to the boundary of the first model
   * call that starts after this row (deterministic replay, no consumption
   * marker). Blocking spawns return through `tool.result` instead and never
   * produce this row.
   */
  "task.async_result": z.object({
    spawnId: z.string().min(1),
    agentId: z.string().min(1),
    jobId: z.string().min(1),
    status: z.enum(["ok", "error"]),
    output: z.string(),
    /** #274 J1: delegation attribution from the plan (see spawn_settled). */
    parentToolCallId: z.string().min(1).optional(),
  }),

  /**
   * Child-journal identity row (bb dual-axis shape, bb-fleet-shape §1/§8):
   * `parentThreadId` is the hierarchy axis, `sourceThreadId`+`originKind` the
   * provenance axis — the pair is an XOR (fork provenance vs hierarchy
   * ownership). The T16 spawn path writes only the hierarchy axis; the fork
   * fields exist so the shape is frozen for the T17+ fork/side-chat paths
   * without a schema migration. Folded into ReplayState.subagentIdentity —
   * the child's replay-derivable knowledge of being a subagent (drives the
   * subagent wire surface and the parent-completion hook).
   */
  "task.subagent_identity": z.object({
    /** Parent-side spawn dedup key; rides the completion callback. */
    spawnId: z.string().min(1),
    agentId: z.string().min(1),
    parentThreadId: z.string().min(1),
    sourceThreadId: z.string().min(1).nullable(),
    originKind: z.string().min(1).nullable(),
    depth: z.number().int().nonnegative(),
    /**
     * T17 structured contract (M1.5): the spawn plan's `outputSchema`/
     * `schemaMode`, mirrored onto the child identity so the child DO
     * enforces the yield schema verdict replay-pure (no parent contact).
     * JSON-encoded like `task.spawn_planned.outputSchemaJson` (event data
     * must stay RPC-serializable). Optional: pre-T17 journals omit both.
     */
    outputSchemaJson: z.string().min(1).optional(),
    schemaMode: z.enum(["permissive", "strict"]).optional(),
    /**
     * #274 J1: attribution anchor mirrored from the spawn request, so the
     * child journal is self-attributing — the child's own rows (activity,
     * CoT) point at the parent's delegation tool call (bb child-side
     * parentToolCallId semantics). Optional: pre-J1 journals omit it.
     */
    parentToolCallId: z.string().min(1).optional(),
  }),

  /**
   * T17 reminder-ladder marker (proposal §3 T17): appended immediately
   * before the reminder turn's `turn.input`, binding the ladder intent to
   * that turn by `inputId` (deterministic join — the marker and the turn
   * input are separate appends and a completion callback may interleave).
   * `forced` records the verdict that appended it (attempt 3 of the cycle,
   * tools/task/child-run.ts childRunVerdict): every reminder turn has a
   * marker, so the attempt number alone cannot distinguish the forced tier
   * at projection time — translate reads THIS field to pin tool_choice.
   * Stale supersession derives from the journal fold (async-result after
   * the terminal yield), not from the row.
   */
  "task.yield_reminder": z.object({
    inputId: z.string().min(1),
    forced: z.boolean(),
    /**
     * T18 budget ladder: the hard stop (1.5× soft requests / wall clock)
     * compresses the reminder ladder into ONE forced terminal-yield attempt
     * (task semantics §4.1) — that attempt is a reminder row with
     * reason="budget", which the gate settles from partial findings when the
     * forced turn ends without a usable yield. Optional: pre-T18 rows are
     * ladder reminders (fold default).
     */
    reason: z.enum(["ladder", "budget"]).optional(),
  }),

  /**
   * T18 soft-budget marker (task semantics §4.1: softRequestBudget default
   * 200 — "超限注入收尾 notice"): appended ONCE per run before the wind-down
   * notice is steered into the live turn (or sent as its own turn). The fold
   * reads the row's existence for idempotency — a crash between the row and
   * the steer re-derives "notice already given" and never re-injects.
   */
  "task.budget_notice": z.object({
    /** The steer/message inputId that carried the notice (dedup key). */
    inputId: z.string().min(1),
  }),

  /**
   * T17 terminal SYSTEM WARNING injection (omp docs/tools/task.md:186):
   * the run exhausted the ladder (3 reminders, the last forced) without a
   * usable yield. Carries the injected text — the one ladder artifact that
   * is content, not derivable state. Thread-scoped like the identity row.
   */
  "task.yield_warning": z.object({
    text: z.string().min(1),
  }),

  /**
   * T17 settlement receipt on the child journal: appended AFTER the parent
   * accepted the completion (delivery-first — a transient RPC failure must
   * stay retryable). Guards the re-ladder: once this row exists the run is
   * closed, and late async-results are history material for the T19
   * idle-follow-up surface instead of supersession fodder.
   */
  "task.yield_completed": z.object({
    status: z.enum(["ok", "error"]),
    output: z.string(),
  }),

  /**
   * M1.5 T19 lifecycle journal family (proposal §3 T19) — the four-state
   * registry's rows (tools/task/lifecycle.ts folds them; thread-scoped like
   * the rest of the task family, never FSM state).
   *
   * `task.subagent_parked` is the TTL-park row (omp agentIdleTtlMs, default
   * 420_000, ≤0 off): appended by the CHILD DO's alarm — park is a local DO
   * state write (ticket DO budget). Ref (agentId) + sessionFile (the
   * journal) survive; only the live session releases.
   */
  "task.subagent_parked": z.object({
    spawnId: z.string().min(1),
    agentId: z.string().min(1),
  }),

  /**
   * Revival receipt (omp irc/bus.ts:139-143): `write agent://<id>` on a
   * parked agent revives it from the transcript, then delivers. `inputId`
   * joins the follow-up turn input (deterministic join, yield_reminder
   * precedent).
   */
  "task.subagent_revived": z.object({
    spawnId: z.string().min(1),
    agentId: z.string().min(1),
    /** The follow-up message's turn inputId (revive-<messageId>). */
    inputId: z.string().min(1),
    /** Who revived it (the `write agent://` sender). */
    from: z.string().min(1),
  }),

  /**
   * Abort row. reason="kill" rides the `proc://<jobId>/kill` face (cancel
   * entry 1). The asymmetry (omp executor.ts:2144-2147): "budget" is the
   * ONLY revivable abort — the lifecycle fold maps it to `idle`; every
   * other reason lands the terminal tombstone (irreversible; late
   * callbacks confirm, never flip).
   */
  "task.subagent_aborted": z.object({
    spawnId: z.string().min(1),
    agentId: z.string().min(1),
    reason: z.enum(["budget", "call_signal", "wall_clock", "kill", "internal"]),
  }),

  /**
   * #276 J5 journal-first backflow (omp `subagent_event` wrapper frame
   * isomorph): one child activity/CoT summary unit, journaled on the PARENT
   * by `reportSubagentActivity` so the parent's ux view unfolds the
   * delegation row's childRows from a single log (no cross-DO read-through,
   * replay-stable — G4's journal-first arm). Appended by the child DO's
   * turn-boundary flush (tools/task/activity-flush fold + the
   * completeSubagent RPC family); deduped by (`spawnId`, unit kind,
   * unit sourceSeq). Rows carry no turnId: child activity outlives and
   * interleaves across parent turns (thread-scoped task-family rule).
   */
  "task.subagent_event": z.object({
    spawnId: z.string().min(1),
    agentId: z.string().min(1),
    childThreadId: z.string().min(1),
    /**
     * #274 J1 attribution anchor from the spawn plan — the ux projection
     * unfolds the wrapped unit into rows pointing at the delegation row.
     * Optional: pre-J1 journals omit it.
     */
    parentToolCallId: z.string().min(1).optional(),
    unit: subagentActivityUnitSchema,
  }),

  /**
   * #276 J5 flush cursor on the CHILD journal: every row ≤ `throughSeq` has
   * been reported to the parent (idempotency marker, yield_reminder
   * precedent). Appended only after the parent accepted the batch, so a
   * crash between RPC and cursor re-derives the same units and the parent's
   * dedup absorbs the re-send.
   */
  "task.subagent_flush": z.object({
    throughSeq: z.number().int().positive(),
  }),

  /**
   * M1.5 T4 pending-interaction journal family (proposal §3 T4): the DO's
   * projection of bb `/internal/session/interactive-request` — SPA-visible
   * ask state that survives eviction+replay because it lives in the journal,
   * not in memory. Thread-scoped like job.*; folded by tools/ask.ts
   * projectInteractions (and the watchdog's interaction expiry family), not
   * by the FSM. `executionId` keys re-ask idempotency exactly like
   * todo_phases: the bb `created|existing` outcome pair comes from this row
   * (a re-asked blocking execution re-projects its row instead of
   * re-registering a second interaction).
   */
  "interaction.registered": z.object({
    /** bb id shape (`pi_<n>`); minted once at registration. */
    interactionId: z.string().min(1),
    turnId: z.string().min(1),
    executionId: z.string().min(1),
    providerId: z.string().min(1),
    providerThreadId: z.string().min(1),
    providerRequestId: z.string().min(1),
    /** Absolute deadline when bounded (omp ask.timeout; 0 = null = no cap). */
    expiresAt: z.number().int().nonnegative().nullable(),
    payload: pendingInteractionPayloadSchema,
  }),

  "interaction.resolved": z.object({
    interactionId: z.string().min(1),
    resolution: pendingInteractionResolutionSchema,
  }),

  /**
   * bb interrupt semantics (host-daemon-contract session.ts:756-774): mark
   * the blocked row interrupted when the provider/turn dies; the cancelled
   * tool.result follows it (journal-before-result ordering).
   */
  "interaction.interrupted": z.object({
    interactionId: z.string().min(1),
    statusReason: z.string().min(1),
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
