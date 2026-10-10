import {
  type TimelineConversationAttachments,
  timelineRowSchema,
  type TimelineDelegationWorkRow,
  type TimelineRow,
} from "../contract/thread-timeline.js";
import { backgroundTaskItemStatus } from "../contract/domain/background-task.js";
import { threadEventDataSchemas, type PromptContent } from "@cap/protocol";
import { activeThinkingSchema, type ActiveThinking } from "../contract/domain/active-thinking.js";
import type { ThreadContextWindowUsage } from "../contract/api/shared.js";
import type { JsonValue } from "../contract/domain/json-value.js";
import type { UxThreadEvent } from "../seam/agent-do.js";

/**
 * Retired M0 timeline projection (the "porting layer"): AgentDO UX-projected
 * events (protocol union — turn/started, item/started, item/agentMessage/
 * delta, item/completed, turn/completed, system/error) → bb timeline rows
 * (contract/thread-timeline.ts).
 *
 * #560 switched the routes to the bb direct-import face
 * (services/thread-view.ts → @cap/agent-do/thread-view). These functions are
 * no longer called in production; they remain as the path-A oracle of the
 * CI diff harness (test/thread-view-diff-harness.test.ts), which pins the
 * materializer+thread-view projection against them line by line, and they
 * retire once the bb pin ships the upstream Thought-row creation side (D4)
 * and the harness's equivalence debt is settled (#554 roadmap step 5).
 * Pagination/cache/outline (below the oracle block) remain the LIVE
 * implementation.
 */

const PREVIEW_MAX_CHARS = 512;

/**
 * bb error titles render on a single line and truncate (thread-view
 * error-display.ts:31-34): past 80 chars the row swaps in the generic
 * "System error" label and moves the full text into the detail body.
 */
const MAX_ERROR_TITLE_LENGTH = 80;

/**
 * `__parentCallId` carries #274 J1 delegation attribution: ux items with a
 * `parentToolCallId` fold into that delegation row's `childRows` at assembly
 * instead of the top-level timeline (#275 J4) — bb thread-view aggregates the
 * child projection the same way.
 */
type RowDraft = TimelineRow & { __order: number; __parentCallId?: string };

type EventData = Record<string, unknown>;

function pickTurnId(data: EventData): string | null {
  return typeof data.turnId === "string" ? data.turnId : null;
}

/**
 * bb joins the text parts of a prompt-content array into the row preview
 * (packages/thread-view user-message projection). Non-text parts contribute
 * nothing to the M0 face.
 */
function textOfContent(content: readonly unknown[]): string {
  return content
    .map((part) =>
      part !== null &&
      typeof part === "object" &&
      (part as EventData).type === "text" &&
      typeof (part as EventData).text === "string"
        ? ((part as EventData).text as string)
        : "",
    )
    .join("");
}

/**
 * #320 A5: the user row's attachment block, derived from the prompt content —
 * bb thread-view user-message-parsing.ts parsePromptInput (attachment
 * counting) + build-thread-timeline.ts toConversationAttachments (array
 * fills). image parts count as web images and collect their URLs;
 * localImage/localFile parts collect their server-managed paths. Content with
 * no attachment parts projects null, preserving the shipped M0 row shape for
 * text-only history (upstream builds a zero-count object instead — the SPA
 * renders both identically: ConversationAttachments.tsx:128 early-return).
 * The upstream `visibility: "agent-only"` skip does not apply: the journal
 * carries runtime truth only (protocol events.ts #317 note).
 */
function conversationAttachmentsOf(
  content: readonly PromptContent[],
): TimelineConversationAttachments | null {
  let webImages = 0;
  let localImages = 0;
  let localFiles = 0;
  const imageUrls: string[] = [];
  const localImagePaths: string[] = [];
  const localFilePaths: string[] = [];
  for (const part of content) {
    if (part.type === "image") {
      webImages += 1;
      if (part.url.length > 0) {
        imageUrls.push(part.url);
      }
    } else if (part.type === "localImage") {
      localImages += 1;
      if (part.path.length > 0) {
        localImagePaths.push(part.path);
      }
    } else if (part.type === "localFile") {
      localFiles += 1;
      if (part.path.length > 0) {
        localFilePaths.push(part.path);
      }
    }
  }
  if (webImages === 0 && localImages === 0 && localFiles === 0) {
    return null;
  }
  return { webImages, localImages, localFiles, imageUrls, localImagePaths, localFilePaths };
}

// --- delegation rows (#275 J4) --------------------------------------------------------

type DelegationRowDraft = TimelineDelegationWorkRow & {
  __order: number;
  __parentCallId?: string;
};

