/**
 * #554 spike harness: same ux window through (A) the current timeline.ts
 * porting layer and (B) materializer → bb thread-view, with a row-by-row
 * diff. Run: bun harness.ts
 */
import { writeFileSync } from "node:fs";

import { uxJournal, THREAD_ID } from "./fixture.ts";
import { materializeUxWindowToStoredEventRows } from "./materializer.ts";

// Path A — the porting layer under retirement.
import {
  buildActiveThinking,
  buildContextWindowUsage,
  projectTimelineRows,
} from "../../../../apps/server-worker/src/services/timeline.ts";

// Path B — bb's pure projection, verbatim.
import {
  decodeThreadEventRow,
} from "../../../../bb/packages/thread-view/src/event-decode.ts";
import {
  EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
} from "../../../../bb/packages/thread-view/src/accepted-client-request-context.ts";
import {
  buildThreadTimelineFromEvents,
} from "../../../../bb/packages/thread-view/src/build-thread-timeline.ts";

const threadStatusA = "idle";

// --- Path A -----------------------------------------------------------------

const rowsA = projectTimelineRows(uxJournal);
const activeThinkingA = buildActiveThinking(uxJournal, threadStatusA);
const contextWindowUsageA = buildContextWindowUsage(uxJournal);

// --- Path B -----------------------------------------------------------------

const storedRows = materializeUxWindowToStoredEventRows(uxJournal);
const eventsWithMeta = storedRows.map((row) => decodeThreadEventRow(row));
const contextWindowEvents = eventsWithMeta.filter(
  ({ event }) => event.type === "thread/contextWindowUsage/updated",
);
const timelineEvents = eventsWithMeta.filter(
  ({ event }) => event.type !== "thread/contextWindowUsage/updated",
);

const resultB = buildThreadTimelineFromEvents({
  acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
  contextWindowEvents,
  events: timelineEvents,
  options: {
    contextOnlyToolCallIds: new Set(),
    includeDebugRawEvents: false,
    includeProviderUnhandledOperations: false,
    isLatestPage: true,
    threadStatus: "idle",
    threadName: "",
    workspaceRoot: null,
    includeNestedRows: true,
    turnMessageDetail: "full",
  },
});

// --- diff -------------------------------------------------------------------

interface RowSummary {
  key: string;
  family: string;
  titleOrRole: string;
  status: string | null;
  seq: [number, number];
  textLen: number;
  textHead: string;
  extra: Record<string, unknown>;
}

function summarizeRow(rowA: Record<string, unknown>): RowSummary {
  const kind = String(rowA.kind);
  const family =
    kind === "work"
      ? String(rowA.workKind)
      : kind === "system"
        ? `system/${String(rowA.systemKind)}${rowA.operationKind !== undefined ? `/${String(rowA.operationKind)}` : ""}`
        : kind === "conversation"
          ? `conversation/${String(rowA.role)}`
          : kind;
  const titleOrRole =
    rowA.title !== undefined
      ? String(rowA.title)
      : rowA.text !== undefined
        ? String(rowA.text).slice(0, 80)
        : "";
  const textLen =
    rowA.text !== undefined
      ? String(rowA.text).length
      : rowA.output !== undefined
        ? String(rowA.output).length
        : rowA.detail !== undefined && rowA.detail !== null
          ? String(rowA.detail).length
          : 0;
  const fullText =
    rowA.text !== undefined
      ? String(rowA.text)
      : rowA.output !== undefined
        ? String(rowA.output)
        : rowA.detail !== null && rowA.detail !== undefined
          ? String(rowA.detail)
          : "";
  return {
    key: String(rowA.id),
    family,
    titleOrRole,
    status: rowA.status === undefined ? null : String(rowA.status),
    seq: [Number(rowA.sourceSeqStart), Number(rowA.sourceSeqEnd)],
    textLen,
    textHead: fullText.slice(0, 60),
    extra: {
      ...(rowA.toolName !== undefined ? { toolName: rowA.toolName } : {}),
      ...(rowA.callId !== undefined ? { callId: rowA.callId } : {}),
      ...(rowA.turnId !== undefined ? { turnId: rowA.turnId } : {}),
      ...(rowA.reasoningId !== undefined ? { reasoningId: rowA.reasoningId } : {}),
      ...(rowA.completedAt !== undefined ? { completedAt: rowA.completedAt } : {}),
      ...(rowA.childRows !== undefined
        ? { childRows: (rowA.childRows as Record<string, unknown>[]).length }
        : {}),
      ...(rowA.children !== undefined
        ? { children: (rowA.children as unknown[]).length }
        : {}),
      ...(rowA.summaryCount !== undefined ? { summaryCount: rowA.summaryCount } : {}),
      ...(rowA.subagentType !== undefined ? { subagentType: rowA.subagentType } : {}),
      ...(rowA.description !== undefined ? { description: rowA.description } : {}),
    },
  };
}

const flatB = (resultB.rows as Record<string, unknown>[]).flatMap((rowA) =>
  rowA.kind === "turn"
    ? [
        summarizeRow(rowA),
        ...((rowA.children as Record<string, unknown>[]) ?? []).map(summarizeRow),
      ]
    : [summarizeRow(rowA)],
);
const flatA = rowsA.map((rowA) => summarizeRow(rowA as unknown as Record<string, unknown>));

const report = {
  counts: {
    uxEnvelopeCount: uxJournal.length,
    materializedRowCount: storedRows.length,
    pathARowCount: rowsA.length,
    pathBTopLevelCount: (resultB.rows as Record<string, unknown>[]).length,
    pathBFlattenedCount: flatB.length,
  },
  tailState: {
    activeThinkingA,
    activeThinkingB: resultB.activeThinking,
    contextWindowUsageA,
    contextWindowUsageB: resultB.contextWindowUsage,
  },
  pathARows: flatA,
  pathBRows: flatB,
};

console.log(JSON.stringify(report, null, 2));
writeFileSync(new URL("./diff-output.json", import.meta.url), JSON.stringify(report, null, 2));
console.error(`thread ${THREAD_ID}: A=${rowsA.length} rows, B=${flatB.length} flattened rows`);
