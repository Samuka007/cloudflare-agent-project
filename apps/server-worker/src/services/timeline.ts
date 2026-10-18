import type { TimelineRow } from "../contract/thread-timeline.js";

/**
 * Timeline response assembly — the #554 roadmap step ⑤ survivor. The ux
 * projection itself (the former "porting layer") retired to the materializer
 * + bb thread-view face (services/thread-view.ts). What remains here is the
 * response machinery the routes own — older/latest paging, the best-effort
 * latest-rows delta cache, and the conversation outline — over rows that
 * arrive as cap boundary rows (contract/thread-timeline.ts, same-source with
 * @bb/server-contract). This module never projects events.
 */

const PREVIEW_MAX_CHARS = 512;

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
