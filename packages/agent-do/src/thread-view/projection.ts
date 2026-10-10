/**
 * #560 projection switch, bb face: ux window → bb thread-view timeline
 * (buildThreadTimelineFromEvents), replacing the retired porting-layer fold
 * (projectTimelineRows/buildActiveThinking/buildContextWindowUsage) with the
 * upstream projection verbatim. The materializer supplies bb-consumable
 * rows; this module owns the decode + build pipeline and returns the RAW bb
 * output — the server-worker consumer re-validates against the cap contract
 * schemas and layers the cap delta post-processing (Thought rows D4,
 * provider-unhandled D7) on top.
 */
import type { ThreadEvent, ThreadEventRow, ThreadStatus } from "@bb/domain";
import { buildThreadEvent } from "@bb/domain";
import { buildThreadTimelineFromEvents } from "@bb/thread-view";

import {
  eventTypeOf,
  materializeUxWindowToStoredEventRows,
  type UxThreadEventEnvelope,
} from "./materializer.js";

/**
 * bb decodeThreadEventRow (thread-view event-decode.ts) inlined: validate the
 * materialized row through bb's per-type zod schema and re-attach the row
 * meta — malformed rows fail loudly here. Inlined so the bundle touches only
 * the packages' root exports (the deep subpath is not in bb's exports map,
 * which every resolution pipeline honors).
 */
function decodeThreadEventRow(row: ThreadEventRow): {
  event: ThreadEvent;
  meta: { id: string; seq: number; createdAt: number };
} {
  return {
    event: buildThreadEvent(row),
    meta: { id: row.id, seq: row.seq, createdAt: row.createdAt },
  };
}

/**
 * bb EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT (accepted-client-request-context.
 * ts) inlined for the same root-exports-only rule: the empty context the bb
 * request builders fold over — no accepted/rejected client requests, which
 * is exactly the ux face (requests are synthesized per userMessage).
 */
const EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT = {
  acceptedClientRequestEvents: [],
  rejectedClientRequestEvents: [],
} as const;

export interface UxWindowThreadViewProjection {
  /** Raw bb timeline rows (kind conversation/work/system/turn); consumer parses against the cap contract. */
  rows: unknown[];
  /** bb buildProjectionActiveThinking — threadStatus-gated inside bb (only `active` threads surface one). */
  activeThinking: unknown;
  /** bb extractThreadContextWindowUsage — newest usage row wins; null without one. */
  contextWindowUsage: unknown;
  /** Materialized bb row count (observability; also the harness's volume anchor). */
  materializedRowCount: number;
}

export interface UxWindowThreadViewOptions {
  /** bb threadStatus — drives the activeThinking gate inside bb. */
  threadStatus: ThreadStatus;
  /**
   * bb tail-state extraction gate (pendingTodos/goal/modelFallback — states
   * the ux face never produces; true keeps bb from skipping work the
   * consumer may read).
   */
  isLatestPage?: boolean;
}

/**
 * Pure, synchronous, O(N) — the same cost class as the porting layer it
 * replaces, with one extra bb zod parse per materialized row (#554 report §5:
 * the accepted doubling).
 */
export function projectUxWindowThroughThreadView(
  envelopes: readonly UxThreadEventEnvelope[],
  options: UxWindowThreadViewOptions,
): UxWindowThreadViewProjection {
  const materializedRows = materializeUxWindowToStoredEventRows(envelopes);
  const eventsWithMeta = materializedRows.map((materialized) => decodeThreadEventRow(materialized));
  const contextWindowEvents = eventsWithMeta.filter(
    ({ event }) => eventTypeOf(event) === "thread/contextWindowUsage/updated",
  );
  const timelineEvents = eventsWithMeta.filter(
    ({ event }) => eventTypeOf(event) !== "thread/contextWindowUsage/updated",
  );
  const result = buildThreadTimelineFromEvents({
    acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
    contextWindowEvents,
    events: timelineEvents,
    options: {
      contextOnlyToolCallIds: new Set<string>(),
      includeDebugRawEvents: false,
      // D7 (provider-unhandled debug rows) is rendered cap-side from the
      // raw−ux set difference; bb's own family has no ux producer.
      includeProviderUnhandledOperations: false,
      isLatestPage: options.isLatestPage ?? true,
      threadStatus: options.threadStatus,
      // The ux journal carries no thread-name/provider rows; the operation
      // rows that would read them never materialize.
      threadName: "",
      workspaceRoot: null,
      includeNestedRows: true,
      turnMessageDetail: "full",
    },
  });
  return {
    rows: result.rows,
    activeThinking: result.activeThinking,
    contextWindowUsage: result.contextWindowUsage,
    materializedRowCount: materializedRows.length,
  };
}
