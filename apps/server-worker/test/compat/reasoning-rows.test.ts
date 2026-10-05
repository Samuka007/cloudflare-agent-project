import { describe, expect, it } from "vitest";
import { buildActiveThinking, projectTimelineRows } from "../../src/services/timeline.js";
import type { TimelineRow } from "../../src/contract/thread-timeline.js";
import type { UxThreadEvent } from "../../src/seam/agent-do.js";

/**
 * #303 (upstream bb #3250 port, J6 档 2): the completed CoT face. The ux
 * reasoning stream folds into persistent `reasoning` operation rows —
 * "Thought for Ns" title, prose detail, canonical `reasoningId` = the ux
 * itemId (which is also the live `activeThinking` id), delegation nesting via
 * parentToolCallId, interrupted sealing at turn end — while the live face
 * stays `activeThinking` (no pending reasoning row doubles the indicator,
 * matching bb's projection where reasoning messages materialize only at
 * completion).
 */

function uxEvent(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  createdAt = 1_000 + seq,
): UxThreadEvent {
  return { id: `evt-${seq}`, threadId: "thr_t", seq, type, data, createdAt };
}

type GenericOperationSystemRow = Extract<
  TimelineRow,
  { kind: "system"; systemKind: "operation" }
>;

function isReasoningRow(
  row: TimelineRow,
): row is GenericOperationSystemRow & { operationKind: "reasoning" } {
  return (
    row.kind === "system" &&
    row.systemKind === "operation" &&
    row.operationKind === "reasoning"
  );
}

describe("#303 — reasoning operation rows (bb #3250 parity)", () => {
  it("materializes the completed Thought row with canonical identity and duration title", () => {
    const rows = projectTimelineRows([
      uxEvent(1, "turn/started", { turnId: "t1" }, 1_000),
      uxEvent(2, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "Compare both ",
      }, 1_000),
      uxEvent(3, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "render paths.",
      }, 2_000),
      // The canonical text wins over the delta accumulation (bb finalized
      // text replaces the buffer, deduped when equal).
      uxEvent(4, "item/completed", {
        turnId: "t1",
        item: {
          type: "reasoning",
          id: "itm-rs-t1:1",
          summary: [],
          content: ["Compare both render paths."],
        },
      }, 13_000),
    ]);

    const reasoning = rows.filter(isReasoningRow);
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({
      id: "reasoning:itm-rs-t1:1",
      reasoningId: "itm-rs-t1:1",
      title: "Thought for 12s",
      detail: "Compare both render paths.",
      status: "completed",
      turnId: "t1",
      startedAt: 1_000,
      createdAt: 13_000,
      completedAt: 13_000,
    });
  });

  it("keeps the live face on activeThinking only — no pending reasoning row", () => {
    const events = [
      uxEvent(1, "turn/started", { turnId: "t1" }),
      uxEvent(2, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "still streaming",
      }),
    ];
    const rows = projectTimelineRows(events);
    expect(rows).toHaveLength(0);
    // The live face keeps the stream (bb threadStatus gate applies at the
    // route boundary; here the fold itself is status-independent).
    expect(buildActiveThinking(events, "active")?.text).toBe(
      "still streaming",
    );
  });

  it("drops an empty-text completion without leaving a row", () => {
    const rows = projectTimelineRows([
      uxEvent(1, "item/completed", {
        turnId: "t1",
        item: { type: "reasoning", id: "itm-rs-t1:1", summary: [], content: [] },
      }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("seals an open stream as an interrupted Thought row at turn completion", () => {
    const rows = projectTimelineRows([
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "cut mid-thought",
      }),
      uxEvent(2, "turn/completed", {
        turnId: "t1",
        status: "interrupted",
        error: null,
      }),
    ]);
    const reasoning = rows.filter(isReasoningRow);
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({
      id: "reasoning:itm-rs-t1:1",
      reasoningId: "itm-rs-t1:1",
      detail: "cut mid-thought",
      status: "interrupted",
    });
  });

  it("never resurrects a materialized row at turn completion", () => {
    const rows = projectTimelineRows([
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "done thinking",
      }),
      uxEvent(2, "item/completed", {
        turnId: "t1",
        item: {
          type: "reasoning",
          id: "itm-rs-t1:1",
          summary: [],
          content: ["done thinking"],
        },
      }),
      uxEvent(3, "turn/completed", { turnId: "t1", status: "completed", error: null }),
    ]);
    const reasoning = rows.filter(isReasoningRow);
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ status: "completed" });
  });

  it("nests subagent CoT into the delegation row's childRows by attribution", () => {
    const rows = projectTimelineRows([
      uxEvent(1, "item/started", {
        turnId: "t1",
        item: {
          type: "toolCall",
          id: "spawn-1",
          tool: "spawnAgent",
          arguments: {
            senderThreadId: "thr_t",
            receiverThreadIds: ["thr_child"],
            description: "research lane",
            subagent_type: "scout",
          },
          status: "pending",
          output: "",
          completedAt: null,
        },
      }),
      uxEvent(2, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:child",
        delta: "child reasoning",
        parentToolCallId: "spawn-1",
      }),
      uxEvent(3, "item/completed", {
        turnId: "t1",
        item: {
          type: "reasoning",
          id: "itm-rs-t1:child",
          summary: [],
          content: ["child reasoning"],
          parentToolCallId: "spawn-1",
        },
      }),
    ]);

    const delegation = rows.find(
      (row): row is Extract<TimelineRow, { kind: "work"; workKind: "delegation" }> =>
        row.kind === "work" && row.workKind === "delegation",
    );
    expect(delegation).toBeDefined();
    if (delegation === undefined) return;
    const [child] = delegation.childRows;
    expect(child).toBeDefined();
    expect(isReasoningRow(child)).toBe(true);
    expect(child).toMatchObject({
      reasoningId: "itm-rs-t1:child",
      detail: "child reasoning",
      status: "completed",
    });
  });

  it("truncates oversized detail with the bb tail-counted suffix", () => {
    const big = "x".repeat(32_500);
    const rows = projectTimelineRows([
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:big",
        delta: big,
      }),
      uxEvent(2, "item/completed", {
        turnId: "t1",
        item: { type: "reasoning", id: "itm-rs-t1:big", summary: [], content: [big] },
      }),
    ]);
    const reasoning = rows.filter(isReasoningRow);
    const detail = reasoning[0]?.detail ?? "";
    expect(detail.startsWith("x".repeat(32_000))).toBe(true);
    expect(detail).toContain("[500 more characters truncated]");
  });
});
