import type { SqlStorage, SqlStorageValue } from "@cloudflare/workers-types";
import type { AnyAgentEvent } from "./fsm-events.js";
import { parseAgentEvent } from "./fsm-events.js";

/**
 * #561 — DO SQL 读层窗口预算 + 读放大对齐 (#554 roadmap step 4, W5 base).
 *
 * The ux read face (timeline/outline rendering) materializes the whole
 * journal per request; on a 10k-event thread the raw strings plus their
 * parsed/projection derivations race the 128MB isolate ceiling (#554 report
 * §5). This module ports the bb read-boundary mechanisms to the DO SQL
 * layer — the journal stays append-only, nothing is written:
 *
 * - `maxInlineOutputChars` equivalent (`truncatedEventDataColumn`
 *   semantics, bb packages/db/src/data/event-output-truncation.ts): the
 *   selected `data` column is wrapped in a SQL expression that shortens a
 *   completion aggregate longer than the cap *inside SQLite* — a 300KB
 *   tool output never crosses into JS. Same guards as bb: only text-typed
 *   values at the known paths (blob refs are objects and pass untouched),
 *   rows whose whole payload fits the cap skip the JSON functions.
 * - `findStoredTimelineWindowByteBudgetFloor` equivalent (bb
 *   packages/db/src/data/events.ts:2710): newest-first iteration over
 *   `(seq, length(data))` only — payloads never materialize — accumulates
 *   post-truncation bytes until the budget, and the floor rounds down to
 *   the enclosing turn boundary so every window holds whole turns (the bb
 *   segment-anchor posture: a fold never reads a partial turn).
 * - Delta volume governance (bb `pruneResolvedItemDeltas` read-amplification
 *   alignment): newest windows read the delta rows in full (live streaming
 *   face); older windows exclude `model.delta` rows entirely — their text is
 *   superseded by the `model.call_completed.text` completion aggregate, and
 *   bb's pruned journals anchor the surviving assistant rows at the
 *   completion the same way. `model.thinking` rows stay in older windows
 *   (capped): they have no journal-side completion aggregate — the reasoning
 *   terminal is the delta accumulation — so dropping them would erase the
 *   Thought rows (#303 D4) from history instead of bounding their bytes.
 *
 * Every mechanism is read-side only: `replay-is-truth` (internal
 * `readAllEvents`) and the raw view keep full fidelity.
 */

/**
 * Per-page window byte budget. bb THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT
 * (apps/server/src/services/threads/timeline.ts:167): a window's selected
 * payload bytes stay in this order, so the projection layers on top (4-6×
 * live-object factor, #554 §5) sit two orders under the 128MB isolate.
 */
export const TIMELINE_WINDOW_BYTE_BUDGET = 4 * 1024 * 1024;

/**
 * Read-time inline-output char cap. bb DEFAULT_MAX_INLINE_OUTPUT_CHARS
 * (timeline-output-truncation.ts:22): conversation/message text is never
 * truncated — only completion aggregates are.
 */
export const TIMELINE_MAX_INLINE_OUTPUT_CHARS = 32_000;

/**
 * The bb truncation marker tail, produced SQL-side so a reader cannot tell
 * which layer shortened a value (bb event-output-truncation.ts:24,33-35).
 */
const TRUNCATION_MARKER_TAIL = " more characters truncated]";

/**
 * Journal event types with no UX rendering AND no projection fold state —
 * `projectToUxEvents` breaks on each of them (ux-projection.ts:216-288), so
 * excluding them from ux reads is output-preserving and stops their bytes at
 * the SQL boundary. `tool.output` alone (streaming output chunks) is the
 * dominant dead weight. `task.subagent_identity` is deliberately NOT listed:
 * it mutates `spawnAnchors` fold state even though it emits no ux row.
 */
