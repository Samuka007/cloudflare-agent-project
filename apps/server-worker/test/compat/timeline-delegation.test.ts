import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate";
import { projectThreadTimeline, rowsForConversationOutline } from "../../src/services/thread-view";
import type { TimelineDelegationWorkRow, TimelineRow } from "../../src/contract/thread-timeline";
import type { UxThreadEvent } from "../../src/seam/agent-do";

/**
 * #275 J4 — delegation branch of the timeline projection: the synthetic
 * spawnAgent row materializes TimelineDelegationWorkRow, terminal state
 * arrives via the thread-scoped backgroundTask family, #274-attributed rows
 * aggregate into childRows, and background rows survive turn boundaries.
 * Pure projection tests over synthetic ux envelopes (m1-ux-fixes pattern).
 * Since the #554 roadmap step ⑤ retirement the pins target the LIVE face —
 * the materializer + bb thread-view projection (services/thread-view.ts);
 * bb turn-summary wrappers (D8) are unwrapped before the flat assertions.
 */
beforeAll(ensureMigrations);

function projectRows(events: readonly UxThreadEvent[]): TimelineRow[] {
  return rowsForConversationOutline(projectThreadTimeline(events, { threadStatus: "active" }).rows);
}

let seqCounter = 0;

function uxEvent(type: string, data: unknown): UxThreadEvent {
  seqCounter += 1;
  return {
    id: `evt-${seqCounter}`,
    threadId: "thr_test",
    seq: seqCounter,
    type,
    data,
    createdAt: 1_000 + seqCounter,
  };
}

const ANCHOR = "thr_test:10";

const turnStarted = (): UxThreadEvent => uxEvent("turn/started", { turnId: "turn_1" });

function delegationStarted(overrides?: { id?: string; anchor?: string }): UxThreadEvent {
  return uxEvent("item/started", {
    turnId: "turn_1",
    item: {
      type: "toolCall",
      id: overrides?.id ?? ANCHOR,
      tool: "spawnAgent",
      arguments: {
        senderThreadId: "thr_test",
        receiverThreadIds: ["thr_child"],
        description: "Report the answer",
        subagent_type: "scout",
      },
      status: "pending",
      output: "",
      completedAt: null,
    },
  });
}

function delegationOf(rows: readonly TimelineRow[], id = ANCHOR): TimelineDelegationWorkRow {
  const row = rows.find(
    (candidate): candidate is TimelineDelegationWorkRow =>
      candidate.kind === "work" && candidate.workKind === "delegation" && candidate.callId === id,
  );
  if (row === undefined) throw new Error(`no delegation row ${id}`);
  return row;
}

describe("#275 J4 — delegation row projection", () => {
  it("materializes the contract delegation row with badge data from the synthetic arguments", () => {
    const rows = projectRows([turnStarted(), delegationStarted()]);
    const row = delegationOf(rows);
    expect(row).toMatchObject({
      workKind: "delegation",
      callId: ANCHOR,
      toolName: "spawnAgent",
      subagentType: "scout",
      description: "Report the answer",
      status: "pending",
      output: "",
      completedAt: null,
      childRows: [],
      turnId: "turn_1",
    });
  });

  it("folds the turn-scoped item/completed (blocking settle) into output and status", () => {
    const completion = uxEvent("item/completed", {
      turnId: "turn_1",
      item: {
        type: "toolCall",
        id: ANCHOR,
        tool: "spawnAgent",
        arguments: {},
        status: "completed",
        output: "blocking answer",
        completedAt: 2_500,
      },
    });
    const rows = projectRows([turnStarted(), delegationStarted(), completion]);
    expect(delegationOf(rows)).toMatchObject({
      status: "completed",
      output: "blocking answer",
      // bb completes the row at the journal envelope's createdAt (the
      // completion instant); the item's completedAt field is not read.
      completedAt: completion.createdAt,
    });
  });

  it("seals a background row from the thread-scoped completed family by parentToolCallId", () => {
    // The ux projection normalizes status/taskStatus together
    // (ux-projection.ts:74-90): taskStatus "stopped" always ships with
    // status "interrupted", which is what bb's workflow mapping renders.
    const terminal = uxEvent("item/backgroundTask/completed", {
      item: {
        type: "backgroundTask",
        id: "task:sp_1#0",
        taskType: "local_subagent",
        description: "Report the answer",
        status: "interrupted",
        taskStatus: "stopped",
        skipTranscript: false,
        summary: "",
        parentToolCallId: ANCHOR,
      },
    });
    const rows = projectRows([turnStarted(), delegationStarted(), terminal]);
    // stopped → interrupted (backgroundTaskItemStatus); no summary → output stays "".
    expect(delegationOf(rows)).toMatchObject({
      status: "interrupted",
      output: "",
      completedAt: terminal.createdAt,
    });
  });

  it("lands the settle summary into the row output (the #229 S7 summary slot)", () => {
    const rows = projectRows([
      turnStarted(),
      delegationStarted(),
      uxEvent("item/backgroundTask/completed", {
        item: {
          type: "backgroundTask",
          id: "task:sp_1#0",
          taskType: "local_subagent",
          description: "Report the answer",
          status: "completed",
          taskStatus: "completed",
          skipTranscript: false,
          summary: "The answer is 42",
          parentToolCallId: ANCHOR,
        },
      }),
    ]);
    expect(delegationOf(rows)).toMatchObject({
      status: "completed",
      output: "The answer is 42",
    });
  });

  it("never materializes a DELEGATION row from the family alone (no anchor, no phantom)", () => {
    const rows = projectRows([
      uxEvent("item/backgroundTask/completed", {
        item: {
          type: "backgroundTask",
          id: "task:sp_9#0",
          taskType: "local_subagent",
          description: "orphan",
          status: "completed",
          taskStatus: "completed",
          skipTranscript: false,
          summary: "x",
        },
      }),
      uxEvent("item/backgroundTask/progress", {
        item: {
          type: "backgroundTask",
          id: "task:sp_9#0",
          taskType: "local_subagent",
          description: "orphan",
          status: "pending",
          taskStatus: "paused",
          skipTranscript: false,
        },
      }),
    ]);
    // The porting layer dropped the orphan family entirely; the live face
    // renders bb's NATIVE background/workflow row for it instead (the
    // prompt-box activity card face) — accepted bb behavior, but still no
    // delegation row: without an anchor there is nothing to seal.
    expect(rows.filter((row) => row.kind === "work" && row.workKind === "delegation")).toHaveLength(
      0,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "work",
      workKind: "workflow",
      itemId: "task:sp_9#0",
      taskStatus: "paused",
    });
  });
});

