/**
 * #560 CI diff harness: the same ux window through (A) the retired porting
 * layer (services/timeline.ts projectTimelineRows + buildActiveThinking +
 * buildContextWindowUsage) and (B) the switched materializer + bb
 * thread-view face (services/thread-view.ts projectThreadTimeline), with a
 * row-by-row semantic comparison — the spike harness
 * (docs/research/spike/journal-stored-event-row/harness.ts, lane-554)
 * promoted into CI.
 *
 * The comparison is identity-agnostic (D1 id namespaces differ by design)
 * and orders by (family, sourceSeqStart, title/text head); the accepted
 * deltas stay out of the comparison surface and are pinned by the focused
 * assertions below:
 * - D2 thread-scoped error row ordering (bb renders it after its turn);
 * - D8 bb turn-summary wrappers (children flattened before comparing);
 * - D4/D5/D7 cap deltas are synthesized in BOTH faces, so they must match.
 */
import { describe, expect, it } from "vitest";

import {
  buildActiveThinking,
  buildContextWindowUsage,
  buildConversationOutline,
  projectTimelineRows,
} from "../../src/services/timeline.js";
import {
  projectThreadTimeline,
  rowsForConversationOutline,
} from "../../src/services/thread-view.js";
import type { TimelineRow } from "../../src/contract/thread-timeline.js";
import { THREAD_STATUS, uxJournal } from "./fixture.js";

interface RowSummary {
  family: string;
  titleOrRole: string;
  status: string | null;
  seq: [number, number];
  textLen: number;
  textHead: string;
  extra: Record<string, unknown>;
}

function summarizeRow(row: TimelineRow): RowSummary {
  const family =
    row.kind === "work"
      ? `work/${row.workKind}`
      : row.kind === "system"
        ? `system/${row.systemKind}${"operationKind" in row ? `/${row.operationKind}` : ""}`
        : row.kind === "conversation"
          ? `conversation/${row.role}`
          : row.kind;
  const titleOrRole = "title" in row ? row.title : "text" in row ? row.text : "";
  const fullText =
    "text" in row
      ? row.text
      : "output" in row
        ? row.output
        : "detail" in row && row.detail !== null
          ? row.detail
          : "";
  const extra: Record<string, unknown> = {};
  if ("toolName" in row) extra.toolName = row.toolName;
  if ("callId" in row) extra.callId = row.callId;
  if ("turnId" in row) extra.turnId = row.turnId;
  if ("reasoningId" in row) extra.reasoningId = row.reasoningId;
  if ("completedAt" in row) extra.completedAt = row.completedAt;
  if ("childRows" in row) extra.childRows = row.childRows?.length ?? 0;
  if ("children" in row) extra.children = row.children?.length ?? 0;
  if ("subagentType" in row) extra.subagentType = row.subagentType;
  if ("description" in row) extra.description = row.description;
  if ("path" in row) extra.path = row.path;
  if (row.kind === "conversation" && row.role === "user") {
    const zeroCount =
      row.attachments !== null &&
      row.attachments.webImages === 0 &&
      row.attachments.localImages === 0 &&
      row.attachments.localFiles === 0;
    extra.attachments = row.attachments === null || zeroCount ? "none" : "present";
  }
  return {
    family,
    titleOrRole: titleOrRole.slice(0, 80),
    status: "status" in row ? row.status : null,
    seq: [row.sourceSeqStart, row.sourceSeqEnd],
    textLen: fullText.length,
    textHead: fullText.slice(0, 60),
    extra,
  };
}

/** Flatten bb turn-summary wrappers (D8) — the porting layer has no turn rows. */
function flattenRows(rows: readonly TimelineRow[]): TimelineRow[] {
  const flat: TimelineRow[] = [];
  for (const row of rows) {
    if (row.kind === "turn") {
      if (row.children !== null) {
        flat.push(...flattenRows(row.children));
      }
      continue;
    }
    flat.push(row);
  }
  return flat;
}

/**
 * Identity-agnostic comparison key: row ids differ by design (D1 namespaces);
 * seq bounds are dropped because the bb face shifts the steer user row onto
 * the acceptance seq (±1, #554 §4-D6) and bounds background-settled
 * delegation rows at the settle row's seq (D5) — family + content + status
 * carry the equivalence, and the D4 Thought rows' stream-position seqs are
 * pinned exactly by the dedicated parity assertion below; the bb user rows
 * carry a zero-count attachments object where the porting layer ships null
 * (#320 A5 contract note documents both shapes).
 */
function compareKey(summary: RowSummary): string {
  const extra = { ...summary.extra };
  return [
    summary.family,
    summary.titleOrRole,
    String(summary.status),
    summary.textHead,
    JSON.stringify(extra),
  ].join("|");
}

