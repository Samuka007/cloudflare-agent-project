import {
  buildThreadEvent,
  parseThreadEvent,
  type BackgroundTaskItem,
  type ThreadEventEnvelope,
} from "@cap/protocol";
import type { AnyAgentEvent, SubagentActivityUnit } from "./fsm-events.js";
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
  const turnIdByExecution = new Map<string, string>();
  /**
   * #275 J2/J3 delegation projection state. All maps derive from the journal
   * alone, so a full re-projection is byte-identical (replay-stable fold).
   */
  interface SpawnAnchor {
    /** Delegation row id — the plan's per-item executionId. */
    executionId: string;
    /** J1 attribution anchor (bare call executionId); child-side mirrors too. */
    parentToolCallId: string;
    turnId: string | null;
    mode: "blocking" | "background";
    task: string;
    agent: string;
    childThreadId: string;
    parentThreadId: string;
  }
  const spawnAnchors = new Map<string, SpawnAnchor>();
  /** First-terminal-wins (tombstone resistance, T16/T19 fold semantics). */
  const terminalSpawns = new Set<string>();
  /** bb task_progress 500ms throttle (CLAUDE_TASK_PROGRESS_THROTTLE_MS). */
  const BACKGROUND_TASK_PROGRESS_THROTTLE_MS = 500;
  const lastBackgroundProgressAt = new Map<string, number>();
  /**
   * #276 J6 tier-1 accumulation: per-model-call CoT text folded from the
   * journal's inline `model.thinking` rows (blob rows are skipped upstream —
   * an unresolvable call simply gets no terminal row), consumed by the
   * `model.call_completed` case.
   */
  const thinkingByCall = new Map<string, string>();

  /**
   * bb generational item id (task-translation.ts:119-121): `task:<taskId>
   * #<generation>` — a repeated taskId restarts a FRESH row instead of
   * reviving the settled one. The generation segment stays in the scheme
   * (bb precedent carried over) even though ours is always 0: spawn ids are
   * spawn-unique and the plan row is a per-spawnId CAS (recovery re-dispatch
   * re-adopts, never re-plans), so a repeated spawnId — and with it a
   * generation >0 — has no producer today.
   */
  const backgroundItemId = (spawnId: string): string => `task:${spawnId}#0`;

  const backgroundTaskItem = (
    anchor: SpawnAnchor,
    spawnId: string,
    taskStatus: BackgroundTaskItem["taskStatus"],
    summary?: string,
  ): BackgroundTaskItem => {
    const status =
      taskStatus === "completed"
        ? "completed"
        : taskStatus === "failed" || taskStatus === "killed"
          ? "failed"
          : taskStatus === "stopped"
            ? "interrupted"
            : "pending";
    return {
      type: "backgroundTask",
      id: backgroundItemId(spawnId),
      taskType: "local_subagent",
      description: anchor.task,
      status,
      taskStatus,
      skipTranscript: false,
      ...(summary !== undefined ? { summary } : {}),
      ...(status === "failed" && summary !== undefined ? { error: summary } : {}),
      parentToolCallId: anchor.parentToolCallId,
    };
  };

  const threadScoped = (
    event: AnyAgentEvent,
    type: "item/backgroundTask/progress" | "item/backgroundTask/completed",
    item: BackgroundTaskItem,
  ): ThreadEventEnvelope =>
    buildThreadEvent({
      id: event.id,
      threadId: event.threadId,
      seq: event.seq,
      type,
      data: { item },
      createdAt: event.createdAt,
    });

  /**
   * #276 J5: one `task.subagent_event` wrapper row → the attributed ux row
   * the wrapped child activity/CoT summary unfolds into (omp `subagent_event`
   * frame → provider-neutral row). Shapes mirror what the child's own ux
   * face produced for the same source rows: tool dispatch/completion as
   * turn-scoped toolCall items, per-call CoT as the J6 reasoning terminal,
   * per-call answer text as the agentMessage completion — every row pinned
   * to the delegation row through `parentToolCallId`, so the server's J4
   * aggregation nests them into childRows.
   */
  const subagentActivityEnvelope = (
    event: AnyAgentEvent,
    unit: SubagentActivityUnit,
    parentToolCallId: string,
  ): ThreadEventEnvelope => {
    const base = {
      id: event.id,
      threadId: event.threadId,
      seq: event.seq,
      createdAt: event.createdAt,
    };
    if (unit.kind === "tool_started") {
      return buildThreadEvent({
        ...base,
        type: "item/started",
        data: {
          turnId: unit.turnId,
          item: {
            type: "toolCall",
            id: unit.executionId,
            tool: unit.tool,
            arguments: unit.arguments,
            status: "pending",
            output: "",
            completedAt: null,
            parentToolCallId,
          },
        },
      });
    }
    if (unit.kind === "tool_completed") {
      // Same status mapping as the root tool.result projection above.
      return buildThreadEvent({
        ...base,
        type: "item/completed",
        data: {
          turnId: unit.turnId,
          item: {
            type: "toolCall",
            id: unit.executionId,
            tool: unit.tool,
            arguments: {},
            status:
              unit.status === "ok"
                ? "completed"
                : unit.status === "outcome_unknown"
                  ? "interrupted"
                  : "failed",
            output: unit.output,
            completedAt: unit.completedAt,
            parentToolCallId,
          },
        },
      });
    }
    if (unit.kind === "thinking") {
      // J6 CoT terminal shape (attributed): the call's accumulated thinking
      // as one reasoning item. The pinned SPA ignores reasoning rows (reasoning
      // never becomes a timeline row — #3250 port is tier 2, another ticket);
      // the rows ride the ux face so tier 2 needs no further journal work.
      return buildThreadEvent({
        ...base,
        type: "item/completed",
        data: {
          turnId: unit.turnId,
          item: {
            type: "reasoning",
            id: `itm-rs-${unit.turnId}:${unit.modelCallId}`,
            summary: [],
            content: [unit.text],
            parentToolCallId,
          },
        },
      });
    }
    return buildThreadEvent({
      ...base,
      type: "item/completed",
      data: {
        turnId: unit.turnId,
        item: {
          type: "agentMessage",
          id: `itm-am-${unit.turnId}:${unit.modelCallId}`,
          text: unit.text,
          parentToolCallId,
        },
      },
    });
  };
  for (const event of events) {
    const turnId: string | undefined = "turnId" in event.data ? event.data.turnId : undefined;
    let ux: ThreadEventEnvelope | null = null;
    // #276 J6 tier-1: the reasoning terminal rows ride alongside the main
    // 1:1 row (thinking precedes the answer it produced).
    const extraUx: ThreadEventEnvelope[] = [];
    switch (event.type) {
      // No UX rendering: the SPA rebuilds these from item lifecycle events.
      case "thread.created":
      // #288 rebind: binding truth is state (thread header read face), not a
      // timeline row; the SPA surface is the environments family's job.
      case "thread.rebound":
      case "model.call_retry":
      case "experimental_context_notes":
      // M1.5 T2 JobRegistry journal family: projected by tools/job-registry,
      // not part of the UX envelope (same rule as experimental_context_notes).
      case "job.delivered":
      case "job.registered":
      case "job.settled":
      case "peer.message":
      case "peer.message_consumed":
      // M1.5 T16 task/subagent journal family. spawn_planned/settled and
      // subagent_aborted now carry the delegation row (#275 J2/J3 cases
      // below); async_result is model-visible injection bookkeeping whose
      // row already completed via spawn_settled.
      case "task.async_result":
        break;
      // #275 J1 child-side anchor: the child journal is self-attributing
      // (its parked/revived/aborted rows join the PARENT delegation row
      // through this parentToolCallId). No ux row of its own.
      case "task.subagent_identity": {
        const { parentToolCallId } = event.data;
        if (parentToolCallId === undefined) break;
        spawnAnchors.set(event.data.spawnId, {
          executionId: event.data.spawnId,
          parentToolCallId,
          turnId: null,
          mode: "background",
          task: "",
          agent: event.data.agentId,
          childThreadId: event.threadId,
          parentThreadId: event.data.parentThreadId,
        });
        break;
      }
      // M1.5 T17 yield-gate journal family: folded by tools/task/child-run,
      // not part of the UX envelope (same rule as the task family above).
      case "task.yield_reminder":
      case "task.yield_warning":
      case "task.yield_completed":
      case "task.budget_notice":
      // #276 J5: the flush cursor is fold bookkeeping with no ux row (the
      // wrapper rows themselves unfold in their own case below).
      case "task.subagent_flush":
      // M1.5 T19 lifecycle rows (parked/revived/aborted) carry the
      // background-delegation lifecycle on the ux face now — #275 J2/J3
      // cases below (tools/task/lifecycle still folds the registry state).
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
      case "model.thinking": {
        // #257 CoT stream — 1:1 row → `item/reasoning/textDelta` (bb event
        // name; M0 folds the bb summary field). Same answer-text guards as
        // the agentMessage delta: blob-offloaded rows and empties contribute
        // nothing to the UX face (the raw log view carries the blob).
        const { text, modelCallId } = event.data;
        if (typeof text !== "string" || text === "" || turnId === undefined) break;
        thinkingByCall.set(
          `${turnId}:${modelCallId}`,
          (thinkingByCall.get(`${turnId}:${modelCallId}`) ?? "") + text,
        );
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "item/reasoning/textDelta",
          data: {
            turnId,
            itemId: `itm-rs-${turnId}:${modelCallId}`,
            delta: text,
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "model.call_completed": {
        const text = event.data.text;
        if (turnId === undefined) break;
        // #276 J6 tier 1 (zero SPA change): the call's CoT terminal row —
        // `item/completed` + reasoning item, the journal's accumulated
        // `model.thinking` text finally materialized on the ux face. The
        // pinned SPA ignores reasoning rows today (reasoning never becomes a
        // timeline row; the upstream #3250 row rendering is tier 2, another
        // ticket) — landing the row now is the tier-2-ready journal face.
        const thinkingKey = `${turnId}:${event.data.modelCallId}`;
        const thinking = thinkingByCall.get(thinkingKey);
        thinkingByCall.delete(thinkingKey);
        if (thinking !== undefined && thinking !== "") {
          extraUx.push(
            buildThreadEvent({
              id: event.id,
              threadId: event.threadId,
              seq: event.seq,
              type: "item/completed",
              data: {
                turnId,
                item: {
                  type: "reasoning",
                  id: `itm-rs-${turnId}:${event.data.modelCallId}`,
                  summary: [],
                  content: [thinking],
                },
              },
              createdAt: event.createdAt,
            }),
          );
        }
        if (text === "") break;
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
      case "model.usage_receipt": {
        // #308: the receipt is its own journal row, so its ux row carries its
        // own seq (the events view's strict unique-seq contract). Emitted
        // only when the receipt carries a window — a null window means the
        // deployment cannot name a percentage, and guessing is worse than
        // absence (bb extract treats a null-window chain as unknown the same
        // way).
        const { usage } = event.data;
        if (usage.contextWindow === null) break;
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "thread/contextWindowUsage/updated",
          data: {
            contextWindowUsage: {
              usedTokens:
                usage.inputTokens +
                usage.outputTokens +
                usage.cacheReadInputTokens +
                usage.cacheCreationInputTokens,
              modelContextWindow: usage.contextWindow,
              estimated: usage.estimated,
            },
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "tool.call": {
        const executionId = executionIdFor(event.threadId, event.seq);
        toolByExecution.set(executionId, event.data.tool);
        turnIdByExecution.set(executionId, event.data.turnId);
        if (event.data.tool === "task") {
          // #275 J2 transport folding (#229 §2.3-1): the native task tool call
          // is only the transport that creates the child; the synthetic
          // toolCall{spawnAgent} delegation row (from task.spawn_planned)
          // replaces it — showing both creates the duplicate non-delegation
          // parent that hides its child body (bb 0d00d9c67 lesson).
          break;
        }
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
        if (toolByExecution.get(executionId) === "task") {
          // Transport folding: background registrations settle as `ok`
          // receipts (noise); a non-ok result is the only surviving cancel
          // signal for a delegation row whose settle row never landed.
          if (status !== "ok") {
            for (const [spawnId, anchor] of spawnAnchors) {
              if (anchor.parentToolCallId !== executionId) continue;
              // Child-side anchors have no placement turn — a turn-scoped
              // completion cannot address them (and journal-local execution
              // ids can never match across DOs anyway).
              if (anchor.turnId === null) continue;
              if (terminalSpawns.has(spawnId)) continue;
              terminalSpawns.add(spawnId);
              out.push(
                buildThreadEvent({
                  id: event.id,
                  threadId: event.threadId,
                  seq: event.seq,
                  type: "item/completed",
                  data: {
                    turnId: anchor.turnId,
                    item: {
                      type: "toolCall",
                      id: anchor.executionId,
                      tool: "spawnAgent",
                      arguments: {},
                      status: "interrupted",
                      output: "",
                      completedAt: event.createdAt,
                    },
                  },
                  createdAt: event.createdAt,
                }),
              );
            }
          }
          break;
        }
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
      case "task.spawn_planned": {
        // #275 J2: the delegation row. One synthetic toolCall{spawnAgent} per
        // spawn item; `subagent_type` rides the synthetic arguments so the
        // SPA badge is free (#229 S1+S3). Pre-J1 journals (no attribution
        // anchor) keep their old face: no delegation row.
        const data = event.data;
        const { parentToolCallId } = data;
        if (parentToolCallId === undefined) break;
        // No placement turn → no delegation row (the turn-scoped item/started
        // is the row's only placement).
        const turnId = turnIdByExecution.get(parentToolCallId);
        if (turnId === undefined) break;
        const anchor: SpawnAnchor = {
          executionId: data.executionId,
          parentToolCallId,
          turnId,
          mode: data.mode,
          task: data.task,
          agent: data.agent,
          childThreadId: data.childThreadId,
          parentThreadId: data.parentThreadId,
        };
        spawnAnchors.set(data.spawnId, anchor);
        ux = buildThreadEvent({
          id: event.id,
          threadId: event.threadId,
          seq: event.seq,
          type: "item/started",
          data: {
            turnId,
            item: {
              type: "toolCall",
              id: anchor.executionId,
              tool: "spawnAgent",
              arguments: {
                senderThreadId: anchor.parentThreadId,
                receiverThreadIds: [anchor.childThreadId],
                description: anchor.task,
                subagent_type: anchor.agent,
              },
              status: "pending",
              output: "",
              completedAt: null,
            },
          },
          createdAt: event.createdAt,
        });
        break;
      }
      case "task.spawn_settled": {
        // #275 J2/J3 terminal backflow. Blocking settles inside the spawning
        // turn (turn-scoped item/completed); background rows live across
        // turns, so the terminal rides the thread-scoped backgroundTask
        // family (no turnId — bb threadScope rationale). First terminal
        // wins: a late settle after a kill tombstone confirms, never flips.
        const data = event.data;
        const anchor = spawnAnchors.get(data.spawnId);
        if (anchor?.parentToolCallId === undefined || terminalSpawns.has(data.spawnId)) break;
        terminalSpawns.add(data.spawnId);
        const status = data.status === "ok" ? "completed" : "failed";
        if (anchor.mode === "blocking" && anchor.turnId !== null) {
          ux = buildThreadEvent({
            id: event.id,
            threadId: event.threadId,
            seq: event.seq,
            type: "item/completed",
            data: {
              turnId: anchor.turnId,
              item: {
                type: "toolCall",
                id: anchor.executionId,
                tool: "spawnAgent",
                arguments: {},
                status,
                output: data.output,
                completedAt: event.createdAt,
              },
            },
            createdAt: event.createdAt,
          });
          break;
        }
        ux = threadScoped(
          event,
          "item/backgroundTask/completed",
          backgroundTaskItem(anchor, data.spawnId, status, data.output),
        );
        break;
      }
      case "task.subagent_aborted": {
        // #275 J2: kill/call_signal/wall_clock/internal are terminal
        // tombstones (interrupted); "budget" is the only revivable abort
        // (four-state fold maps it to idle) — the row stays pending.
        const data = event.data;
        if (data.reason === "budget") break;
        const anchor = spawnAnchors.get(data.spawnId);
        if (anchor?.parentToolCallId === undefined || terminalSpawns.has(data.spawnId)) break;
        terminalSpawns.add(data.spawnId);
        if (anchor.mode === "blocking" && anchor.turnId !== null) {
          ux = buildThreadEvent({
            id: event.id,
            threadId: event.threadId,
            seq: event.seq,
            type: "item/completed",
            data: {
              turnId: anchor.turnId,
              item: {
                type: "toolCall",
                id: anchor.executionId,
                tool: "spawnAgent",
                arguments: {},
                status: "interrupted",
                output: "",
                completedAt: event.createdAt,
              },
            },
            createdAt: event.createdAt,
          });
          break;
        }
        ux = threadScoped(
          event,
          "item/backgroundTask/completed",
          backgroundTaskItem(anchor, data.spawnId, "stopped"),
        );
        break;
      }
      case "task.subagent_parked":
      case "task.subagent_revived": {
        // #275 J3 progress family: the still-alive cross-turn lifecycle
        // states (parked = paused/resumable, revived = running). Throttled per item
        // at bb's 500ms task_progress cadence; journal timestamps make the
        // fold deterministic across replays.
        const data = event.data;
        const anchor = spawnAnchors.get(data.spawnId);
        if (anchor?.parentToolCallId === undefined || terminalSpawns.has(data.spawnId)) break;
        const item = backgroundTaskItem(
          anchor,
          data.spawnId,
          event.type === "task.subagent_parked" ? "paused" : "running",
        );
        const last = lastBackgroundProgressAt.get(item.id);
        if (last !== undefined && event.createdAt - last < BACKGROUND_TASK_PROGRESS_THROTTLE_MS) {
          break;
        }
        lastBackgroundProgressAt.set(item.id, event.createdAt);
        ux = threadScoped(event, "item/backgroundTask/progress", item);
        break;
      }
      case "task.subagent_event": {
        // #276 J5: the journal-first backflow unfolds in place — each
        // wrapper row becomes the attributed ux row its unit describes
        // (tool dispatch/completion, per-call CoT terminal, per-call
        // answer text), all pinned to the delegation row through the J1
        // anchor. Anchorless rows (pre-J1 plans, unknown spawns) keep the
        // old face: nothing on the ux view.
        const data = event.data;
        const anchor = spawnAnchors.get(data.spawnId);
        if (anchor?.parentToolCallId === undefined) break;
        ux = subagentActivityEnvelope(event, data.unit, anchor.parentToolCallId);
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
    // Extras (the J6 reasoning terminals) precede the main row — a call's
    // thinking precedes the answer it produced.
    const emitted = ux === null ? extraUx : [...extraUx, ux];
    for (const row of emitted) {
      parseThreadEvent(row);
      out.push(row);
    }
  }
  return out;
}
