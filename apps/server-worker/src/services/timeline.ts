import { timelineRowSchema, type TimelineRow } from "../contract/thread-timeline.js";
import { threadEventDataSchemas } from "@cap/protocol";
import type { JsonValue } from "../contract/domain/json-value.js";
import type { UxThreadEvent } from "../seam/agent-do.js";

/**
 * M0 timeline projection: AgentDO UX-projected events (protocol union —
 * turn/started, item/started, item/agentMessage/delta, item/completed,
 * turn/completed, system/error) → bb timeline rows
 * (contract/thread-timeline.ts). bb's full projection lives in
 * packages/thread-view + services/threads/timeline.ts and covers dozens of
 * event types; the M0 face covers the subset the mock-completed turn
 * mechanism produces (spec #17: model relay missing → mock provider). Event
 * → row mapping follows the same anchors bb uses: stable item ids as row ids,
 * sourceSeqStart/End from event sequences, status from item/turn completion.
 */

const PREVIEW_MAX_CHARS = 512;

type RowDraft = TimelineRow & { __order: number };

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
      part !== null && typeof part === "object" &&
      (part as EventData).type === "text" && typeof (part as EventData).text === "string"
        ? ((part as EventData).text as string)
        : "")
    .join("");
}

export function projectTimelineRows(events: readonly UxThreadEvent[]): TimelineRow[] {
  const rows = new Map<string, RowDraft>();
  const assistantByItemId = new Map<string, string>();
  const turnPendingRowIds = new Map<string, Set<string>>();

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
    });
    assistantByItemId.set(rawItemId, rowId);
    if (turnId) {
      registerTurnRow(turnId, rowId);
    }
    return rowId;
  };

  for (const event of events) {
    const raw: EventData =
      event.data !== null && typeof event.data === "object"
        ? (event.data as EventData)
        : {};
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
            attachments: null,
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
          });
          assistantByItemId.set(item.id, rowId);
          if (turnId) {
            registerTurnRow(turnId, rowId);
          }
        } else if (item.type === "toolCall") {
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
            toolArgs: (item.arguments ?? null) as Record<string, JsonValue> | null,
            output: item.output,
            completedAt: item.completedAt,
            approvalStatus: null,
            activityIntents: [],
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
        );
        const row = rowId ? rows.get(rowId) : undefined;
        if (row && row.kind === "conversation" && row.role === "assistant") {
          row.text += parsed.data.delta;
          row.sourceSeqEnd = event.seq;
        }
        break;
      }
      case "item/completed": {
        const parsed = threadEventDataSchemas["item/completed"].safeParse(raw);
        if (!parsed.success) {
          break;
        }
        const item = parsed.data.item;
        const assistantRowId =
          item.type === "agentMessage"
            ? ensureAssistantRow(item.id, pickTurnId(raw), event.threadId, event.seq, event.createdAt)
            : assistantByItemId.get(item.id);
        const assistantRow = assistantRowId ? rows.get(assistantRowId) : undefined;
        if (assistantRow && assistantRow.kind === "conversation") {
          if (item.type === "agentMessage" && item.text.length > 0) {
            assistantRow.text = item.text;
          }
          assistantRow.sourceSeqEnd = event.seq;
          break;
        }
        const workRow = rows.get(item.id);
        if (workRow && workRow.kind === "work" && workRow.workKind === "tool") {
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
        }
        break;
      }
      case "turn/completed": {
        const parsed = threadEventDataSchemas["turn/completed"].safeParse(raw);
        if (!parsed.success) {
          break;
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
          if (row.kind === "work" && row.workKind === "tool" && row.status === "pending") {
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
      case "system/error": {
        const parsed = threadEventDataSchemas["system/error"].safeParse(raw);
        const rowId = `syserr:${event.id}`;
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
          title: parsed.success ? parsed.data.category : "error",
          detail: parsed.success ? parsed.data.message : null,
          status: null,
          __order: event.seq,
        });
        break;
      }
      default:
        // turn/started and other UX types produce no standalone M0 row.
        break;
    }
  }

  const ordered = [...rows.values()].sort((a, b) =>
    a.__order === b.__order ? a.id.localeCompare(b.id) : a.__order - b.__order,
  );
  return ordered.map(({ __order, ...row }) => {
    void __order;
    return timelineRowSchema.parse(row) as TimelineRow;
  });
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
    query.kind === "older" && query.beforeAnchor !== undefined
      ? query.beforeAnchor
      : undefined;
  const eligible =
    anchor !== undefined
      ? allRows.filter(
          (row) =>
            row.sourceSeqStart < anchor.anchorSeq || row.id !== anchor.anchorId,
        )
      : allRows;
  const start = Math.max(0, eligible.length - query.segmentLimit);
  const rows = eligible.slice(start, start + query.segmentLimit);
  const hasOlderRows = anchor !== undefined || start > 0;
  const firstRow = rows[0];
  return {
    rows,
    page: {
      kind: query.kind,
      segmentLimit: query.segmentLimit,
      returnedSegmentCount: rows.length,
      hasOlderRows: anchor !== undefined || eligible.length > query.segmentLimit,
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
): Array<ConversationOutlineItem> {
  const items: Array<ConversationOutlineItem> = [];
  for (const row of allRows) {
    if (row.kind !== "conversation") {
      continue;
    }
    const preview = row.text.replace(/\s+/g, " ").trim();
    items.push({
      id: row.id,
      role: row.role,
      preview:
        preview.length > PREVIEW_MAX_CHARS
          ? `${preview.slice(0, PREVIEW_MAX_CHARS)}…`
          : preview,
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
