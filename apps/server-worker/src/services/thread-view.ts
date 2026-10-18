/**
 * #560 projection switch, cap face: the ux timeline now materializes through
 * bb thread-view (@cap/agent-do/thread-view → buildThreadTimelineFromEvents)
 * instead of the retired porting-layer fold in services/timeline.ts. This
 * module owns everything cap-specific on top of the bb projection:
 *
 * - boundary validation: every bb row parses against the cap contract
 *   (contract/thread-timeline.ts, same-source with @bb/server-contract) —
 *   a bb pin upgrade that drifts the row shapes fails loudly here;
 * - Thought rows ("Thought for Ns"): materialized by bb upstream #3250 row
 *   creation (pin 2638c44fe). The pre-#3250 cap synthesis retired when the
 *   pin shipped it — re-adding it double-synthesizes (harness red);
 * - D7 provider-unhandled debug rows: the raw−ux set difference is this
 *   stack's provider-unhandled population (Debug settings toggle); moved
 *   verbatim from the porting layer;
 * - tail state: activeThinking/contextWindowUsage come from the bb
 *   projection (the same folds the porting layer ported), re-validated
 *   against the cap schemas.
 *
 * D5 (batch-spawn anchors + background delegation seals) runs inside the
 * materializer — it rewrites rows before bb sees them (see
 * @cap/agent-do/thread-view materializer.ts).
 */
import { projectUxWindowThroughThreadView } from "@cap/agent-do/thread-view";
import { threadEventDataSchemas } from "@cap/protocol";
import type { UxThreadEvent } from "../seam/agent-do.js";
import { timelineRowSchema, type TimelineRow } from "../contract/thread-timeline.js";
import { activeThinkingSchema, type ActiveThinking } from "../contract/domain/active-thinking.js";
import type { ThreadStatus } from "../contract/domain/thread-status.js";
import type { ThreadContextWindowUsage } from "../contract/api/shared.js";

// --- D7: provider-unhandled debug rows ------------------------------------
// Moved verbatim from the porting layer (services/timeline.ts) — the
// raw−ux set difference is unchanged; only the layer that merges it moved.

/**
 * bb gates the provider-unhandled diagnostic rows on the Debug settings
 * toggle: `deps.config.isDevelopment ||
 * getAppSettings(db).showUnhandledProviderEvents` (routes/threads/data.ts:
 * 331-334). The Worker has no dev-build term, so the flag alone decides —
 * staging is the packaged-build equivalent.
 *
 * bb surfaces provider events the adapter persisted but could not classify
 * (domain ProviderUnhandledEvent → thread-view parse-operation-message.ts:
 * 447-461). This stack's raw journal lives on the agent DO with the FSM
 * vocabulary, and the UX projection (packages/agent-do ux-projection.ts) is
 * the authoritative "what the SPA can see" fold: every raw row it omits
 * (thread.created, model.call_retry, tool.output, tool.exec_started,
 * turn.cancel_requested, the job/task/interaction/peer journal families,
 * secondary model.call_started within a turn) is a raw event the runtime
 * persisted but no timeline row renders. That set-difference is this stack's
 * provider-unhandled population — computed from the projection itself so the
 * FSM vocabulary can grow without a second hand-maintained list here.
 */

/** bb titles provider-unhandled rows `Unhandled <provider> event` with the
 * projected provider display name (thread-view parse-operation-message.ts:
 * 452). This stack's journal has no per-thread providerId — the model relay
 * is the single provider — so the display name is the fixed runtime identity.
 */
const UNHANDLED_PROVIDER_ROW_TITLE = "Unhandled agent event";

/** bb thread-view provider-unhandled-detail.ts HUMANIZED_EVENT_TOKEN_MAP port. */
const HUMANIZED_EVENT_TOKEN_MAP: Record<string, string> = {
  api: "API",
  chatgpt: "ChatGPT",
  id: "ID",
  mcp: "MCP",
  oauth: "OAuth",
  sdk: "SDK",
  ui: "UI",
  url: "URL",
};