function isDelegationDraft(row: RowDraft): row is DelegationRowDraft {
  return row.kind === "work" && row.workKind === "delegation";
}

/**
 * Resolve the delegation row a thread-scoped backgroundTask event folds into:
 * the #274 J1 attribution anchor (the bare task-call executionId) for flat
 * spawns. Batch plans suffix per-item `#<i>` dedup keys onto the shared bare
 * anchor, so an unmatched anchor falls back to the first still-pending
 * per-item row in plan order — deterministic, and each settle seals exactly
 * one row.
 */
function delegationTargetFor(
  rows: ReadonlyMap<string, RowDraft>,
  anchor: string | undefined,
): DelegationRowDraft | undefined {
  if (anchor === undefined) {
    return undefined;
  }
  const direct = rows.get(anchor);
  if (direct !== undefined && isDelegationDraft(direct) && direct.status === "pending") {
    return direct;
  }
  const prefix = `${anchor}#`;
  const pending = [...rows.values()]
    .filter(
      (row): row is DelegationRowDraft =>
        isDelegationDraft(row) && row.status === "pending" && row.callId.startsWith(prefix),
    )
    .sort((a, b) =>
      a.__order === b.__order ? a.callId.localeCompare(b.callId) : a.__order - b.__order,
    );
  return pending[0];
}

// --- activeThinking (#257 CoT surface) ------------------------------------------------

/**
 * bb durationToCompactString (thread-view format-helpers.ts:41-68) port: the
 * compact duration the reasoning row title carries. Sub-second renders as
 * milliseconds; minutes/hours split into joined h/m/s parts.
 */
export function durationToCompactString(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
}

// --- reasoning operation rows (#303 J6 档 2, bb #3250) --------------------------------

/**
 * bb MAX_REASONING_DETAIL_CHARS (thread-view reasoning-lifecycle-projection.
 * ts) port: past 32k the row detail truncates with a tail-counted suffix —
 * the full text stays on the ux/raw event faces.
 */
const MAX_REASONING_DETAIL_CHARS = 32_000;
const REASONING_DETAIL_TRUNCATION_SUFFIX_TAIL = " more characters truncated]";

export function truncateReasoningDetail(detail: string): string {
  if (detail.length <= MAX_REASONING_DETAIL_CHARS) {
    return detail;
  }
  const dropped = detail.length - MAX_REASONING_DETAIL_CHARS;
  return `${detail.slice(0, MAX_REASONING_DETAIL_CHARS)}\n…[${dropped.toLocaleString("en-US")}${REASONING_DETAIL_TRUNCATION_SUFFIX_TAIL}`;
}

/**
 * bb ActiveThinkingLifecycle (reasoning-lifecycle-projection.ts:19-28) M0
 * shape: one open reasoning stream per ux itemId. `#3250` materializes it as
 * an operation row only at completion, and the completion also closes the
 * lifecycle (#543) — the durable row owns the display from that instant, so
 * no pending reasoning row ever doubles the indicator.
 */
interface ReasoningLifecycle {
  itemId: string;
  turnId: string | null;
  parentCallId?: string;
  text: string;
  startedAt: number;
  firstSeq: number;
  lastSeq: number;
}

interface ThinkingLifecycle {
  id: string;
  text: string;
  startedAt: number;
  updatedAt: number;
  lastSeq: number;
}

/**
 * bb buildProjectionActiveThinking (thread-view reasoning-lifecycle-
 * projection.ts:85-106) M0 fold: the thread's live chain-of-thought text,
 * surfaced only while the thread has an active turn. One lifecycle per
 * reasoning item (`itm-rs-<turnId>:<modelCallId>`, folded from the ux
 * projection of the journal's `model.thinking` rows); `item/reasoning/
 * textDelta` appends; the same call's `item/completed` reasoning closes it —
 * bb's close point (assistant-event-projection.ts:174-187), and since #303
 * (upstream #3250 port) the same completion materializes the persistent
 * Thought row that then owns the display (#543: the earlier answer-delta-only
 * close double-showed the completed text and stuck on tool-call-only turns).
 * The answer-delta sweep remains as the unfinished-stream fallback (an
 * aborted call never completes; its text dies with the turn). The latest
 * lifecycle by last delta seq wins (bb isNewerActiveThinkingLifecycle seq
 * tie-break); everything drops when the thread leaves `active` (bb
 * threadStatus gate).
 */
