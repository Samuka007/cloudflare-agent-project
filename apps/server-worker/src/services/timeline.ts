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

/**
 * bb error titles render on a single line and truncate (thread-view
 * error-display.ts:31-34): past 80 chars the row swaps in the generic
 * "System error" label and moves the full text into the detail body.
 */
const MAX_ERROR_TITLE_LENGTH = 80;

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
      part !== null &&
      typeof part === "object" &&
      (part as EventData).type === "text" &&
      typeof (part as EventData).text === "string"
        ? ((part as EventData).text as string)
        : "",
    )
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
            // The protocol item schema requires `arguments`, so the value is
            // always a record after the safeParse gate above.
            toolArgs: item.arguments as Record<string, JsonValue> | null,
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
        if (row?.kind === "conversation" && row.role === "assistant") {
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
            ? ensureAssistantRow(
                item.id,
                pickTurnId(raw),
                event.threadId,
                event.seq,
                event.createdAt,
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
        if (workRow?.kind === "work" && workRow.workKind === "tool") {
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
      default:
        // turn/started and other UX types produce no standalone M0 row.
        break;
    }
  }

  const ordered = [...rows.values()].sort((a, b) =>
    a.__order === b.__order ? a.id.localeCompare(b.id) : a.__order - b.__order,
  );
  return ordered.map(({ __order: _, ...row }) => timelineRowSchema.parse(row));
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
