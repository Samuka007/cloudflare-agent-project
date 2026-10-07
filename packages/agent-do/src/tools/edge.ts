import { type } from "arktype";
import type { AnyAgentEvent } from "../fsm-events.js";
import { executionIdFor } from "../ids.js";
import type { ToolRegistryRow } from "./registry.js";
import { runWaitTool, type WaitToolContext } from "./wait.js";
import { runTaskTool, type TaskToolContext } from "./task/executor.js";
import { runYieldTool, type YieldToolArgs } from "./yield.js";
import { runAskTool, type AskToolContext } from "./ask.js";
import { type CheckpointRewindState, type TodoJournalState } from "./session-tree.js";
import { runWebSearchTool, type WebSearchToolContext } from "./web-search.js";
import { runGenerateImageTool, type GenerateImageToolContext } from "./generate-image.js";
import {
  applyParams,
  clonePhases,
  formatSummary,
  resolveTodoParams,
  type TodoOperation,
  type TodoPhase,
} from "./todo-state.js";

/**
 * DO-local executors for `edge`-class tools (control-plane-layer.md §1.2,
 * M1.5 T1): execution consumes this DO only — session state is the journal
 * (DO storage writes), never a cross-DO RPC (practice 11).
 *
 * Result discipline mirrors the host path: the executor returns a terminal
 * payload; the DO persists it as a `tool.result` row (persist, then wake —
 * iron rule 1). omp's tool `details` objects ({entryId,bytes},
 * {requested:true},{recorded:true}) are UI-side metadata with no
 * `tool.result` field to land in; the model-visible surface is `output`.
 */

export interface EdgeToolResult {
  /** "cancelled" lands when the owning call/turn was cancelled while the
   * edge executor was blocked or mid-transport (wait wake race; web_search
   * outbound fetch — omp throwIfAborted rethrow semantics). */
  status: "ok" | "error" | "cancelled";
  output: string;
  /**
   * B2 (#322): host-disk paths this call produced (generate_image only).
   * executeEdgeLocal forwards them into the ToolResultPayload, whose fold
   * lands one `imageView` journal row per image BEFORE the closing
   * tool.result (ingestResult — the B1 event chain; parentToolCallId = the
   * bare call executionId).
   */
  images?: { path: string }[];
}

/** Storage seam the DO binds at execution time — keeps executors pure. */
export interface EdgeToolContext {
  /** Owning execution — todo journal writes key on it for re-ask idempotency. */
  readonly executionId: string;
  /** Owning thread — checkpoint/rewind projection pairs tool rows by executionId. */
  readonly threadId: string;
  /** Append one notebook revision as a journal entry (DO storage write). */
  appendNotebookRevision(text: string): Promise<void>;
  /** Project the latest visible notebook revision from the journal. */
  notebook(): Promise<{ text: string } | undefined>;
  /** Blocking-wait surface — bound only for `wait` (omp WaitTool session
   * deps); the DO owns journal accessors, alarm tables and the wake map. */
  wait?: WaitToolContext;
  /** Blocking-ask surface — bound only for `ask` (omp AskTool session UI
   * deps project to the DO-bound pending-interaction channel, M1.5 T4). */
  ask?: AskToolContext;
  /**
   * Subagent-spawn surface — bound only for `task` (M1.5 T16); the DO owns
   * the journal, the AGENT_DO namespace seam and the wake channel.
   */
  task?: TaskToolContext;
  /** Outbound-search surface — bound only for `web_search` (M1.5 T12):
   * decoded config, the owning call's cancel signal, and the DO's fetch. */
  webSearch?: WebSearchToolContext;
  /**
   * Image-source surface — bound only for `generate_image` (B2 #322):
   * the panel-resolved 产图源 config (#448), the owning call's cancel
   * signal, the DO's fetch, and the daemon-service thread-file seams.
   */
  generateImage?: GenerateImageToolContext;
  /**
   * Yield-gate fold source — bound only for `yield` (M1.5 T17): the child
   * journal accessor the schema/empty streaks and the identity schema read.
   */
  yieldJournal?: () => Promise<AnyAgentEvent[]>;
  /**
   * Fold the todo journal: latest canonical snapshot plus any snapshot this
   * execution already committed (crash window recovery — session-tree.ts).
   */
  todoState(): Promise<TodoJournalState>;
  /** Append one canonical todo snapshot keyed by the owning execution. */
  appendTodoPhases(op: TodoOperation, phases: TodoPhase[]): Promise<void>;
  /** Project the checkpoint/rewind pair state from the journal rows. */
  checkpointRewindState(): Promise<CheckpointRewindState>;
}