export function buildActiveThinking(
  events: readonly UxThreadEvent[],
  threadStatus: string,
): ActiveThinking | null {
  if (threadStatus !== "active") {
    return null;
  }
  const lifecycles = new Map<string, ThinkingLifecycle>();
  for (const event of events) {
    if (event.type === "item/reasoning/textDelta") {
      const parsed = threadEventDataSchemas["item/reasoning/textDelta"].safeParse(event.data);
      if (!parsed.success) {
        continue;
      }
      const { itemId, delta } = parsed.data;
      const existing = lifecycles.get(itemId);
      lifecycles.set(itemId, {
        id: itemId,
        text: (existing?.text ?? "") + delta,
        startedAt: existing?.startedAt ?? event.createdAt,
        updatedAt: event.createdAt,
        lastSeq: event.seq,
      });
      continue;
    }
    if (event.type === "item/completed") {
      // #543: bb closes the lifecycle at the reasoning item's completion
      // (thread-view assistant-event-projection.ts:174-187 — finalize at
      // item/completed reasoning). The answer-delta sweep below was the M0
      // pin-semantics deviation: between the reasoning terminal and the first
      // answer delta, a refetch showed BOTH the durable Thought row and the
      // live indicator with identical text; a tool-call-only call (no answer
      // ever) kept the stale thinking on the indicator for the whole tool
      // run. Once the terminal row exists it owns the display.
      const parsed = threadEventDataSchemas["item/completed"].safeParse(rawEventData(event));
      if (parsed.success && parsed.data.item.type === "reasoning") {
        lifecycles.delete(parsed.data.item.id);
      }
      continue;
    }
    if (event.type === "item/agentMessage/delta") {
      const turnId = pickTurnId(rawEventData(event));
      if (turnId === null) {
        continue;
      }
      for (const itemId of lifecycles.keys()) {
        if (itemId.startsWith(`itm-rs-${turnId}:`)) {
          lifecycles.delete(itemId);
        }
      }
    }
  }
  let latest: ThinkingLifecycle | null = null;
  for (const lifecycle of lifecycles.values()) {
    if (latest === null || lifecycle.lastSeq > latest.lastSeq) {
      latest = lifecycle;
    }
  }
  if (latest === null) {
    return null;
  }
  return activeThinkingSchema.parse({
    id: latest.id,
    text: latest.text,
    startedAt: latest.startedAt,
    updatedAt: latest.updatedAt,
  });
}

// --- contextWindowUsage (#308 tail-only state) ---------------------------------------

/**
 * bb extractThreadContextWindowUsage (thread-view thread-context-window-usage.ts)
 * M0 fold: the thread's latest context-window fill, the timeline response's
 * tail-only `contextWindowUsage` field (bb data.ts gates it on the latest
 * page the same way as activeThinking/pendingTodos). Newest-row-wins over the
 * `thread/contextWindowUsage/updated` rows the ux projection emits from
 * `model.call_completed{usage}`; our producer only emits complete rows (both
 * members numbered), so bb's null-chain walk collapses to last-wins. Null
 * when the thread has no row — the SPA then renders no indicator, never a
 * guessed percentage.
 */
export function buildContextWindowUsage(
  events: readonly UxThreadEvent[],
): ThreadContextWindowUsage | null {
  let latest: { seq: number; usage: ThreadContextWindowUsage } | null = null;
  for (const event of events) {
    if (event.type !== "thread/contextWindowUsage/updated") continue;
    const parsed = threadEventDataSchemas["thread/contextWindowUsage/updated"].safeParse(
      event.data,
    );
    if (!parsed.success) continue;
    // bb sorts by seq before the newest-first walk; a max-seq scan is the
    // same verdict without the copy (journal reads arrive seq-ordered anyway).
    if (latest === null || event.seq > latest.seq) {
      latest = { seq: event.seq, usage: parsed.data.contextWindowUsage };
    }
  }
  return latest?.usage ?? null;
}

function rawEventData(event: UxThreadEvent): EventData {
  return event.data !== null && typeof event.data === "object" ? (event.data as EventData) : {};
}

