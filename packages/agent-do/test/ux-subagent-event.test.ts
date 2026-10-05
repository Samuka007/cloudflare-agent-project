import { describe, expect, test } from "vitest";
import { parseThreadEvent, type ThreadEventEnvelope, type TypedThreadEvent } from "@cap/protocol";
import {
  parseAgentEvent,
  type AnyAgentEvent,
  type SubagentActivityUnit,
} from "../src/fsm-events.js";
import { projectToUxEvents } from "../src/ux-projection.js";
import {
  lastActivityFlushThroughSeq,
  projectActivityFlush,
} from "../src/tools/task/activity-flush.js";
import { executionIdFor } from "../src/ids.js";

/**
 * #276 J5 — child activity/CoT backflow as `task.subagent_event` wrapper
 * rows (journal-first, the omp `subagent_event` frame isomorph): the flush
 * fold derives summary units from the child journal, the parent ux projection
 * unfolds them into delegation-attributed rows, and the J6 tier-1 reasoning
 * terminal rides the root face. Pure projection tests over synthetic
 * journals (ux-delegation pattern).
 */

const THREAD = "thr_child";
const PARENT = "thr_parent";
const TURN = "turn_1";
const ANCHOR = `${PARENT}:10`;

let seqCounter = 0;

function row(
  type: AnyAgentEvent["type"],
  data: unknown,
  createdAt = 1_000,
  threadId: string = THREAD,
): AnyAgentEvent {
  seqCounter += 1;
  return parseAgentEvent({
    threadId,
    seq: seqCounter,
    id: `evt-${seqCounter}`,
    type,
    data,
    createdAt,
  });
}

function spawnPlanned(overrides?: { parentToolCallId?: string }): AnyAgentEvent {
  return row("task.spawn_planned", {
    executionId: ANCHOR,
    spawnId: "sp_1",
    agentId: "task-1",
    agent: "scout",
    childThreadId: THREAD,
    parentThreadId: PARENT,
    machineId: "mach_1",
    mode: "background",
    jobId: "job_1",
    task: "Report the answer",
    solutionSpace: "",
    parentToolCallId:
      overrides && "parentToolCallId" in overrides ? overrides.parentToolCallId : ANCHOR,
    depth: 1,
  });
}

/** One wrapper row per unit — the shape reportSubagentActivity journals. */
function wrapperRows(units: SubagentActivityUnit[], createdAt = 2_000): AnyAgentEvent[] {
  // Wrapper rows live in the PARENT journal (the backflow target).
  return units.map((unit) =>
    row(
      "task.subagent_event",
      {
        spawnId: "sp_1",
        agentId: "task-1",
        childThreadId: THREAD,
        parentToolCallId: ANCHOR,
        unit,
      },
      createdAt,
      PARENT,
    ),
  );
}

function thinkingRow(text: unknown, modelCallId = 1): AnyAgentEvent {
  return row("model.thinking", { turnId: TURN, modelCallId, text });
}

const completedCall = (text: string, modelCallId = 1): AnyAgentEvent =>
  row("model.call_completed", { turnId: TURN, modelCallId, text, toolCalls: [] });

function toolCallRow(tool: string): AnyAgentEvent {
  const call = row("tool.call", {
    turnId: TURN,
    modelCallId: 1,
    tool,
    arguments: { path: "src/x.ts" },
    timeoutMs: 600_000,
  });
  return call;
}

const isTyped = (event: ThreadEventEnvelope): TypedThreadEvent => parseThreadEvent(event);

/**
 * The parent-side task tool call the anchor id points at — fixed seq so
 * `executionIdFor(PARENT, 10)` === ANCHOR (the projection derives item ids
 * from the journaled seq, exactly like the DO).
 */
function parentTaskCall(): AnyAgentEvent {
  return parseAgentEvent({
    threadId: PARENT,
    seq: 10,
    id: "evt-parent-call",
    type: "tool.call",
    data: {
      turnId: "turn_parent",
      modelCallId: 1,
      tool: "task",
      arguments: { task: "x" },
      timeoutMs: 600_000,
    },
    createdAt: 900,
  });
}