// omp session/context-notes.ts:5-6 — journal entry type + size cap.
export const CONTEXT_NOTES_ENTRY_TYPE = "experimental_context_notes";
export const MAX_CONTEXT_NOTES_BYTES = 16_384;

const CONTEXT_NOTES_ABSENT = "No context notes are stored for this session branch.";
const CONTEXT_NOTES_SAVED = "Context notes saved.";
const NEW_CONTEXT_REQUESTED = "New context window requested.";
const THINK_ECHO = "------";
const CHECKPOINT_ACTIVE = "Checkpoint already active.";
const CHECKPOINT_COMPLETED =
  "Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.";
const NO_ACTIVE_CHECKPOINT = "No active checkpoint. Create a checkpoint before calling rewind.";
const EMPTY_REPORT = "Report cannot be empty.";

/**
 * Latest valid notebook revision, omp session/context-notes.ts:41-49 verbatim
 * walk: newest `experimental_context_notes` entry wins, scanning backwards; a
 * reset boundary hides earlier revisions (the T1 event vocabulary has no
 * reset-boundary type yet — the check lands with the rollover tickets).
 * Malformed historical entries are skipped, never fatal.
 */
export function latestContextNotes(
  events: readonly AnyAgentEvent[],
): { text: string; seq: number } | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type !== CONTEXT_NOTES_ENTRY_TYPE) continue;
    // zod validated the row on both write and read paths (fsm-events), so the
    // omp isContextNotesData shape checks collapse to the byte cap here.
    if (new TextEncoder().encode(event.data.text).byteLength > MAX_CONTEXT_NOTES_BYTES) continue;
    return { text: event.data.text, seq: event.seq };
  }
  return undefined;
}

/**
 * Turn-scoped `new_context` signal projection (omp agent-session.ts:2108-2114
 * consumption shape): true when a `new_context` execution of this turn
 * terminalized `ok`. The signal IS the durable tool.call/tool.result pair —
 * replay-derivable, no second authority. This is the freeze surface the
 * rollover/compaction tickets consume (they commit the boundary here; M1.5 T1
 * ships the signal surface only).
 */
export function rolloverRequestedInTurn(
  events: readonly AnyAgentEvent[],
  threadId: string,
  turnId: string,
): boolean {
  const callExecutionIds = events
    .filter(
      (event) =>
        event.type === "tool.call" &&
        event.data.tool === "new_context" &&
        event.data.turnId === turnId,
    )
    .map((event) => executionIdFor(threadId, event.seq));
  if (callExecutionIds.length === 0) return false;
  return events.some(
    (event) =>
      event.type === "tool.result" &&
      callExecutionIds.includes(event.data.executionId) &&
      event.data.status === "ok",
  );
}

/**
 * Execute one edge tool call: registry-row schema validates arguments (the
 * row is the schema authority — omp verbatim rejection behavior), then the
 * per-tool body runs. Every branch is omp-verbatim (`T:context-notes.ts`
 * ContextNotesTool/NewContextTool execute, `T:think.ts` execute,
 * `T:todo.ts` TodoTool execute, `T:checkpoint.ts` CheckpointTool/RewindTool
 * execute — ToolError paths render as `error` status with the message).
 */