export const UX_EXCLUDED_EVENT_TYPES: readonly string[] = [
  "thread.created",
  "thread.rebound",
  "thread.execution_updated",
  "model.call_retry",
  "experimental_context_notes",
  "job.delivered",
  "job.registered",
  "job.settled",
  "peer.message",
  "peer.message_consumed",
  "task.async_result",
  "task.yield_reminder",
  "task.yield_warning",
  "task.yield_completed",
  "task.budget_notice",
  "task.subagent_flush",
  "todo_phases",
  "interaction.registered",
  "interaction.resolved",
  "interaction.interrupted",
  "tool.exec_started",
  "tool.output",
  "tool.dispatch",
  "turn.cancel_requested",
];

/**
 * Extra exclusions for older windows only (delta governance): answer deltas
 * are superseded by the `model.call_completed.text` aggregate — bb pruned
 * journals read exactly the aggregates, and the surviving bb assistant rows
 * anchor at the completion the same way.
 */
export const UX_OLDER_EXCLUDED_EVENT_TYPES: readonly string[] = [
  ...UX_EXCLUDED_EVENT_TYPES,
  "model.delta",
];

/**
 * Inline-output truncation specs: (journal types, JSON path inside `data`).
 * The completion aggregates — bb truncates the same result family
 * (`$.item.aggregatedOutput` / `$.item.result` / `$.item.resultText`).
 * `model.thinking` rides the same cap: it is an inline content field whose
 * rows feed the Thought-row accumulation, and bb caps inline content the
 * same way on every page.
 */
const INLINE_OUTPUT_SPECS: readonly { path: string; types: readonly string[] }[] = [
  { path: "$.output", types: ["tool.result", "task.spawn_settled"] },
  { path: "$.text", types: ["model.thinking"] },
];

/** Sentinel path that exists in no payload: `json_replace` ignores it. */
const NOOP_JSON_PATH = "$.__cap_noop__";

/**
 * `events.data`, with any inline output longer than its cap replaced by a
 * truncated preview, evaluated inside SQLite (bb truncatedEventDataColumn,
 * adapted to the journal's per-type paths). All literals in the expression
 * are compile-time constants — no user input reaches this string.
 */
function truncatedTimelineDataExpr(): string {
  const pairs: string[] = [];
  for (const spec of INLINE_OUTPUT_SPECS) {
    const matches = spec.types.map((type) => `type = '${type}'`).join(" OR ");
    const overflow =
      `(${matches}) AND json_type(data, '${spec.path}') = 'text' ` +
      `AND length(json_extract(data, '${spec.path}')) > ${TIMELINE_MAX_INLINE_OUTPUT_CHARS}`;
    const truncated =
      `substr(json_extract(data, '${spec.path}'), 1, ${TIMELINE_MAX_INLINE_OUTPUT_CHARS})` +
      ` || char(10) || '…[' || printf('%,d', length(json_extract(data, '${spec.path}'))` +
      ` - ${TIMELINE_MAX_INLINE_OUTPUT_CHARS}) || '${TRUNCATION_MARKER_TAIL}'`;
    pairs.push(`CASE WHEN ${overflow} THEN '${spec.path}' ELSE '${NOOP_JSON_PATH}' END`);
    pairs.push(`CASE WHEN ${overflow} THEN ${truncated} ELSE NULL END`);
  }
  return `CASE
    WHEN length(data) <= ${TIMELINE_MAX_INLINE_OUTPUT_CHARS} THEN data
    ELSE json_replace(data, ${pairs.join(", ")})
  END`;
}

/** #561 windowed-read request; `window` present = the read is bounded. */
export interface TimelineWindowSpec {
  /**
   * Inclusive upper bound in journal seqs — the older-page anchor. The read
   * window extends through the END of the turn containing this seq (the next
   * `turn.input` above it), so the anchor's whole turn projects completely
   * no matter where inside it the anchor row sits.
   */
  beforeSeq?: number;
}

