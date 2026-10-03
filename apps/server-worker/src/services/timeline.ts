import { timelineRowSchema, type TimelineRow } from "../contract/thread-timeline.js";
import { z } from "zod";
import { jsonValueSchema } from "../contract/domain/json-value.js";
import type { UxThreadEvent } from "../seam/agent-do.js";

/**
 * Event data schemas for the #29 UX projection (packages/agent-do contract).
 * The union members carry what projection needs; unknown fields are allowed
 * forward-compatibly but every read field is validated.
 */
const turnRefSchema = z.object({ turnId: z.string() }).partial();

const userMessageStartedSchema = turnRefSchema.extend({
  kind: z.literal("userMessage"),
  itemId: z.string().optional(),
  text: z.string().optional(),
});

const toolCallStartedSchema = turnRefSchema.extend({
  kind: z.literal("toolCall"),
  itemId: z.string().optional(),
  callId: z.string().optional(),
  toolName: z.string().optional(),
  args: z.record(z.string(), jsonValueSchema).nullish(),
});

const agentMessageDeltaSchema = z.object({
  itemId: z.string().optional(),
  turnId: z.string().optional(),
  delta: z.string().optional(),
});

const itemCompletedSchema = z.object({
  kind: z.enum(["userMessage", "agentMessage", "toolCall"]).optional(),
  itemId: z.string().optional(),
  turnId: z.string().optional(),
  text: z.string().optional(),
  output: z.string().optional(),
  status: z.enum(["completed", "failed", "interrupted"]).optional(),
});

const turnCompletedSchema = z.object({
  turnId: z.string().optional(),
  status: z.enum(["completed", "failed", "interrupted"]).optional(),
});

const systemErrorSchema = z.object({
  category: z.string().optional(),
  message: z.string().optional(),
  turnId: z.string().optional(),
});

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

function pickKind(data: EventData): string | undefined {
  return typeof data.kind === "string" ? data.kind : undefined;
}

function pickItemId(data: EventData, fallback: string): string {
  return typeof data.itemId === "string" && data.itemId !== "" ? data.itemId : fallback;
}

function pickTurnId(data: EventData): string | null {
  return typeof data.turnId === "string" ? data.turnId : null;
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

  for (const event of events) {
    const raw: EventData =
      event.data !== null && typeof event.data === "object"
        ? (event.data as EventData)
        : {};
    const itemId = pickItemId(raw, event.id);
    const turnId = pickTurnId(raw);
    const kind = pickKind(raw);

    switch (event.type) {
      case "item/started": {
        if (kind === "userMessage") {
          const parsed = userMessageStartedSchema.safeParse(raw);
          if (!parsed.success) {
            break;
          }
          rows.set(itemId, {
            kind: "conversation",
            role: "user",
            id: itemId,
            threadId: event.threadId,
            turnId,
            sourceSeqStart: event.seq,
            sourceSeqEnd: event.seq,
            startedAt: event.createdAt,
            createdAt: event.createdAt,
            text: parsed.data.text ?? "",
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
            registerTurnRow(turnId, itemId);
          }
        } else if (kind === "agentMessage") {
          const rowId = `assistant:${itemId}`;
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
          assistantByItemId.set(itemId, rowId);
          if (turnId) {
            registerTurnRow(turnId, rowId);
          }
        } else if (kind === "toolCall") {
          const parsed = toolCallStartedSchema.safeParse(raw);
          if (!parsed.success) {
            break;
          }
          rows.set(itemId, {
            kind: "work",
            workKind: "tool",
            id: itemId,
            threadId: event.threadId,
            turnId,
            sourceSeqStart: event.seq,
            sourceSeqEnd: event.seq,
            startedAt: event.createdAt,
            createdAt: event.createdAt,
            status: "pending",
            callId: parsed.data.callId ?? itemId,
            toolName: parsed.data.toolName ?? "tool",
            toolArgs: parsed.data.args ?? null,
            output: "",
            completedAt: null,
            approvalStatus: null,
            activityIntents: [],
            __order: event.seq,
          });
          if (turnId) {
            registerTurnRow(turnId, itemId);
          }
        }
        break;
      }
      case "item/agentMessage/delta": {
        const parsed = agentMessageDeltaSchema.safeParse(raw);
        if (!parsed.success) {
          break;
        }
        const rowId = assistantByItemId.get(parsed.data.itemId ?? itemId);
        const row = rowId ? rows.get(rowId) : undefined;
        if (row && row.kind === "conversation" && row.role === "assistant") {
          row.text += parsed.data.delta ?? "";
          row.sourceSeqEnd = event.seq;
        }
        break;
      }
      case "item/completed": {
        const parsed = itemCompletedSchema.safeParse(raw);
        if (!parsed.success) {
          break;
        }
        const assistantRowId = assistantByItemId.get(parsed.data.itemId ?? itemId);
        const assistantRow = assistantRowId ? rows.get(assistantRowId) : undefined;
        if (assistantRow && assistantRow.kind === "conversation") {
          if (parsed.data.text !== undefined && parsed.data.text.length > 0) {
            assistantRow.text = parsed.data.text;
          }
          assistantRow.sourceSeqEnd = event.seq;
          break;
        }
        const workRow = rows.get(parsed.data.itemId ?? itemId);
        if (workRow && workRow.kind === "work" && workRow.workKind === "tool") {
          workRow.output = parsed.data.output ?? workRow.output;
          workRow.completedAt = event.createdAt;
          workRow.sourceSeqEnd = event.seq;
          workRow.status =
            parsed.data.status === "failed"
              ? "error"
              : parsed.data.status === "interrupted"
                ? "interrupted"
                : "completed";
        }
        break;
      }
      case "turn/completed": {
        const parsed = turnCompletedSchema.safeParse(raw);
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
        const parsed = systemErrorSchema.safeParse(raw);
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
          title: parsed.success ? (parsed.data.category ?? "error") : "error",
          detail: parsed.success ? (parsed.data.message ?? null) : null,
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