export function projectTimelineRows(events: readonly UxThreadEvent[]): TimelineRow[] {
  const rows = new Map<string, RowDraft>();
  const assistantByItemId = new Map<string, string>();
  const turnPendingRowIds = new Map<string, Set<string>>();
  // #303 (bb #3250): open reasoning streams; materialized into operation rows
  // at the reasoning completion, sealed as interrupted at turn completion.
  const reasoningLifecycles = new Map<string, ReasoningLifecycle>();
  const reasoningRowIds = new Set<string>();

  const registerTurnRow = (turnId: string, rowId: string): void => {
    let ids = turnPendingRowIds.get(turnId);
    if (!ids) {
      ids = new Set();
      turnPendingRowIds.set(turnId, ids);
    }
    ids.add(rowId);
  };

  /**
   * Agent-message items have no item/started event: they materialize from
   * the first delta or the completion (bb assembles the assistant row the
   * same way from the stream). Registered in `assistantByItemId` so later
   * deltas/completions find it.
   */
  const ensureAssistantRow = (
    rawItemId: string,
    turnId: string | null,
    threadId: string,
    seq: number,
    createdAt: number,
    parentCallId?: string,
  ): string | undefined => {
    const existing = assistantByItemId.get(rawItemId);
    if (existing !== undefined) {
      return existing;
    }
    const rowId = `assistant:${rawItemId}`;
    rows.set(rowId, {
      kind: "conversation",
      role: "assistant",
      id: rowId,
      threadId,
      turnId,
      sourceSeqStart: seq,
      sourceSeqEnd: seq,
      startedAt: createdAt,
      createdAt,
      text: "",
      attachments: null,
      turnRequest: null,
      __order: seq,
      ...(parentCallId !== undefined ? { __parentCallId: parentCallId } : {}),
    });
    assistantByItemId.set(rawItemId, rowId);
    if (turnId) {
      registerTurnRow(turnId, rowId);
    }
    return rowId;
  };

  /**
   * bb finalizeReasoningLifecycleByKey (reasoning-lifecycle-projection.ts:
   * 196-235): the completed Thought row — "Thought for Ns" title, prose
   * detail, canonical `reasoningId` (the ux itemId, which is also the live
   * `activeThinking` id). Empty text produces no row (bb returns null).
   */
  const materializeReasoningRow = (
    lifecycle: ReasoningLifecycle,
    status: "completed" | "interrupted",
    event: UxThreadEvent,
    finalText?: string,
  ): void => {
    if (reasoningRowIds.has(lifecycle.itemId)) {
      return;
    }
    reasoningRowIds.add(lifecycle.itemId);
    reasoningLifecycles.delete(lifecycle.itemId);
    const text = (finalText ?? lifecycle.text).trim();
    if (text.length === 0) {
      return;
    }
    const rowId = `reasoning:${lifecycle.itemId}`;
    rows.set(rowId, {
      kind: "system",
      systemKind: "operation",
      operationKind: "reasoning",
      id: rowId,
      reasoningId: lifecycle.itemId,
      threadId: event.threadId,
      turnId: lifecycle.turnId,
      sourceSeqStart: lifecycle.firstSeq,
      sourceSeqEnd: event.seq,
      startedAt: lifecycle.startedAt,
      createdAt: event.createdAt,
      title: `Thought for ${durationToCompactString(event.createdAt - lifecycle.startedAt)}`,
      detail: truncateReasoningDetail(text),
      status,
      completedAt: event.createdAt,
      // #543: the row sorts at its stream position — the FIRST thinking
      // delta's seq — not at the completion's. The ux completion shares the
      // journal row with the answer's own completion (ux-projection extraUx
      // same-seq precedent), so ordering by event.seq sank every Thought
      // below the answer it preceded (live repro: thinking deltas at seq
      // 5/20, answer deltas at 7-11/22-26, yet the rows rendered
      // [assistant][Thought]). firstSeq is monotone per call and interleaves
      // correctly with tool/answer rows.
      __order: lifecycle.firstSeq,
      ...(lifecycle.parentCallId !== undefined ? { __parentCallId: lifecycle.parentCallId } : {}),
    });
  };

  for (const event of events) {
    const raw: EventData =
      event.data !== null && typeof event.data === "object" ? (event.data as EventData) : {};
    const turnId = pickTurnId(raw);

    switch (event.type) {
      case "item/started": {
        const parsed = threadEventDataSchemas["item/started"].safeParse(raw);
        if (!parsed.success) {
          break;
        }
        const item = parsed.data.item;
        if (item.type === "userMessage") {
          rows.set(item.id, {
            kind: "conversation",
            role: "user",
            id: item.id,
            threadId: event.threadId,
            turnId,
            sourceSeqStart: event.seq,
            sourceSeqEnd: event.seq,
            startedAt: event.createdAt,
            createdAt: event.createdAt,
            text: textOfContent(item.content),
            // #320 A5: bb user-message-parsing parsePromptInput counts — the
            // row-level gap the pinned SPA's ConversationAttachments renders.
            attachments: conversationAttachmentsOf(item.content),
            initiator: "user",
            senderThreadId: null,
            systemMessageKind: "unlabeled",
            systemMessageSubject: null,
            turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
            mentions: [],
            __order: event.seq,
          });
          if (turnId) {
            registerTurnRow(turnId, item.id);
          }
        } else if (item.type === "agentMessage") {
          const rowId = `assistant:${item.id}`;
          rows.set(rowId, {
            kind: "conversation",
            role: "assistant",
            id: rowId,
            threadId: event.threadId,
            turnId,
            sourceSeqStart: event.seq,
            sourceSeqEnd: event.seq,
            startedAt: event.createdAt,
            createdAt: event.createdAt,
            text: "",
            attachments: null,
            turnRequest: null,
            __order: event.seq,
            ...(item.parentToolCallId !== undefined
              ? { __parentCallId: item.parentToolCallId }
              : {}),
          });
          assistantByItemId.set(item.id, rowId);
          if (turnId) {
            registerTurnRow(turnId, rowId);
          }
        } else if (item.type === "toolCall") {
          if (item.tool === "spawnAgent") {
            // #275 J4 delegation branch: the synthetic toolCall{spawnAgent}
            // item (from task.spawn_planned) materializes the contract's
            // TimelineDelegationWorkRow; subagentType/description ride the
            // synthetic arguments (#229 S1+S3 badge data). Never registered
            // as turn-pending — a background delegation outlives its
            // spawning turn, so the turn/completed sweep must not seal it.
            rows.set(item.id, {
              kind: "work",
              workKind: "delegation",
              id: item.id,
              threadId: event.threadId,
              turnId,
              sourceSeqStart: event.seq,
              sourceSeqEnd: event.seq,
              startedAt: event.createdAt,
              createdAt: event.createdAt,
              status: "pending",
              callId: item.id,
              toolName: item.tool,
              subagentType:
                typeof item.arguments.subagent_type === "string" &&
                item.arguments.subagent_type.length > 0
                  ? item.arguments.subagent_type
                  : null,
              description:
                typeof item.arguments.description === "string" &&
                item.arguments.description.length > 0
                  ? item.arguments.description
                  : null,
              output: item.output,
              completedAt: item.completedAt,
              childRows: [],
              __order: event.seq,
            });
            break;
          }
          rows.set(item.id, {
            kind: "work",
            workKind: "tool",
            id: item.id,
            threadId: event.threadId,
            turnId,
            sourceSeqStart: event.seq,
            sourceSeqEnd: event.seq,
            startedAt: event.createdAt,
            createdAt: event.createdAt,
            status: "pending",
            callId: item.id,
            toolName: item.tool,
            // The protocol item schema requires `arguments`, so the value is
            // always a record after the safeParse gate above.
            toolArgs: item.arguments as Record<string, JsonValue> | null,
            output: item.output,
            completedAt: item.completedAt,
            approvalStatus: null,
            activityIntents: [],
            __order: event.seq,
            ...(item.parentToolCallId !== undefined
              ? { __parentCallId: item.parentToolCallId }
              : {}),
          });
          if (turnId) {
            registerTurnRow(turnId, item.id);
          }
        }
        if (item.type === "imageView") {
          // B1 (#321): bb build-thread-timeline.ts:674-683 — the imageView
          // item materializes the `image-view` work row (top-level; the
          // SPA's ImageViewWorkRowBody renders it with the lightbox). The
          // row id / callId = the item id (bb web-activity-lifecycle.ts:79-85
          // callId semantics); pending until the same-row item/completed.
          rows.set(item.id, {
            kind: "work",
            workKind: "image-view",
            id: item.id,
            threadId: event.threadId,
            turnId,
            sourceSeqStart: event.seq,
            sourceSeqEnd: event.seq,
            startedAt: event.createdAt,
            createdAt: event.createdAt,
            status: "pending",
            callId: item.id,
            path: item.path,
            completedAt: null,
            __order: event.seq,
          });
          if (turnId) {
            registerTurnRow(turnId, item.id);
          }
        }
        break;
      }
      case "item/agentMessage/delta": {
        const parsed = threadEventDataSchemas["item/agentMessage/delta"].safeParse(raw);
        if (!parsed.success) {
          break;
        }
        const rowId = ensureAssistantRow(
          parsed.data.itemId,
          pickTurnId(raw),
          event.threadId,
          event.seq,
          event.createdAt,
          parsed.data.parentToolCallId,
        );
        const row = rowId ? rows.get(rowId) : undefined;
        if (row?.kind === "conversation" && row.role === "assistant") {
          row.text += parsed.data.delta;
          row.sourceSeqEnd = event.seq;
        }
        break;
      }
      case "item/reasoning/textDelta": {
        const parsed = threadEventDataSchemas["item/reasoning/textDelta"].safeParse(raw);
        if (!parsed.success) {
          break;
        }
        const { itemId, delta, parentToolCallId } = parsed.data;
        const existing = reasoningLifecycles.get(itemId);
        reasoningLifecycles.set(itemId, {
          itemId,
          turnId: pickTurnId(raw),
          parentCallId: existing?.parentCallId ?? parentToolCallId,
          text: (existing?.text ?? "") + delta,
          startedAt: existing?.startedAt ?? event.createdAt,
          firstSeq: existing?.firstSeq ?? event.seq,
          lastSeq: event.seq,
        });
        break;
      }
      case "item/completed": {
        const parsed = threadEventDataSchemas["item/completed"].safeParse(raw);
        if (!parsed.success) {
          break;
        }
        const item = parsed.data.item;
        if (item.type === "reasoning") {
          // #303: the call's CoT terminal (bb item/completed reasoning) —
          // the accumulated text materializes as the expandable Thought row.
          const lifecycle = reasoningLifecycles.get(item.id);
          if (lifecycle === undefined) {
            break;
          }
          materializeReasoningRow(lifecycle, "completed", event, item.content.join(""));
          break;
        }
        const assistantRowId =
          item.type === "agentMessage"
            ? ensureAssistantRow(
                item.id,
                pickTurnId(raw),
                event.threadId,
                event.seq,
                event.createdAt,
                item.parentToolCallId,
              )
            : assistantByItemId.get(item.id);
        const assistantRow = assistantRowId ? rows.get(assistantRowId) : undefined;
        if (assistantRow?.kind === "conversation") {
          if (item.type === "agentMessage" && item.text.length > 0) {
            assistantRow.text = item.text;
          }
          assistantRow.sourceSeqEnd = event.seq;
          break;
        }
        const workRow = rows.get(item.id);
        if (
          workRow?.kind === "work" &&
          (workRow.workKind === "tool" || workRow.workKind === "delegation")
        ) {
          if (item.type === "toolCall") {
            workRow.output = item.output;
            workRow.completedAt = item.completedAt ?? event.createdAt;
            workRow.status =
              item.status === "failed"
                ? "error"
                : item.status === "interrupted"
                  ? "interrupted"
                  : "completed";
          }
          workRow.sourceSeqEnd = event.seq;
        } else if (
          workRow?.kind === "work" &&
          workRow.workKind === "image-view" &&
          item.type === "imageView"
        ) {
          // bb tool-activity-web-projection.ts:129-131: the end event
          // refreshes the path (begin can address a path that moved) and
          // seals the row completed at the event's time.
          workRow.path = item.path;
          workRow.completedAt = event.createdAt;
          workRow.status = "completed";
          workRow.sourceSeqEnd = event.seq;
        }
        break;
      }
      case "turn/completed": {
        const parsed = threadEventDataSchemas["turn/completed"].safeParse(raw);
        if (!parsed.success) {
          break;
        }
        // #303 (bb finalizeOpenReasoningLifecyclesForTurn): a turn that ends
        // with reasoning still open (interrupted call) seals the row as
        // interrupted — the text is preserved for review, matching bb's
        // terminal-record behavior. Runs before the pending-row sweep's
        // early return: a turn without open tool rows still seals thoughts.
        for (const lifecycle of [...reasoningLifecycles.values()]) {
          if (lifecycle.turnId !== turnId) {
            continue;
          }
          materializeReasoningRow(lifecycle, "interrupted", event);
        }
        const pendingIds = turnId ? turnPendingRowIds.get(turnId) : undefined;
        if (!pendingIds) {
          break;
        }
        for (const rowId of pendingIds) {
          const row = rows.get(rowId);
          if (!row) {
            continue;
          }
          if (
            row.kind === "work" &&
            (row.workKind === "tool" || row.workKind === "image-view") &&
            row.status === "pending"
          ) {
            row.status =
              parsed.data.status === "failed"
                ? "error"
                : parsed.data.status === "interrupted"
                  ? "interrupted"
                  : "completed";
            row.completedAt = event.createdAt;
          }
        }
        break;
      }
      case "item/backgroundTask/progress":
      case "item/backgroundTask/completed": {
        // #275 J3/J4: thread-scoped superseding state for a background
        // delegation (task.spawn_settled terminal / parked-revived progress).
        // The ux projection guarantees first-terminal-wins, so a completed
        // event only ever seals a still-pending row. Progress is non-terminal
        // by contract (paused/running) and leaves the M0 row untouched — it
        // exists so replayed journals keep the family in the ux face.
        const parsed = threadEventDataSchemas[event.type].safeParse(raw);
        if (!parsed.success) {
          break;
        }
        if (event.type === "item/backgroundTask/progress") {
          break;
        }
        const item = parsed.data.item;
        const target = delegationTargetFor(rows, item.parentToolCallId);
        if (target === undefined) {
          break;
        }
        const itemStatus = backgroundTaskItemStatus(item.taskStatus);
        if (itemStatus === "pending") {
          break;
        }
        target.status =
          itemStatus === "failed"
            ? "error"
            : itemStatus === "interrupted"
              ? "interrupted"
              : "completed";
        target.output = item.summary ?? "";
        target.completedAt = event.createdAt;
        target.sourceSeqEnd = event.seq;
        break;
      }
      case "system/error": {
        const parsed = threadEventDataSchemas["system/error"].safeParse(raw);
        const rowId = `syserr:${event.id}`;
        // bb error-row display (thread-view parse-error-message.ts:78 +
        // error-display.ts:112-117): the event's human message is the title;
        // `detail` is a separate event field the M0 producer never emits, so
        // the body stays null — the projection previously surfaced the
        // machine category ("internal") as the title and sealed the message
        // into a detail the row never showed (census #45 P2-9). Titles past
        // MAX_ERROR_TITLE_LENGTH fall back to "System error" with the full
        // text in the detail (error-display.ts:80-89). Non-reconnect error
        // rows carry status "error" (build-thread-timeline.ts:786), which
        // drives the SPA's red badge and terminal auto-expand.
        const message = parsed.success ? parsed.data.message : "";
        const naturalTitle = message.length > 0 ? message : "Error event";
        const overLength = naturalTitle.length > MAX_ERROR_TITLE_LENGTH;
        rows.set(rowId, {
          kind: "system",
          systemKind: "error",
          id: rowId,
          threadId: event.threadId,
          turnId,
          sourceSeqStart: event.seq,
          sourceSeqEnd: event.seq,
          startedAt: event.createdAt,
          createdAt: event.createdAt,
          title: overLength ? "System error" : naturalTitle,
          detail: overLength ? naturalTitle : null,
          status: "error",
          __order: event.seq,
        });
        break;
      }
      case "thread/compacted": {
        // #309: bb parse-operation-message.ts:573-576 maps the compaction
        // marker to a `'compaction'` op row — the SPA renders it as the
        // "Context compacted" system row (System.stories fixture thr_iqcz6et4rd:
        // the row carries only a title and status, never expandable). Our
        // marker is terminal on arrival (the checkpoint appends after the
        // summarization call completed), so the row is born completed.
        rows.set(`compact:${event.id}`, {
          kind: "system",
          systemKind: "operation",
          operationKind: "compaction",
          id: `compact:${event.id}`,
          threadId: event.threadId,
          turnId,
          sourceSeqStart: event.seq,
          sourceSeqEnd: event.seq,
          startedAt: event.createdAt,
          createdAt: event.createdAt,
          title: "Context compacted",
          detail: null,
          status: "completed",
          completedAt: event.createdAt,
          __order: event.seq,
        });
        break;
      }
      default:
        // turn/started and other UX types produce no standalone M0 row.
        break;
    }
  }

  // #275 J4 childRows aggregation: ux rows carrying #274 J1 attribution fold
  // into their delegation row's childRows instead of the top-level timeline
  // (bb thread-view aggregates the child projection by parentToolCallId).
  // Walked NEWEST-first so nested children parse and attach before their
  // parent's recursive schema parse clones them in; `unshift` keeps both the
  // top-level list and each childRows array in ascending __order.
  const newestFirst = [...rows.values()]
    .sort((a, b) => (a.__order === b.__order ? a.id.localeCompare(b.id) : a.__order - b.__order))
    .reverse();
  const topRows: TimelineRow[] = [];
  for (const draft of newestFirst) {
    const { __order: _, __parentCallId, ...row } = draft;
    const parent =
      __parentCallId !== undefined && __parentCallId !== row.id
        ? rows.get(__parentCallId)
        : undefined;
    const parsed = timelineRowSchema.parse(row);
    if (parent !== undefined && isDelegationDraft(parent)) {
      parent.childRows.unshift(parsed);
      continue;
    }
    topRows.unshift(parsed);
  }
  return topRows;
}