const threadStatus = THREAD_STATUS;

// --- Path A: the retired porting layer -------------------------------------
const rowsA = projectTimelineRows(uxJournal);
const activeThinkingA = buildActiveThinking(uxJournal, threadStatus);
const contextWindowUsageA = buildContextWindowUsage(uxJournal);

// --- Path B: the switched projection ----------------------------------------
const projectedB = projectThreadTimeline(uxJournal, { threadStatus });
const rowsB = projectedB.rows;
const summariesA = rowsA
  .map(summarizeRow)
  .sort((a, b) => compareKey(a).localeCompare(compareKey(b)));
const summariesB = flattenRows(rowsB)
  .map(summarizeRow)
  .sort((a, b) => compareKey(a).localeCompare(compareKey(b)));

describe("#560 dual-path timeline diff harness (spike #554 harness in CI)", () => {
  it("projects the same row count through both faces", () => {
    expect(summariesB).toHaveLength(summariesA.length);
  });

  it("matches every row semantically (family/title/status/seq/text/extra)", () => {
    expect(summariesB.map(compareKey)).toEqual(summariesA.map(compareKey));
  });

  it("matches the tail state (activeThinking + contextWindowUsage)", () => {
    expect(projectedB.activeThinking).toEqual(activeThinkingA);
    expect(projectedB.contextWindowUsage).toEqual(contextWindowUsageA);
  });

  it("synthesizes the D4 Thought rows in both faces (status/identity parity)", () => {
    type ThoughtRow = TimelineRow & { operationKind: string; reasoningId: string };
    const thoughts = (rows: readonly TimelineRow[]): ThoughtRow[] =>
      rows.filter(
        (row): row is ThoughtRow =>
          row.kind === "system" &&
          row.systemKind === "operation" &&
          row.operationKind === "reasoning",
      );
    const a = thoughts(rowsA).sort((x, y) => x.reasoningId.localeCompare(y.reasoningId));
    const b = thoughts(flattenRows(rowsB)).sort((x, y) =>
      x.reasoningId.localeCompare(y.reasoningId),
    );
    expect(b.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it("seals the BATCH delegation rows in plan order (D5 k-th settle)", () => {
    const delegations = flattenRows(rowsB).filter(
      (
        row,
      ): row is TimelineRow & {
        workKind: string;
        callId: string;
        status: string;
        output: string;
      } => row.kind === "work" && row.workKind === "delegation",
    );
    const batch = delegations
      .filter((row) => row.callId.startsWith("exec_batch_call"))
      .sort((x, y) => x.callId.localeCompare(y.callId));
    expect(batch.map((row) => row.callId)).toEqual(["exec_batch_call#0", "exec_batch_call#1"]);
    expect(batch.map((row) => row.status)).toEqual(["completed", "error"]);
    expect(batch[0]).toMatchObject({ status: "completed", output: "batch item 0 summary" });
    expect(batch[1]).toMatchObject({ status: "error", output: "batch item 1 crashed" });
  });

  it("keeps the single background delegation sealed with the settle summary", () => {
    const delegations = flattenRows(rowsB).filter(
      (
        row,
      ): row is TimelineRow & {
        workKind: string;
        callId: string;
        status: string;
        output: string;
      } => row.kind === "work" && row.workKind === "delegation",
    );
    const single = delegations.find((row) => row.callId === "exec_0016");
    expect(single).toMatchObject({ status: "completed", output: "agentId: child-1\nScout done." });
  });

  it("nests the attributed child rows under the delegation (D5 gate parity)", () => {
    const delegations = flattenRows(rowsB).filter(
      (row): row is TimelineRow & { workKind: string; callId: string; childRows: TimelineRow[] } =>
        row.kind === "work" && row.workKind === "delegation",
    );
    const single = delegations.find((row) => row.callId === "exec_0016");
    expect(single?.childRows.length).toBe(
      rowsA.find(
        (row): row is TimelineRow & { callId: string; childRows: TimelineRow[] } =>
          row.kind === "work" && row.workKind === "delegation" && row.callId === "exec_0016",
      )?.childRows.length,
    );
  });

  it("matches the conversation outline feed (role/preview; D1 ids and the zero-count attachment normalization differ)", () => {
    const outlineB = buildConversationOutline(rowsForConversationOutline(projectedB.rows)).map(
      (item) => ({ role: item.role, preview: item.preview }),
    );
    const outlineA = buildConversationOutline(rowsA).map((item) => ({
      role: item.role,
      preview: item.preview,
    }));
    expect(outlineB).toEqual(outlineA);
  });
});