describe("#275 J4 — childRows aggregation by parentToolCallId", () => {
  it("nests attributed tool and assistant rows; they leave the top-level timeline", () => {
    const rows = projectRows([
      turnStarted(),
      delegationStarted(),
      uxEvent("item/started", {
        turnId: "turn_1",
        item: {
          type: "toolCall",
          id: "thr_child:21",
          tool: "bash",
          arguments: { command: "ls" },
          status: "pending",
          output: "",
          completedAt: null,
          parentToolCallId: ANCHOR,
        },
      }),
      uxEvent("item/started", {
        turnId: "turn_1",
        item: { type: "agentMessage", id: "itm_am_1", text: "", parentToolCallId: ANCHOR },
      }),
      uxEvent("item/agentMessage/delta", {
        turnId: "turn_1",
        itemId: "itm_am_1",
        delta: "child says hi",
        parentToolCallId: ANCHOR,
      }),
      uxEvent("item/completed", {
        turnId: "turn_1",
        item: {
          type: "toolCall",
          id: "thr_child:21",
          tool: "bash",
          arguments: {},
          status: "completed",
          output: "files",
          completedAt: 2_700,
        },
      }),
      uxEvent("item/completed", {
        turnId: "turn_1",
        item: {
          type: "agentMessage",
          id: "itm_am_1",
          text: "child says hi",
          parentToolCallId: ANCHOR,
        },
      }),
    ]);
    const row = delegationOf(rows);
    expect(row.childRows).toHaveLength(2);
    const [first, second] = row.childRows;
    expect(first?.kind).toBe("work");
    if (first?.kind === "work" && first.workKind === "tool") {
      expect(first).toMatchObject({ callId: "thr_child:21", output: "files", status: "completed" });
    } else {
      throw new Error("expected nested tool row first");
    }
    expect(second?.kind).toBe("conversation");
    if (second?.kind === "conversation") {
      expect(second.role).toBe("assistant");
      expect(second.text).toBe("child says hi");
    }
    // Nothing leaked to the top level besides the delegation row itself.
    expect(rows).toHaveLength(1);
  });

  it("keeps unattributed rows at the top level", () => {
    const rows = projectRows([
      turnStarted(),
      delegationStarted(),
      uxEvent("item/started", {
        turnId: "turn_1",
        item: {
          type: "toolCall",
          id: "thr_test:22",
          tool: "bash",
          arguments: {},
          status: "pending",
          output: "",
          completedAt: null,
        },
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(delegationOf(rows).childRows).toHaveLength(0);
  });
});

describe("#275 J4 — replay consistency and turn boundaries", () => {
  it("a completing spawning turn does NOT seal a pending background delegation row", () => {
    const rows = projectRows([
      turnStarted(),
      delegationStarted(),
      uxEvent("turn/completed", { turnId: "turn_1", status: "completed", error: null }),
    ]);
    expect(delegationOf(rows).status).toBe("pending");
  });

  it("batch terminals seal per-item rows deterministically under the shared bare anchor", () => {
    const familyCompleted = (spawnId: string, summary: string): UxThreadEvent =>
      uxEvent("item/backgroundTask/completed", {
        item: {
          type: "backgroundTask",
          id: `task:${spawnId}#0`,
          taskType: "local_subagent",
          description: "batch",
          status: "completed",
          taskStatus: "completed",
          skipTranscript: false,
          summary,
          parentToolCallId: ANCHOR,
        },
      });
    const rows = projectRows([
      turnStarted(),
      delegationStarted({ id: `${ANCHOR}#0` }),
      delegationStarted({ id: `${ANCHOR}#1` }),
      familyCompleted("sp_1", "first"),
      familyCompleted("sp_2", "second"),
    ]);
    const first = delegationOf(rows, `${ANCHOR}#0`);
    const second = delegationOf(rows, `${ANCHOR}#1`);
    expect([first.status, second.status]).toEqual(["completed", "completed"]);
    expect([first.output, second.output]).toEqual(["first", "second"]);
  });

  it("full re-projection is identical — reload neither loses nor duplicates rows", () => {
    const events = [
      turnStarted(),
      delegationStarted(),
      uxEvent("item/backgroundTask/completed", {
        item: {
          type: "backgroundTask",
          id: "task:sp_1#0",
          taskType: "local_subagent",
          description: "Report the answer",
          status: "completed",
          taskStatus: "completed",
          skipTranscript: false,
          summary: "42",
          parentToolCallId: ANCHOR,
        },
      }),
    ];
    expect(projectRows(events)).toEqual(projectRows(events));
  });
});
