import { type } from "arktype";
import type { AnyAgentEvent } from "../fsm-events.js";
import { executionIdFor } from "../ids.js";
import type { ToolRegistryRow } from "./registry.js";
import { runWaitTool, type WaitToolContext } from "./wait.js";

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
   * edge executor was blocked (wait); T1 rows only produce ok|error. */
  status: "ok" | "error" | "cancelled";
  output: string;
}

/** Storage seam the DO binds at execution time — keeps executors pure. */
export interface EdgeToolContext {
  /** Append one notebook revision as a journal entry (DO storage write). */
  appendNotebookRevision(text: string): Promise<void>;
  /** Project the latest visible notebook revision from the journal. */
  notebook(): Promise<{ text: string } | undefined>;
  /** Blocking-wait surface — bound only for `wait` (omp WaitTool session
   * deps); the DO owns journal accessors, alarm tables and the wake map. */
  wait?: WaitToolContext;
}

// omp session/context-notes.ts:5-6 — journal entry type + size cap.
export const CONTEXT_NOTES_ENTRY_TYPE = "experimental_context_notes";
export const MAX_CONTEXT_NOTES_BYTES = 16_384;

const CONTEXT_NOTES_ABSENT = "No context notes are stored for this session branch.";
const CONTEXT_NOTES_SAVED = "Context notes saved.";
const NEW_CONTEXT_REQUESTED = "New context window requested.";
const THINK_ECHO = "------";

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
 * ContextNotesTool/NewContextTool execute, `T:think.ts` execute).
 */
export async function runEdgeTool(
  row: ToolRegistryRow,
  args: Record<string, unknown>,
  ctx: EdgeToolContext,
): Promise<EdgeToolResult> {
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

  return { status: "error", output: `No edge executor for tool ${row.name}.` };
}