/** bb thread-view provider-unhandled-detail.ts humanizeRawType port. */
function humanizeRawType(rawType: string): string {
  return rawType
    .split(/[:/._-]+/u)
    .flatMap((token) => token.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .filter((token) => token.length > 0)
    .map((token) => {
      const normalized = token.toLowerCase();
      return (
        HUMANIZED_EVENT_TOKEN_MAP[normalized] ??
        normalized.charAt(0).toUpperCase() + normalized.slice(1)
      );
    })
    .join(" ");
}

/**
 * bb buildProviderUnhandledDetail (provider-unhandled-detail.ts:38-46):
 * humanized raw type, the raw type token, then the byte-transparent payload.
 */
function providerUnhandledDetail(event: UxThreadEvent): string {
  return [
    humanizeRawType(event.type),
    `Raw event: ${event.type}`,
    "Payload:",
    JSON.stringify(event, null, 2),
  ].join("\n");
}

export function projectUnhandledProviderRows(
  uxEvents: readonly UxThreadEvent[],
  rawEvents: readonly UxThreadEvent[],
): TimelineRow[] {
  const renderedIds = new Set(uxEvents.map((event) => event.id));
  const rows: TimelineRow[] = [];
  for (const event of rawEvents) {
    if (renderedIds.has(event.id)) {
      continue;
    }
    const raw = rawEventData(event);
    rows.push(
      timelineRowSchema.parse({
        kind: "system",
        systemKind: "operation",
        operationKind: "provider-unhandled",
        // bb operation message ids (format-helpers.ts:72-74) —
        // `${threadId}:op:provider-unhandled:${seq}` (parse-operation-message.ts:393).
        id: `${event.threadId}:op:provider-unhandled:${event.seq}`,
        threadId: event.threadId,
        turnId: pickTurnId(raw),
        sourceSeqStart: event.seq,
        sourceSeqEnd: event.seq,
        startedAt: event.createdAt,
        createdAt: event.createdAt,
        title: UNHANDLED_PROVIDER_ROW_TITLE,
        detail: providerUnhandledDetail(event),
        status: "completed",
        completedAt: event.createdAt,
      }),
    );
  }
  return rows;
}

// --- the projection switch -------------------------------------------------

/**
 * #566 face parity: bb materializes a zero-count attachments object for
 * text-only user rows (build-thread-timeline.ts toConversationAttachments);
 * the shipped M0 row shape is null (#320 A5 — the retired M0 attachments
 * projection). The SPA renders both identically
 * (ConversationAttachments.tsx:128 early-return), so this normalizes back to
 * null to keep the boundary output identical with the face the compat suite
 * pins. A row carrying at least one attachment part keeps bb's counts.
 */
function normalizeZeroCountAttachments(row: TimelineRow): void {
  if (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.attachments !== null &&
    row.attachments.webImages === 0 &&
    row.attachments.localImages === 0 &&
    row.attachments.localFiles === 0
  ) {
    row.attachments = null;
  }
}

export interface ThreadTimelineProjectionOptions {
  /** bb threadStatus — drives the activeThinking gate inside bb. Cap
   * contract's same-source union: a bb pin that drifts the status vocabulary
   * fails this assignment instead of silently reshaping the gate. */
  threadStatus: ThreadStatus;
  /** D7 debug toggle (bb showUnhandledProviderEvents). */
  includeUnhandledProviderRows?: boolean;
  /** The raw journal window — required when includeUnhandledProviderRows. */
  rawEvents?: readonly UxThreadEvent[];
}

export interface ThreadTimelineProjection {
  rows: TimelineRow[];
  activeThinking: ActiveThinking | null;
  contextWindowUsage: ThreadContextWindowUsage | null;
}

type EventData = Record<string, unknown>;

function pickTurnId(data: EventData): string | null {
  return typeof data.turnId === "string" ? data.turnId : null;
}

function rawEventData(event: UxThreadEvent): EventData {
  return event.data !== null && typeof event.data === "object" ? (event.data as EventData) : {};
}

/**
 * Merge the diagnostic rows into the projected rows in source order —
 * bb projects everything in one pass over the seq-ordered events, so the
 * merged list is seq-ordered with the projection's id tie-break. (The D7
 * merge seam, moved here from the retired porting layer with the rows it
 * merges.)
 */
function mergeTimelineRows(
  base: readonly TimelineRow[],
  extra: readonly TimelineRow[],
): TimelineRow[] {
  return [...base, ...extra].sort((a, b) =>
    a.sourceSeqStart === b.sourceSeqStart
      ? a.id.localeCompare(b.id)
      : a.sourceSeqStart - b.sourceSeqStart,
  );
}

/**
 * Compaction op rows (cap face, #547): the ux `thread/compacted` payload
 * carries the mode and the row names it — "Context compacted (snapshot)" /
 * "(remote)" / bare (timeline.ts:833-866 verbatim). bb's marker event is
 * turn-scoped-strict and modeless, so the materializer skips it and this
 * synthesis owns the row (born completed — the checkpoint appends after
 * the summarization finished; post-cut windows orphan the turn scope and
 * the row renders top-level).
 */
function synthesizeCompactionRows(events: readonly UxThreadEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const event of events) {
    if (event.type !== "thread/compacted") continue;
    const compacted = threadEventDataSchemas["thread/compacted"].safeParse(event.data);
    const compactTitle =
      compacted.success && compacted.data.mode === "remote"
        ? "Context compacted (remote)"
        : compacted.success && compacted.data.mode === "snap"
          ? "Context compacted (snapshot)"
          : "Context compacted";
    rows.push(
      timelineRowSchema.parse({
        kind: "system",
        systemKind: "operation",
        operationKind: "compaction",
        id: `compact:${event.id}`,
        threadId: event.threadId,
        turnId: pickTurnId(rawEventData(event)),
        sourceSeqStart: event.seq,
        sourceSeqEnd: event.seq,
        startedAt: event.createdAt,
        createdAt: event.createdAt,
        title: compactTitle,
        detail: null,
        status: "completed",
        completedAt: event.createdAt,
      }),
    );
  }
  return rows;
}

