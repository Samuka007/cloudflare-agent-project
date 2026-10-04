import { buildThreadEvent, parseThreadEvent, type ThreadEventEnvelope } from "@cap/protocol";
import type { AnyAgentEvent } from "./fsm-events.js";
import { executionIdFor } from "./ids.js";

/**
 * Projection from the internal FSM vocabulary to the frozen protocol UX
 * union (`packages/protocol`). One output envelope per source event (1:1);
 * the transport identity (`id`, `threadId`, `seq`, `createdAt`) is preserved
 * from the source row so a client cursoring this view never sees a seq that
 * the raw log cannot replay (I3 applies to both views).
 *
 * Events with no UX rendering (thread.created, tool.dispatch, tool.output,
 * tool.exec_started, model.call_retry, turn.cancel_requested) are omitted;
 * the SPA rebuilds state from item lifecycle instead.
 */

export function projectToUxEvents(events: readonly AnyAgentEvent[]): ThreadEventEnvelope[] {
  const out: ThreadEventEnvelope[] = [];
  const firstModelCallByTurn = new Map<string, number>();
  const toolByExecution = new Map<string, string>();
  for (const event of events) {
    const turnId: string | undefined = "turnId" in event.data ? event.data.turnId : undefined;
    let ux: ThreadEventEnvelope | null = null;
    switch (event.type) {
      // No UX rendering: the SPA rebuilds these from item lifecycle events.
      case "thread.created":
      case "model.call_retry":
      case "experimental_context_notes":
      // M1.5 T2 JobRegistry journal family: projected by tools/job-registry,
      // not part of the UX envelope (same rule as experimental_context_notes).
      case "job.delivered":
      case "job.registered":
      case "job.settled":
      case "peer.message":
      case "peer.message_consumed":
      // M1.5 T16 task/subagent journal family: projected by tools/task/*,
      // not part of the UX envelope (same rule as the JobRegistry family).
      case "task.spawn_planned":
      case "task.spawn_settled":
      case "task.async_result":
      case "task.subagent_identity":
      // M1.5 T17 yield-gate journal family: folded by tools/task/child-run,
      // not part of the UX envelope (same rule as the task family above).
      case "task.yield_reminder":
      case "task.yield_warning":
      case "task.yield_completed":
      case "task.budget_notice":
      // M1.5 T19 lifecycle journal family: folded by tools/task/lifecycle,
      // not part of the UX envelope (same rule as the task family above).
      case "task.subagent_parked":
      case "task.subagent_revived":
      case "task.subagent_aborted":
      case "todo_phases":
      // M1.5 T4 interaction journal family: the SPA renders the pending
      // interaction from the raw journal rows + the /ws pending-interaction
      // push, not from the UX envelope (same rule as job.*).
      case "interaction.registered":
      case "interaction.resolved":
      case "interaction.interrupted":
      case "tool.exec_started":
      case "tool.output":
      // #148 (streaming contract §9.3): a host_offline dispatch renders as the
      // tool card's placeholder result — `tool.result{status:"error",
      // output:"host_offline"}` lands right after the dispatch and folds into
      // the work row. The former system/error row here preempted the screen
      // mid-turn (thr_jk45qe4786: work::error → system:host_offline:error) and
      // is the banner-ish surface the §9.3 matrix forbids during an active
      // turn; only model.call_sealed/call_failed keep terminal system rows.
      case "tool.dispatch":
      case "turn.cancel_requested":
        break;
      case "turn.input": {
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "item/started",
          data: {
            turnId: event.data.turnId,
            item: {
              type: "userMessage",
              id: `itm-um-${event.data.turnId}:${event.seq}`,
              content: event.data.content,
            },
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "turn.steer": {
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "item/started",
          data: {
            turnId: event.data.turnId,
            item: {
              type: "userMessage",
              id: `itm-st-${event.data.turnId}:${event.seq}`,
              content: event.data.content,
            },
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "model.call_started": {
        if (turnId !== undefined && !firstModelCallByTurn.has(turnId)) {
          firstModelCallByTurn.set(turnId, event.seq);
          ux = buildThreadEvent({
            id: event.id,
            threadId: event.threadId,
            seq: event.seq,
            type: "turn/started",
            data: { turnId },
            createdAt: event.createdAt,
          });
        }
        break;
      }
      case "model.delta": {
        const { text, modelCallId } = event.data;
        if (typeof text !== "string" || text === "" || turnId === undefined) break;
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "item/agentMessage/delta",
          data: {
            turnId,
            itemId: `itm-am-${turnId}:${modelCallId}`,
            delta: text,
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "model.call_completed": {
        const text = event.data.text;
        if (text === "" || turnId === undefined) break;
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "item/completed",
          data: {
            turnId,
            item: {
              type: "agentMessage",
              id: `itm-am-${turnId}:${event.data.modelCallId}`,
              text,
            },
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "tool.call": {
        const executionId = executionIdFor(event.threadId, event.seq);
        toolByExecution.set(executionId, event.data.tool);
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "item/started",
          data: {
            turnId: event.data.turnId,
            item: {
              type: "toolCall",
              id: executionId,
              tool: event.data.tool,
              arguments: event.data.arguments,
              status: "pending",
              output: "",
              completedAt: null,
            },
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "tool.result": {
        const { status, executionId, output } = event.data;
        // Oversize outputs live in R2; the UX view renders the inline portion
        // and the raw log view carries the blob reference for full retrieval.
        const inlineOutput = typeof output === "string" ? output : "";
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "item/completed",
          data: {
            turnId: event.data.turnId,
            item: {
              type: "toolCall",
              id: executionId,
              tool: toolByExecution.get(executionId) ?? "unknown",
              arguments: {},
              status:
                status === "ok"
                  ? "completed"
                  : status === "outcome_unknown"
                    ? "interrupted"
                    : "failed",
              output: inlineOutput,
              completedAt: event.createdAt,
            },
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "model.call_sealed": {
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "system/error",
          data: {
            message: "model stream interrupted mid-call; turn sealed",
            category: "internal",
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "model.call_failed": {
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "system/error",
          data: {
            message: event.data.error,
            category: event.data.aborted === true ? "cancelled" : "internal",
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "turn.completed": {
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "turn/completed",
          data: { turnId: event.data.turnId, status: "completed", error: null },
          createdAt: event.createdAt,
        });
        break;
      }
      case "turn.phase": {
        // #197 D3/spec §4: 1:1 direct projection — transport identity kept
        // verbatim so the ux cursor view replays phases at their journal
        // seqs (the catch-up authority for D4 reconciliation).
        const data = event.data;
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "turn/phase",
          data: {
            turnId: data.turnId,
            phase: data.phase,
            ...(data.modelCallId !== undefined ? { modelCallId: data.modelCallId } : {}),
            ...(data.reason !== undefined ? { reason: data.reason } : {}),
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "turn.failed": {
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "turn/completed",
          data: {
            turnId: event.data.turnId,
            status: "failed",
            error: { category: "internal", message: event.data.reason },
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "turn.cancelled": {
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "turn/completed",
          data: {
            turnId: event.data.turnId,
            status: "interrupted",
            error: { category: "cancelled", message: "turn cancelled" },
          },
          createdAt: event.createdAt,
        });
        break;
      }
    }
    if (ux !== null) {
      parseThreadEvent(ux);
      out.push(ux);
    }
  }
  return out;
}
