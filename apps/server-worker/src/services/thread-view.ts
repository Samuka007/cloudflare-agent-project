/**
 * #560 projection switch, cap face: the ux timeline now materializes through
 * bb thread-view (@cap/agent-do/thread-view → buildThreadTimelineFromEvents)
 * instead of the retired porting-layer fold in services/timeline.ts. This
 * module owns everything cap-specific on top of the bb projection:
 *
 * - boundary validation: every bb row parses against the cap contract
 *   (contract/thread-timeline.ts, same-source with @bb/server-contract) —
 *   a bb pin upgrade that drifts the row shapes fails loudly here;
 * - D4 Thought rows: the "Thought for Ns" operation rows are a cap extension
 *   the pinned bb projection does not materialize (its reasoning fold only
 *   feeds the live activeThinking); synthesized here from the same ux
 *   lifecycles the porting layer used. When the bb pin ships upstream #3250
 *   row creation, this synthesis retires and the rows come from bb;
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
import {
  timelineRowSchema,
  type TimelineDelegationWorkRow,
  type TimelineRow,
} from "../contract/thread-timeline.js";
import {
  activeThinkingSchema,
  type ActiveThinking,
} from "../contract/domain/active-thinking.js";
import type { ThreadContextWindowUsage } from "../contract/api/shared.js";
// durationToCompactString/truncateReasoningDetail are the retired fold's bb
// format-helpers ports, shared with the D4 synthesis below.
import {
  durationToCompactString,
  mergeTimelineRows,
  truncateReasoningDetail,
} from "./timeline.js";

// --- D4: Thought operation rows (#303 J6 档 2, bb #3250 port) -------------

/**
 * One open reasoning stream per ux itemId — the porting layer's fold
 * (timeline.ts ReasoningLifecycle), kept verbatim so the synthesized rows
 * stay field-identical (reasoning-rows.test.ts pins both faces).
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

type EventData = Record<string, unknown>;

function pickTurnId(data: EventData): string | null {
  return typeof data.turnId === "string" ? data.turnId : null;
}

function rawEventData(event: UxThreadEvent): EventData {
  return event.data !== null && typeof event.data === "object"
    ? (event.data as EventData)
    : {};
}

interface ThoughtRow {
  row: TimelineRow;
  /** #274 J1 attribution — set when the row folds into a delegation's childRows. */
  parentCallId?: string;
}

/**
 * bb finalizeReasoningLifecycleByKey (reasoning-lifecycle-projection.ts:
 * 196-235) cap face: the completed "Thought for Ns" row — canonical
 * `reasoningId` (the ux itemId, also the live activeThinking id), the prose
 * detail truncated at bb's 32k with the tail-counted suffix, sorted at its
 * stream position (the FIRST thinking delta's seq — #543). Empty text
 * produces no row (bb returns null).
 */
function materializeThoughtRow(
  rowsById: Map<string, TimelineRow>,
  seenItemIds: Set<string>,
  lifecycle: ReasoningLifecycle,
  status: "completed" | "interrupted",
  event: UxThreadEvent,
  finalText?: string,
): ThoughtRow | null {
  if (seenItemIds.has(lifecycle.itemId)) {
    return null;
  }
  seenItemIds.add(lifecycle.itemId);
  const text = (finalText ?? lifecycle.text).trim();
  if (text.length === 0) {
    return null;
  }
  const row = timelineRowSchema.parse({
    kind: "system",
    systemKind: "operation",
    operationKind: "reasoning",
    id: `reasoning:${lifecycle.itemId}`,
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
  });
  rowsById.set(String(row.id), row);
  return {
    row,
    ...(lifecycle.parentCallId !== undefined ? { parentCallId: lifecycle.parentCallId } : {}),
  };
}

/**
 * The ux reasoning fold (timeline.ts:684-783 verbatim): deltas accumulate,
 * the reasoning item/completed materializes the row with the joined
 * content, an open stream seals interrupted at its turn's completion
 * (bb finalizeOpenReasoningLifecyclesForTurn), and the first answer delta
 * of a turn sweeps that turn's still-open lifecycles (aborted calls never
 * complete — their text dies with the turn, #543).
 */