/**
 * The switched projection: ux window → materializer → bb thread-view →
 * cap boundary parse → D4 Thought merge → D7 debug merge. Pure and
 * synchronous; pagination/cache/outline stay in services/timeline.ts.
 */
export function projectThreadTimeline(
  events: readonly UxThreadEvent[],
  options: ThreadTimelineProjectionOptions,
): ThreadTimelineProjection {
  const projection = projectUxWindowThroughThreadView(events, {
    threadStatus: options.threadStatus,
  });
  // Each bb row parses against the cap contract — the same-source drift
  // alarm: a bb pin upgrade that changes row shapes fails here instead of
  // shipping a silently reshaped SPA face.
  let rows = projection.rows.map((row) => {
    const parsed = timelineRowSchema.parse(row);
    normalizeZeroCountAttachments(parsed);
    return parsed;
  });
  rows = mergeTimelineRows(rows, synthesizeCompactionRows(events));
  if (options.includeUnhandledProviderRows === true) {
    const rawEvents = options.rawEvents ?? [];
    rows = mergeTimelineRows(rows, projectUnhandledProviderRows(events, rawEvents));
  }
  const activeThinking =
    projection.activeThinking === null
      ? null
      : activeThinkingSchema.parse(projection.activeThinking);
  const contextWindowUsage =
    projection.contextWindowUsage === null
      ? null
      : threadEventDataSchemas["thread/contextWindowUsage/updated"].parse({
          contextWindowUsage: projection.contextWindowUsage,
        }).contextWindowUsage;
  return { rows, activeThinking, contextWindowUsage };
}

/**
 * The bb projection nests completed turns into `kind: "turn"` summary rows
 * (#554 D8 — accepted bb behavior). The conversation outline (bb
 * buildThreadConversationOutline port, 保留不动) walks a flat list, so the
 * outline feed expands turn wrappers in place. Delegation childRows stay
 * folded: the outline never listed subagent conversation rows.
 */
export function rowsForConversationOutline(rows: readonly TimelineRow[]): TimelineRow[] {
  const flat: TimelineRow[] = [];
  for (const row of rows) {
    if (row.kind === "turn") {
      if (row.children !== null) {
        flat.push(...rowsForConversationOutline(row.children));
      }
      continue;
    }
    flat.push(row);
  }
  return flat;
}