// --- diagnostic-row merge (D7 merge seam; the rows themselves moved to
// services/thread-view.ts with the rest of the switched projection) ----------

/**
 * Merge the diagnostic rows into the UX-projected rows in source order —
 * bb projects everything in one pass over the seq-ordered events, so the
 * merged list is seq-ordered with the projection's id tie-break.
 */
export function mergeTimelineRows(
  base: readonly TimelineRow[],
  extra: readonly TimelineRow[],
): TimelineRow[] {
  return [...base, ...extra].sort((a, b) =>
    a.sourceSeqStart === b.sourceSeqStart
      ? a.id.localeCompare(b.id)
      : a.sourceSeqStart - b.sourceSeqStart,
  );
}

// --- paging (bb parseThreadTimelinePage + assembly, data.ts:151-187/2068-2104) --

export interface TimelinePageQuery {
  kind: "latest" | "older";
  segmentLimit: number;
  beforeAnchor?: { anchorSeq: number; anchorId: string };
  summaryOnly?: boolean;
}

export interface TimelinePage {
  rows: TimelineRow[];
  page: {
    kind: "latest" | "older";
    segmentLimit: number;
    returnedSegmentCount: number;
    hasOlderRows: boolean;
    olderCursor: { anchorSeq: number; anchorId: string } | null;
  };
}