function synthesizeThoughtRows(
  events: readonly UxThreadEvent[],
): { topLevel: TimelineRow[]; parented: ThoughtRow[] } {
  const lifecycles = new Map<string, ReasoningLifecycle>();
  const seenItemIds = new Set<string>();
  const rowsById = new Map<string, TimelineRow>();
  const parented: ThoughtRow[] = [];
  const topLevel: TimelineRow[] = [];

  const emit = (thought: ThoughtRow | null): void => {
    if (thought === null) {
      return;
    }
    if (thought.parentCallId !== undefined) {
      parented.push(thought);
    } else {
      topLevel.push(thought.row);
    }
  };

  for (const event of events) {
    const raw = rawEventData(event);
    const turnId = pickTurnId(raw);
    switch (event.type) {
      case "item/reasoning/textDelta": {
        const parsed = threadEventDataSchemas["item/reasoning/textDelta"].safeParse(raw);
        if (!parsed.success) {
          break;
        }
        const { itemId, delta, parentToolCallId } = parsed.data;
        const existing = lifecycles.get(itemId);
        lifecycles.set(itemId, {
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
        if (parsed.data.item.type !== "reasoning") {
          break;
        }
        // #543: the completion owns the display from that instant — the
        // lifecycle folds into the durable row and the live indicator
        // drops it (bb's close point, assistant-event-projection.ts:174-187).
        const lifecycle = lifecycles.get(parsed.data.item.id);
        if (lifecycle === undefined) {
          break;
        }
        lifecycles.delete(parsed.data.item.id);
        emit(
          materializeThoughtRow(
            rowsById,
            seenItemIds,
            lifecycle,
            "completed",
            event,
            parsed.data.item.content.join(""),
          ),
        );
        break;
      }
      case "turn/completed": {
        // A turn that ends with reasoning still open (interrupted call)
        // seals the row as interrupted — text preserved for review (bb
        // terminal-record behavior). Runs regardless of pending tool rows.
        for (const lifecycle of [...lifecycles.values()]) {
          if (lifecycle.turnId !== turnId) {
            continue;
          }
          lifecycles.delete(lifecycle.itemId);
          emit(materializeThoughtRow(rowsById, seenItemIds, lifecycle, "interrupted", event));
        }
        break;
      }
      default:
        break;
    }
  }
  return { topLevel, parented };
}

function isDelegationRow(row: TimelineRow): row is TimelineDelegationWorkRow {
  return row.kind === "work" && row.workKind === "delegation";
}

/**
 * Find the delegation row a parented Thought row folds into, wherever bb
 * nested it (top level, inside a turn summary's children, or an outer
 * delegation's childRows). Fold target resolution matches the porting
 * layer's exact-anchor semantics — the batch-anchor prefix fallback lives
 * in the materializer (D5), which rewrites the events, not the rows.
 */
function findDelegationRowByCallId(
  rows: readonly TimelineRow[],
  callId: string,
): TimelineDelegationWorkRow | undefined {
  for (const row of rows) {
    if (isDelegationRow(row) && row.callId === callId) {
      return row;
    }
    if (row.kind === "turn" && row.children !== null) {
      const nested = findDelegationRowByCallId(row.children, callId);
      if (nested !== undefined) {
        return nested;
      }
    }
    if (isDelegationRow(row) && row.childRows.length > 0) {
      const nested = findDelegationRowByCallId(row.childRows, callId);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

/**
 * Merge the Thought rows into the bb projection: unparented rows merge
 * top-level in source order (mergeTimelineRows — Thought rows sort at their
 * first thinking delta's seq, the #543 stream position), parented rows
 * splice into their delegation row's childRows ascending (the porting
 * layer's newest-first unshift walk produced the same ascending order).
 */
function mergeThoughtRows(
  bbRows: readonly TimelineRow[],
  thought: { topLevel: TimelineRow[]; parented: ThoughtRow[] },
): TimelineRow[] {
  for (const thoughtRow of thought.parented) {
    if (thoughtRow.parentCallId === undefined) {
      continue;
    }
    const delegation = findDelegationRowByCallId(bbRows, thoughtRow.parentCallId);
    if (delegation === undefined) {
      // No delegation anchor in the bb face (pre-J1 journal): the row stays
      // top-level — the porting layer's fallback for unresolvable parents.
      thought.topLevel.push(thoughtRow.row);
      continue;
    }
    const childRows = delegation.childRows;
    const index = childRows.findIndex(
      (existing) => existing.sourceSeqStart > thoughtRow.row.sourceSeqStart,
    );
    if (index === -1) {
      childRows.push(thoughtRow.row);
    } else {
      childRows.splice(index, 0, thoughtRow.row);
    }
  }
  return mergeTimelineRows(bbRows, thought.topLevel);
}

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

export interface ThreadTimelineProjectionOptions {
  /** bb threadStatus — drives the activeThinking gate inside bb. */
  threadStatus: string;
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
  let rows = projection.rows.map((row) => timelineRowSchema.parse(row));
  rows = mergeThoughtRows(rows, synthesizeThoughtRows(events));
  if (options.includeUnhandledProviderRows === true) {
    const rawEvents = options.rawEvents ?? [];
    rows = mergeTimelineRows(rows, projectUnhandledProviderRows(events, rawEvents));
  }
  const activeThinking =
    projection.activeThinking === null ? null : activeThinkingSchema.parse(projection.activeThinking);
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