describe("#276 J5 — projectActivityFlush (child journal → units)", () => {
  test("one full turn folds into ordered thinking/message/tool units", () => {
    const thinking = thinkingRow("Let me check the file. ");
    const thinking2 = thinkingRow("Then I will answer.", 1);
    const call = completedCall("Checking now.");
    const tool = toolCallRow("read");
    const result = row("tool.result", {
      turnId: TURN,
      executionId: executionIdFor(THREAD, tool.seq),
      status: "ok",
      exitCode: 0,
      output: "file contents",
    });

    const { units, throughSeq } = projectActivityFlush(
      [thinking, thinking2, call, tool, result],
      0,
      5000,
    );

    // Source order: the thinking summary sits at its last contributing row,
    // the message at call_completed, the tool pair at dispatch/result.
    expect(units.map((unit) => unit.kind)).toEqual([
      "thinking",
      "message",
      "tool_started",
      "tool_completed",
    ]);
    const thinkingUnit = units[0];
    if (thinkingUnit?.kind !== "thinking") throw new Error("unreachable");
    expect(thinkingUnit.text).toBe("Let me check the file. Then I will answer.");
    expect(thinkingUnit.sourceSeq).toBe(thinking2.seq);
    expect(thinkingUnit.modelCallId).toBe(1);
    expect(thinkingUnit.turnId).toBe(TURN);
    const message = units[1];
    if (message?.kind !== "message") throw new Error("unreachable");
    expect(message.text).toBe("Checking now.");
    expect(message.sourceSeq).toBe(call.seq);
    const started = units[2];
    if (started?.kind !== "tool_started") throw new Error("unreachable");
    expect(started.executionId).toBe(executionIdFor(THREAD, tool.seq));
    expect(started.tool).toBe("read");
    expect(started.arguments).toEqual({ path: "src/x.ts" });
    const done = units[3];
    if (done?.kind !== "tool_completed") throw new Error("unreachable");
    expect(done.status).toBe("ok");
    expect(done.output).toBe("file contents");
    expect(done.completedAt).toBe(result.createdAt);
    expect(throughSeq).toBe(result.seq);
  });

  test("cursor since the last flush yields an empty batch (idempotent re-flush)", () => {
    const events = [thinkingRow("thinking"), completedCall("answer")];
    const first = projectActivityFlush(events, 0, 5000);
    expect(first.units).toHaveLength(2);
    const cursorRow = row("task.subagent_flush", { throughSeq: first.throughSeq });
    expect(lastActivityFlushThroughSeq([...events, cursorRow])).toBe(first.throughSeq);
    const second = projectActivityFlush([...events, cursorRow], first.throughSeq, 5000);
    expect(second.units).toEqual([]);
  });

  test("summary caps apply with a visible truncation marker", () => {
    const huge = "x".repeat(6000);
    const { units } = projectActivityFlush([thinkingRow(huge), completedCall(huge)], 0, 5000);
    for (const unit of units) {
      if (unit.kind === "thinking" || unit.kind === "message") {
        expect(unit.text.startsWith("x".repeat(5000))).toBe(true);
        expect(unit.text).toContain("…[truncated]");
        expect(unit.text.length).toBeLessThan(huge.length);
      }
    }
  });

  test("blob-offloaded thinking rows contribute nothing (no empty terminal)", () => {
    const blob = { __blob__: { key: "blob/x", size: 10, sha256: "abc" } };
    const { units } = projectActivityFlush([thinkingRow(blob), completedCall("answer")], 0, 5000);
    expect(units.map((unit) => unit.kind)).toEqual(["message"]);
  });

  test("a tool result without a journaled call keeps the face (tool unknown)", () => {
    const orphan = row("tool.result", {
      turnId: TURN,
      executionId: "thr_child:1",
      status: "error",
      exitCode: 1,
      output: "boom",
    });
    const { units } = projectActivityFlush([orphan], 0, 5000);
    const done = units[0];
    if (done?.kind !== "tool_completed") throw new Error("unreachable");
    expect(done.tool).toBe("unknown");
    expect(done.status).toBe("error");
  });
});