export function buildTimelinePage(
  allRows: readonly TimelineRow[],
  query: TimelinePageQuery,
): TimelinePage {
  const anchor =
    query.kind === "older" && query.beforeAnchor !== undefined ? query.beforeAnchor : undefined;
  // bb older windows are strictly-before at the sequence level with only the
  // anchor row itself excluded (timeline-pagination.ts:193-195 slices the
  // eligible set; the anchor identity check is timeline.ts:1514-1519). The
  // previous `seq < anchor || id !== anchorId` let every non-anchor row
  // through regardless of sequence, so an older page re-served the newest
  // rows and the cursor ping-ponged forever (#121).
  const eligible =
    anchor !== undefined
      ? allRows.filter(
          (row) =>
            row.sourceSeqStart < anchor.anchorSeq ||
            (row.sourceSeqStart === anchor.anchorSeq && row.id !== anchor.anchorId),
        )
      : allRows;
  const start = Math.max(0, eligible.length - query.segmentLimit);
  const rows = eligible.slice(start, start + query.segmentLimit);
  // bb infers hasOlderRows from the slice dropping rows
  // (timeline-pagination.ts:194-195 `segments.length > selectedSegments.length`)
  // for BOTH page kinds — an older page touches bottom and returns false, which
  // is what terminates the SPA's fetch-older loop (#121).
  const hasOlderRows = start > 0;
  const firstRow = rows[0];
  return {
    rows,
    page: {
      kind: query.kind,
      segmentLimit: query.segmentLimit,
      returnedSegmentCount: rows.length,
      hasOlderRows,
      olderCursor:
        hasOlderRows && firstRow
          ? { anchorSeq: firstRow.sourceSeqStart, anchorId: firstRow.id }
          : null,
    },
  };
}