export async function runEdgeTool(
  row: ToolRegistryRow,
  args: Record<string, unknown>,
  ctx: EdgeToolContext,
): Promise<EdgeToolResult> {
  if (row.name === "todo") {
    // Before the generic gate: omp sets lenientArgValidation (todo.ts:723),
    // so raw args reach execute() on schema failure and resolveTodoParams
    // repairs the one recoverable shape (missing `op`) — a generic early
    // rejection would swallow that repair and the omp error text differs.
    return runTodoTool(args, ctx);
  }

  const validated = row.schema(args);
  if (validated instanceof type.errors) {
    return { status: "error", output: `Invalid arguments: ${validated.summary}` };
  }

  if (row.name === "context_notes") {
    // omp context-notes.ts:108-121 — read projects the latest revision; the
    // byte cap fails BEFORE any append (超限先失败后追加, ticket §3 T1).
    // Registry erasure collapses the row's own inference to `Type`; the row
    // schema just validated this value, so the boundary cast recovers it.
    const params = validated as { text?: string };
    if (params.text === undefined) {
      const notes = await ctx.notebook();
      return { status: "ok", output: notes?.text ?? CONTEXT_NOTES_ABSENT };
    }
    const bytes = new TextEncoder().encode(params.text).byteLength;
    if (bytes > MAX_CONTEXT_NOTES_BYTES) {
      return {
        status: "error",
        output: `Context notes are ${bytes} bytes; the limit is ${MAX_CONTEXT_NOTES_BYTES} UTF-8 bytes. Shorten the notebook and use history://current/full to recover raw detail.`,
      };
    }
    await ctx.appendNotebookRevision(params.text);
    return { status: "ok", output: CONTEXT_NOTES_SAVED };
  }

  if (row.name === "new_context") {
    // omp context-notes.ts:172-179 — acknowledge only; the owning turn
    // lifecycle consumes the signal (see rolloverRequestedInTurn).
    return { status: "ok", output: NEW_CONTEXT_REQUESTED };
  }

  if (row.name === "think") {
    // omp think.ts:61-71 — private scratchpad, zero I/O.
    return { status: "ok", output: THINK_ECHO };
  }

  if (row.name === "wait") {
    // omp WaitTool.execute — blocks on the DO-bound wake race until an owned
    // job settles, a peer message arrives, the cap/window elapses, or the
    // call aborts (see tools/wait.ts for the omp-verbatim structure).
    if (ctx.wait === undefined) {
      return { status: "error", output: "wait requires the DO-bound blocking context." };
    }
    return runWaitTool(ctx.wait);
  }

  if (row.name === "task") {
    // omp task/index.ts execute (edge half, M1.5 T16): journal-first spawn
    // plan → child AgentDO bring-up → per-item mode (blocking inline park /
    // background T2 registration). Bound only with the DO context.
    // Lenient routing (omp lenientArgValidation, task/index.ts:619-629): a
    // schema failure (e.g. the T18 batch container `{context, tasks[]}`,
    // which the flat T16 row schema does not describe) passes the RAW args
    // through — the executor's resolveSpawnItems self-check speaks with the
    // omp-verbatim rejection text instead of an arktype summary.
    if (ctx.task === undefined) {
      return { status: "error", output: "task requires the DO-bound spawn context." };
    }
    return runTaskTool(
      validated instanceof type.errors ? args : (validated as Record<string, unknown>),
      ctx.task,
    );
  }

  if (row.name === "yield") {
    // omp YieldTool.execute (M1.5 T17 full semantics): shape validation +
    // outputSchema quality gate (3-strike override/fail) over the child
    // journal fold; ladder/supersession live in the DO driver verdict.
    return runYieldTool(
      validated as YieldToolArgs,
      ctx.yieldJournal === undefined ? undefined : { events: ctx.yieldJournal },
    );
  }

  if (row.name === "ask") {
    // omp AskTool.execute — registers the pending interaction (bb
    // interactive-request shape), blocks on the DO wake channel until the
    // SPA ruling backflows, the turn aborts, or the ask-timeout arm fires.
    if (ctx.ask === undefined) {
      return { status: "error", output: "ask requires the DO-bound pending-interaction context." };
    }
    return runAskTool(args, ctx.ask);
  }

  if (row.name === "checkpoint") {
    // omp checkpoint.ts:72-86 — reject nested checkpoints, then acknowledge.
    // No journal write: the ok tool.result row IS the boundary marker (omp
    // docs/tools/checkpoint.md §Side Effects — "there is no separate
    // checkpoint-marker entry"), folded by session-tree.ts.
    const state = await ctx.checkpointRewindState();
    if (state.phase === "active") {
      return { status: "error", output: CHECKPOINT_ACTIVE };
    }
    const params = validated as { goal: string };
    return {
      status: "ok",
      output: [`Checkpoint: ${params.goal}`, "Finish exploration and formulate findings."].join(
        "\n",
      ),
    };
  }

  if (row.name === "rewind") {
    // omp checkpoint.ts:108-130 — state check first (completed-rewind vs
    // idle distinction), then the trimmed-report guard; the ok result is
    // only the request — the branchWithSummary cut applies at turn end
    // (activeBranchAfterRewind projection; rollover tickets commit it).
    const state = await ctx.checkpointRewindState();
    if (state.phase !== "active") {
      return {
        status: "error",
        output: state.phase === "completed" ? CHECKPOINT_COMPLETED : NO_ACTIVE_CHECKPOINT,
      };
    }
    const params = validated as { report: string };
    const report = params.report.trim();
    if (report.length === 0) {
      return { status: "error", output: EMPTY_REPORT };
    }
    return {
      status: "ok",
      output: ["Rewind requested.", "Report captured for context replacement."].join("\n"),
    };
  }

  if (row.name === "web_search") {
    // omp WebSearchTool.execute — engine chain walk in tools/web-search.ts;
    // provider failures return `Error: …` text, abort rethrows as cancelled.
    if (ctx.webSearch === undefined) {
      return { status: "error", output: "web_search requires the DO-bound network context." };
    }
    return runWebSearchTool(validated as Parameters<typeof runWebSearchTool>[0], ctx.webSearch);
  }

  if (row.name === "generate_image") {
    // omp imageGenTool.execute (image-gen.ts:232-335) over the single
    // seat-resolved image source; the save leg lands the bytes on the host
    // disk via the daemon-service write seam. Abort rethrows as cancelled.
    if (ctx.generateImage === undefined) {
      return {
        status: "error",
        output:
          "generate_image requires the DO-bound image-source context (the selected 产图源 provider row).",
      };
    }
    return runGenerateImageTool(
      validated as Parameters<typeof runGenerateImageTool>[0],
      ctx.generateImage,
    );
  }

  return { status: "error", output: `No edge executor for tool ${row.name}.` };
}