/** Window accounting reported back to the caller (probe + pagination). */
export interface TimelineWindowInfo {
  /**
   * First journal seq of the read window (inclusive) after byte-floor + turn
   * rounding; 1 when the whole journal is in window.
   */
  windowStartSeq: number;
  /** Raw byte-budget floor before turn rounding; 0 when everything fit. */
  floorSeq: number;
  /** Post-truncation payload bytes the window materializes. */
  dataBytes: number;
  /** UX-visible rows exist below the window (fetch-older continues). */
  hasOlderRows: boolean;
}

export interface TimelineWindowRead {
  events: AnyAgentEvent[];
  latestSeq: number;
  window?: TimelineWindowInfo;
}

export interface ReadTimelineWindowArgs {
  threadId: string;
  sinceSeq?: number;
  limit?: number;
  window?: TimelineWindowSpec;
}

interface JournalRow {
  [column: string]: SqlStorageValue;
  seq: number;
  id: string;
  type: string;
  data: string;
  created_at: number;
}

/**
 * The ux read face with the #561 mechanisms. `window` absent = unbounded
 * read (still inline-truncated + dead-type-filtered: the outline face needs
 * every conversation row but not a single payload byte of tool output).
 */
export function readTimelineWindowEvents(
  sql: SqlStorage,
  args: ReadTimelineWindowArgs,
): TimelineWindowRead {
  const threadId = args.threadId;
  const sinceSeq = args.sinceSeq ?? 0;
  const latestSeq =
    sql
      .exec<{ max: number | null }>(
        "SELECT MAX(seq) AS max FROM events WHERE thread_id = ?",
        threadId,
      )
      .one().max ?? 0;
  const windowed = args.window !== undefined;
  // Delta governance keys on the window DIRECTION: older windows (anchored
  // below the head) exclude answer-delta rows; the newest window keeps them
  // in full for the live streaming face.
  const olderWindow = args.window?.beforeSeq !== undefined;
  const excluded = olderWindow ? UX_OLDER_EXCLUDED_EVENT_TYPES : UX_EXCLUDED_EVENT_TYPES;
  const dataExpr = truncatedTimelineDataExpr();

  // Window bounds. The upper edge extends through the end of the anchor's
  // turn: the first turn.input strictly above the anchor bounds that turn,
  // so a fold never reads a partial turn on either window edge (bb
  // segment-anchor posture; the extra rows re-project identically on both
  // pages and the SPA dedups by row id).
  let hiInclusive = latestSeq;
  const beforeSeq = args.window?.beforeSeq;
  if (windowed && beforeSeq !== undefined) {
    const nextTurnInput = sql
      .exec<{ s: number | null }>(
        "SELECT MIN(seq) AS s FROM events WHERE thread_id = ? AND type = 'turn.input' AND seq > ?",
        threadId,
        beforeSeq,
      )
      .one().s;
    const turnLastSeq = nextTurnInput === null ? latestSeq : nextTurnInput - 1;
    hiInclusive = Math.min(latestSeq, Math.max(beforeSeq, turnLastSeq));
  }

  if (!windowed) {
    const { events } = assembleWindowEvents(sql, {
      threadId,
      rows: readWindowRows(sql, {
        threadId,
        fromSeqInclusive: sinceSeq + 1,
        beforeSeqInclusive: hiInclusive,
        excluded,
        dataExpr,
        limit: args.limit,
      }),
      outOfWindowTerminals: null,
    });
    return { events, latestSeq };
  }

  // Byte-budget floor (bb findStoredTimelineWindowByteBudgetFloor): newest-
  // first walk until the budget overflows; the floor then rounds DOWN to the
  // enclosing turn boundary. A single row over the whole budget (an
  // un-blobbable giant — conversation text has no cap) still shows its own
  // turn, bb's oversized-event posture. The window start is INCLUSIVE — it
  // is the turn boundary row itself.
  let windowFromInclusive = sinceSeq + 1;
  let floorSeq = 0;
  {
    // Newest-first accumulation; rows that fit before the first overflow are
    // the window's floor candidate. Nothing here materializes payloads: the
    // cursor yields only (seq, post-truncation byte count) pairs.
    let includedBytes = 0;
    let overflowed = false;
    let oldestFittingSeq = 0;
    let firstOverflowSeq = 0;
    for (const row of sql.exec<{ seq: number; data_bytes: number }>(
      `SELECT seq, length(CAST(${dataExpr} AS BLOB)) AS data_bytes FROM events` +
        ` WHERE thread_id = ? AND seq > ? AND seq <= ?` +
        ` AND type NOT IN (${excluded.map(() => "?").join(", ")})` +
        ` ORDER BY seq DESC`,
      threadId,
      sinceSeq,
      hiInclusive,
      ...excluded,
    )) {
      if (includedBytes + row.data_bytes > TIMELINE_WINDOW_BYTE_BUDGET) {
        overflowed = true;
        firstOverflowSeq = row.seq;
        break;
      }
      includedBytes += row.data_bytes;
      oldestFittingSeq = row.seq;
    }
    if (overflowed) {
      // bb {kind:"floor"|"single-event-too-large"}: the window starts at the
      // turn boundary of the oldest fitting row — or of the oversized row
      // itself when nothing fit (its turn still shows, bb posture).
      const anchorSeq = oldestFittingSeq > sinceSeq ? oldestFittingSeq : firstOverflowSeq;
      const turnStart = sql
        .exec<{ s: number | null }>(
          "SELECT MAX(seq) AS s FROM events WHERE thread_id = ? AND type = 'turn.input' AND seq <= ?",
          threadId,
          anchorSeq,
        )
        .one().s;
      windowFromInclusive = Math.max(sinceSeq + 1, turnStart ?? anchorSeq);
      floorSeq = anchorSeq;
    }
  }

  // Exact post-truncation bytes the final window materializes — the
  // bb getStoredTimelineWindowEventDataBytes equivalent and the probe metric.
  const dataBytes =
    sql
      .exec<{ bytes: number | null }>(
        `SELECT COALESCE(SUM(length(CAST(${dataExpr} AS BLOB))), 0) AS bytes FROM events` +
          ` WHERE thread_id = ? AND seq >= ? AND seq <= ?` +
          ` AND type NOT IN (${excluded.map(() => "?").join(", ")})`,
        threadId,
        windowFromInclusive,
        hiInclusive,
        ...excluded,
      )
      .one().bytes ?? 0;

  const windowRows = readWindowRows(sql, {
    threadId,
    fromSeqInclusive: windowFromInclusive,
    beforeSeqInclusive: hiInclusive,
    excluded,
    dataExpr,
    limit: args.limit,
  });
  const { events, extraBytes } = assembleWindowEvents(sql, {
    threadId,
    rows: windowRows,
    // Older windows also fetch the completion aggregates (spawn terminals)
    // that landed above the window for in-window plans (#561 delta
    // governance, bb ensureTimelineWindowParentedRows posture); newest
    // windows fetch the terminals left below the floor.
    outOfWindowTerminals:
      beforeSeq !== undefined
        ? { afterSeq: hiInclusive }
        : windowFromInclusive > 1
          ? { beforeSeq: windowFromInclusive }
          : null,
  });

  const hasOlderRows =
    sql
      .exec<{ s: number | null }>(
        `SELECT 1 AS s FROM events WHERE thread_id = ? AND seq < ?` +
          ` AND type NOT IN (${UX_OLDER_EXCLUDED_EVENT_TYPES.map(() => "?").join(", ")}) LIMIT 1`,
        threadId,
        windowFromInclusive,
        ...UX_OLDER_EXCLUDED_EVENT_TYPES,
      )
      .toArray().length > 0;

  return {
    events,
    latestSeq,
    window: {
      windowStartSeq: windowFromInclusive,
      floorSeq,
      dataBytes: dataBytes + extraBytes,
      hasOlderRows,
    },
  };
}