// --- delta cache (bb timelineLatestRowsCache, data.ts:385-397) -------------------

interface LatestRowsCacheEntry {
  maxSeq: number;
  rows: TimelineRow[];
}

/**
 * bb keeps this as a process-memory LRU (maxEntries 64); the Worker isolate
 * equivalent below is equally best-effort — eviction or a cold isolate simply
 * degrades to a full-window response, which is exactly bb's cache-miss path.
 */
export class TimelineLatestRowsCache {
  private readonly entries = new Map<string, LatestRowsCacheEntry>();

  constructor(private readonly maxEntries = 64) {}

  get(key: string): LatestRowsCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      // LRU touch
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  put(key: string, entry: LatestRowsCacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}

export const timelineLatestRowsCache = new TimelineLatestRowsCache();

// --- conversation outline (bb buildThreadConversationOutline) --------------------

export interface ConversationOutlineItem {
  id: string;
  role: "user" | "assistant";
  preview: string;
  attachmentSummary: { imageCount: number; fileCount: number } | null;
}

export function buildConversationOutline(
  allRows: readonly TimelineRow[],
): ConversationOutlineItem[] {
  const items: ConversationOutlineItem[] = [];
  for (const row of allRows) {
    if (row.kind !== "conversation") {
      continue;
    }
    const preview = row.text.replace(/\s+/g, " ").trim();
    items.push({
      id: row.id,
      role: row.role,
      preview:
        preview.length > PREVIEW_MAX_CHARS ? `${preview.slice(0, PREVIEW_MAX_CHARS)}…` : preview,
      attachmentSummary:
        row.attachments !== null
          ? {
              imageCount: row.attachments.webImages + row.attachments.localImages,
              fileCount: row.attachments.localFiles,
            }
          : null,
    });
  }
  return items;
}