/**
 * omp todo.ts:730-768 (TodoTool.execute) verbatim. The snapshot write is
 * keyed to this execution (todo_phases.executionId): a crash between the
 * journal append and the tool.result append re-asks the executor, and the
 * interrupted snapshot completes the run instead of re-applying a
 * non-idempotent op (init/append/rm all reject their own replay).
 */
async function runTodoTool(
  args: Record<string, unknown>,
  ctx: EdgeToolContext,
): Promise<EdgeToolResult> {
  const { previous, interrupted } = await ctx.todoState();
  if (interrupted !== undefined) {
    return { status: "ok", output: formatSummary(interrupted, [], false) };
  }
  const previousPhases = clonePhases(previous);
  const resolved = resolveTodoParams(args, previousPhases.length > 0);
  if (typeof resolved === "string") {
    return { status: "error", output: resolved };
  }
  // Pure-view calls are reads: no normalization, no state write.
  const readOnly = resolved.op === "view";
  const { phases: updated, errors } = readOnly
    ? { phases: previousPhases, errors: [] as string[] }
    : applyParams(clonePhases(previousPhases), resolved);
  // A batch with any error is discarded wholesale: persisting a
  // half-applied batch makes the natural retry hit "already exists" for
  // the ops that did land. State and rendered summary stay at previous.
  const failed = errors.length > 0;
  const effective = failed ? previousPhases : updated;
  if (!readOnly && !failed) await ctx.appendTodoPhases(resolved.op, updated);
  return {
    status: failed ? "error" : "ok",
    output: formatSummary(effective, errors, readOnly),
  };
}