function readWindowRows(
  sql: SqlStorage,
  args: {
    threadId: string;
    fromSeqInclusive: number;
    beforeSeqInclusive: number;
    excluded: readonly string[];
    dataExpr: string;
    limit?: number;
  },
): JournalRow[] {
  const rowCount = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE thread_id = ? AND seq >= ? AND seq <= ?` +
        ` AND type NOT IN (${args.excluded.map(() => "?").join(", ")})`,
      args.threadId,
      args.fromSeqInclusive,
      args.beforeSeqInclusive,
      ...args.excluded,
    )
    .one().n;
  const limit = Math.min(args.limit ?? Number.MAX_SAFE_INTEGER, Math.max(rowCount, 1));
  return sql
    .exec<JournalRow>(
      `SELECT seq, id, type, ${args.dataExpr} AS data, created_at FROM events` +
        ` WHERE thread_id = ? AND seq >= ? AND seq <= ?` +
        ` AND type NOT IN (${args.excluded.map(() => "?").join(", ")})` +
        ` ORDER BY seq LIMIT ${limit}`,
      args.threadId,
      args.fromSeqInclusive,
      args.beforeSeqInclusive,
      ...args.excluded,
    )
    .toArray();
}

/**
 * Parse the window rows and splice in the out-of-window completion
 * aggregates for in-window spawn plans (task.spawn_settled /
 * task.subagent_aborted): a background delegation's plan and its terminal
 * routinely sit in different windows, and without the targeted re-read the
 * old page would render the row pending forever.
 */
function assembleWindowEvents(
  sql: SqlStorage,
  args: {
    threadId: string;
    rows: JournalRow[];
    outOfWindowTerminals: { afterSeq?: number; beforeSeq?: number } | null;
  },
): { events: AnyAgentEvent[]; extraBytes: number } {
  let extraBytes = 0;
  const spawnIds: string[] = [];
  const events: AnyAgentEvent[] = args.rows.map((row) =>
    parseAgentEvent({
      threadId: args.threadId,
      seq: row.seq,
      id: row.id,
      type: row.type,
      data: JSON.parse(row.data),
      createdAt: row.created_at,
    }),
  );
  for (const row of args.rows) {
    if (row.type !== "task.spawn_planned") continue;
    const parsed: unknown = JSON.parse(row.data);
    if (typeof parsed === "object" && parsed !== null && "spawnId" in parsed) {
      const spawnId = parsed.spawnId;
      if (typeof spawnId === "string" && spawnId !== "") spawnIds.push(spawnId);
    }
  }

  const range = args.outOfWindowTerminals;
  if (range !== null) {
    for (let offset = 0; offset < spawnIds.length; offset += 90) {
      // DO SQL caps bound parameters at 100 per statement.
      const chunk = spawnIds.slice(offset, offset + 90);
      const conditions = [
        "thread_id = ?",
        "type IN ('task.spawn_settled', 'task.subagent_aborted')",
        `json_extract(data, '$.spawnId') IN (${chunk.map(() => "?").join(", ")})`,
      ];
      const params: unknown[] = [args.threadId, ...chunk];
      if (range.afterSeq !== undefined) {
        conditions.push("seq > ?");
        params.push(range.afterSeq);
      }
      if (range.beforeSeq !== undefined) {
        conditions.push("seq < ?");
        params.push(range.beforeSeq);
      }
      for (const row of sql.exec<JournalRow>(
        `SELECT seq, id, type, data, created_at FROM events WHERE ${conditions.join(" AND ")}`,
        ...params,
      )) {
        extraBytes += new TextEncoder().encode(row.data).byteLength;
        events.push(
          parseAgentEvent({
            threadId: args.threadId,
            seq: row.seq,
            id: row.id,
            type: row.type,
            data: JSON.parse(row.data),
            createdAt: row.created_at,
          }),
        );
      }
    }
  }

  events.sort((a, b) => a.seq - b.seq);
  return { events, extraBytes };
}
