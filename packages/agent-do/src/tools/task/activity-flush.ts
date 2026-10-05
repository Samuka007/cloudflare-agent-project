import { isBlobRef, type AnyAgentEvent, type SubagentActivityUnit } from "../../fsm-events.js";
import { executionIdFor } from "../../ids.js";

/**
 * #276 J5 subagent activity flush — the journal-pure fold that derives one
 * flush batch's activity/CoT summary units from the CHILD journal (the
 * journal-first arm of #256 G4: the parent journals wrapper rows, its ux
 * view unfolds them — no cross-DO read-through, replay-stable).
 *
 * Both directions are folds over the log alone:
 * - `lastActivityFlushThroughSeq` reads the child-side cursor
 *   (`task.subagent_flush`), and
 * - `projectActivityFlush` re-derives the exact units for everything after
 *   that cursor. A crash between the parent RPC and the cursor append
 *   re-derives identical units; the parent's (spawnId, kind, sourceSeq)
 *   dedup absorbs the re-send.
 *
 * Unit ordering inside a batch follows the source rows' journal order
 * (stable sort by `sourceSeq`), so the parent's ux childRows preserve the
 * child's own activity order.
 */

/** omp delivery-summary doctrine (result-summary.ts:16): never journal oversize. */
function capText(text: string, capChars: number): string {
  return text.length > capChars ? `${text.slice(0, capChars)}\n…[truncated]` : text;
}

/** Latest `task.subagent_flush` cursor, or 0 when the child never flushed. */
export function lastActivityFlushThroughSeq(events: readonly AnyAgentEvent[]): number {
  let throughSeq = 0;
  for (const event of events) {
    if (event.type === "task.subagent_flush" && event.data.throughSeq > throughSeq) {
      throughSeq = event.data.throughSeq;
    }
  }
  return throughSeq;
}

interface CallThinking {
  text: string;
  blob: boolean;
  lastSeq: number;
}

/**
 * Derive the flush batch for child rows in `(sinceSeq, …]`. `capChars` caps
 * every text/output field (parent re-caps defensively too — settleSpawn's
 * "never journal oversize" rule on both ends).
 */
export function projectActivityFlush(
  events: readonly AnyAgentEvent[],
  sinceSeq: number,
  capChars: number,
): { units: SubagentActivityUnit[]; throughSeq: number } {
  const thinkingByCall = new Map<string, CallThinking>();
  const toolCallsByExecution = new Map<
    string,
    { seq: number; turnId: string; tool: string; arguments: Record<string, unknown> }
  >();
  const toolResultsByExecution = new Map<
    string,
    {
      seq: number;
      turnId: string;
      tool: string;
      status: "ok" | "error" | "timeout" | "cancelled" | "outcome_unknown";
      output: string;
      completedAt: number;
    }
  >();
  const messages: Extract<SubagentActivityUnit, { kind: "message" }>[] = [];
  let throughSeq = sinceSeq;

  for (const event of events) {
    if (event.seq <= sinceSeq) continue;
    throughSeq = Math.max(throughSeq, event.seq);
    switch (event.type) {
      case "model.thinking": {
        const { turnId, modelCallId, text } = event.data;
        const key = `${turnId}:${modelCallId}`;
        const current = thinkingByCall.get(key) ?? { text: "", blob: false, lastSeq: event.seq };
        if (isBlobRef(text)) {
          // Blob rows resolve transparently on log.read; a raw/unresolved row
          // means the text cannot be summarized verbatim — carry the fact so
          // the unit degrades to the readable prefix only.
          current.blob = true;
        } else if (text !== "") {
          current.text += text;
        }
        current.lastSeq = event.seq;
        thinkingByCall.set(key, current);
        break;
      }
      case "model.call_completed": {
        // A bare tool-call turn (e.g. the yield) has no answer text — an
        // empty message unit would materialize an empty assistant row.
        if (event.data.text === "") break;
        messages.push({
          kind: "message",
          sourceSeq: event.seq,
          turnId: event.data.turnId,
          modelCallId: event.data.modelCallId,
          text: capText(event.data.text, capChars),
        });
        break;
      }
      case "tool.call": {
        toolCallsByExecution.set(executionIdFor(event.threadId, event.seq), {
          seq: event.seq,
          turnId: event.data.turnId,
          tool: event.data.tool,
          arguments: event.data.arguments,
        });
        break;
      }
      case "tool.result": {
        const call = toolCallsByExecution.get(event.data.executionId);
        const output = isBlobRef(event.data.output) ? "" : event.data.output;
        toolResultsByExecution.set(event.data.executionId, {
          seq: event.seq,
          turnId: event.data.turnId,
          tool: call?.tool ?? "unknown",
          status: event.data.status,
          output: capText(output, capChars),
          completedAt: event.createdAt,
        });
        break;
      }
      // Everything else carries no flushable activity (turn bookkeeping,
      // model stream transport, the task/lifecycle/interaction families,
      // this module's own cursor rows).
      case "experimental_context_notes":
      // #288: binding rows are thread-scoped state, never child-journal units.
      case "thread.rebound":
      // #309: the compact checkpoint is cut-fold bookkeeping, not activity.
      case "thread/compacted":
      case "interaction.interrupted":
      case "interaction.registered":
      case "interaction.resolved":
      // B1 (#321): no flushable child activity (the ux projection owns the row).
      case "imageView":
      case "job.delivered":
      case "job.registered":
      case "job.settled":
      case "model.call_failed":
      case "model.call_retry":
      case "model.call_sealed":
      case "model.call_started":
      case "model.delta":
      case "model.usage_receipt":
      case "peer.message":
      case "peer.message_consumed":
      case "task.async_result":
      case "task.budget_notice":
      case "task.spawn_planned":
      case "task.spawn_settled":
      case "task.subagent_aborted":
      case "task.subagent_event":
      case "task.subagent_flush":
      case "task.subagent_identity":
      case "task.subagent_parked":
      case "task.subagent_revived":
      case "task.yield_completed":
      case "task.yield_reminder":
      case "task.yield_warning":
      case "thread.created":
      case "todo_phases":
      case "tool.dispatch":
      case "tool.exec_started":
      case "tool.output":
      case "turn.cancel_requested":
      case "turn.cancelled":
      case "turn.completed":
      case "turn.failed":
      case "turn.input":
      case "turn.phase":
      case "turn.steer":
        break;
    }
  }

  // Merge the four streams in source-row order (stable sort keeps each
  // stream's internal order; ties impossible — one seq, one row).
  const units: SubagentActivityUnit[] = [];
  for (const [executionId, call] of toolCallsByExecution) {
    units.push({
      kind: "tool_started",
      sourceSeq: call.seq,
      turnId: call.turnId,
      executionId,
      tool: call.tool,
      arguments: call.arguments,
    });
  }
  for (const [executionId, result] of toolResultsByExecution) {
    units.push({
      kind: "tool_completed",
      sourceSeq: result.seq,
      turnId: result.turnId,
      executionId,
      tool: result.tool,
      status: result.status,
      output: result.output,
      completedAt: result.completedAt,
    });
  }
  for (const [key, thinking] of thinkingByCall) {
    if (thinking.blob || thinking.text === "") continue;
    const separator = key.indexOf(":");
    units.push({
      kind: "thinking",
      sourceSeq: thinking.lastSeq,
      turnId: key.slice(0, separator),
      modelCallId: Number(key.slice(separator + 1)),
      text: capText(thinking.text, capChars),
    });
  }
  units.push(...messages);
  units.sort((a, b) => a.sourceSeq - b.sourceSeq);
  return { units, throughSeq };
}