describe("#276 J5 — ux projection unfolds wrapper rows (parent face)", () => {
  test("each unit becomes one attributed ux row with the wrapper's transport identity", () => {
    const tool = toolCallRow("read");
    const units = projectActivityFlush(
      [
        thinkingRow("deliberating"),
        completedCall("the answer"),
        tool,
        row("tool.result", {
          turnId: TURN,
          executionId: executionIdFor(THREAD, tool.seq),
          status: "error",
          exitCode: 1,
          output: "boom",
        }),
      ],
      0,
      5000,
    ).units;
    const wrappers = wrapperRows(units);
    const ux = projectToUxEvents([parentTaskCall(), spawnPlanned(), ...wrappers]).map(isTyped);

    const started = ux.find(
      (event): event is Extract<TypedThreadEvent, { type: "item/started" }> =>
        event.type === "item/started" &&
        event.data.item.type === "toolCall" &&
        event.data.item.tool === "read",
    );
    expect(started?.data.item.type).toBe("toolCall");
    if (started?.data.item.type === "toolCall") {
      expect(started.data.item.parentToolCallId).toBe(ANCHOR);
      expect(started.data.item.tool).toBe("read");
      expect(started.data.item.status).toBe("pending");
      expect(started.data.turnId).toBe(TURN);
    }

    const completions = ux.filter(
      (event): event is Extract<TypedThreadEvent, { type: "item/completed" }> =>
        event.type === "item/completed",
    );
    const toolDone = completions.find((event) => event.data.item.type === "toolCall");
    if (toolDone?.data.item.type === "toolCall") {
      expect(toolDone.data.item.status).toBe("failed");
      expect(toolDone.data.item.output).toBe("boom");
      expect(toolDone.data.item.parentToolCallId).toBe(ANCHOR);
    }
    const message = completions.find((event) => event.data.item.type === "agentMessage");
    if (message?.data.item.type === "agentMessage") {
      expect(message.data.item.text).toBe("the answer");
      expect(message.data.item.id).toBe(`itm-am-${TURN}:1`);
      expect(message.data.item.parentToolCallId).toBe(ANCHOR);
    }
    const reasoning = completions.find((event) => event.data.item.type === "reasoning");
    if (reasoning?.data.item.type === "reasoning") {
      expect(reasoning.data.item.id).toBe(`itm-rs-${TURN}:1`);
      expect(reasoning.data.item.content).toEqual(["deliberating"]);
      expect(reasoning.data.item.parentToolCallId).toBe(ANCHOR);
      expect(reasoning.data.item.summary).toEqual([]);
    }
    // Transport identity rides the wrapper row (I3 on the ux view).
    const last = wrappers.at(-1);
    const lastUx = ux.find((event) => event.seq === last?.seq);
    expect(lastUx?.id).toBe(last?.id);
    expect(lastUx?.threadId).toBe(PARENT);
  });

  test("pre-J1 journals (anchorless plans) keep the old face: wrapper rows project nothing", () => {
    const units = projectActivityFlush([completedCall("answer")], 0, 5000).units;
    const ux = projectToUxEvents([
      parentTaskCall(),
      spawnPlanned({ parentToolCallId: undefined }),
      ...wrapperRows(units),
    ]);
    expect(ux).toHaveLength(0);
  });

  test("unknown spawnId (no plan row) projects nothing", () => {
    const units = projectActivityFlush([completedCall("answer")], 0, 5000).units;
    const rows = units.map((unit) =>
      row("task.subagent_event", {
        spawnId: "sp_unknown",
        agentId: "task-1",
        childThreadId: THREAD,
        parentToolCallId: ANCHOR,
        unit,
      }),
    );
    expect(projectToUxEvents(rows)).toHaveLength(0);
  });

  test("replay-stable fold: projecting twice is byte-identical, typed re-parse matches", () => {
    const units = projectActivityFlush(
      [thinkingRow("think"), completedCall("answer"), toolCallRow("grep")],
      0,
      5000,
    ).units;
    const journal = [parentTaskCall(), spawnPlanned(), ...wrapperRows(units)];
    const first = projectToUxEvents(journal);
    const second = projectToUxEvents(journal);
    expect(second).toEqual(first);
    expect(second.map(parseThreadEvent)).toEqual(first.map(parseThreadEvent));
  });
});

describe("#276 J6 tier 1 — CoT terminal row on the root face", () => {
  test("call_completed emits the reasoning terminal before the answer row (same seq)", () => {
    const thinking = thinkingRow("step one ", 7);
    const thinking2 = thinkingRow("step two", 7);
    const call = completedCall("final answer", 7);
    const ux = projectToUxEvents([thinking, thinking2, call]).map(isTyped);

    const reasoning = ux.find(
      (event): event is Extract<TypedThreadEvent, { type: "item/completed" }> =>
        event.type === "item/completed" && event.data.item.type === "reasoning",
    );
    expect(reasoning?.data.item).toMatchObject({
      type: "reasoning",
      id: `itm-rs-${TURN}:7`,
      summary: [],
      content: ["step one step two"],
    });
    expect(reasoning?.seq).toBe(call.seq);

    const answerIndex = ux.findIndex(
      (event) => event.type === "item/completed" && event.data.item.type === "agentMessage",
    );
    const reasoningIndex = ux.findIndex(
      (event) => event.type === "item/completed" && event.data.item.type === "reasoning",
    );
    expect(reasoningIndex).toBeLessThan(answerIndex);
    expect(answerIndex).toBe(ux.length - 1);
  });

  test("a call without thinking emits no reasoning row (answer-only face unchanged)", () => {
    const ux = projectToUxEvents([completedCall("no thinking here")]).map(isTyped);
    expect(ux.filter((event) => event.type === "item/completed")).toHaveLength(1);
  });

  test("blob-offloaded thinking yields no reasoning terminal (raw log carries the blob)", () => {
    const blob = { __blob__: { key: "blob/y", size: 10, sha256: "def" } };
    const ux = projectToUxEvents([thinkingRow(blob, 3), completedCall("answer", 3)]).map(isTyped);
    expect(
      ux.filter((event) => event.type === "item/completed" && event.data.item.type === "reasoning"),
    ).toHaveLength(0);
  });
});
