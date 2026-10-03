import { describe, expect, test } from "vitest";
import type { AgentEventDataByType, AgentEventType } from "../src/fsm-events.js";
import { parseAgentEvent, type AnyAgentEvent } from "../src/fsm-events.js";
import { modelRequestFromEvents, ProjectionError } from "../src/translate.js";
import {
  anthropicRequestBody,
  BASH_TOOL,
  toolUseIdFor,
  SYSTEM_PROMPT_BLOCKS,
} from "../src/relay/wire.js";

/**
 * Translation-layer invariants (#28 ruling ③): model-visible trio only,
 * pairing (no dangling tool_use), steer boundary attribution, and replay
 * consistency — the same log always projects byte-identical request bodies.
 */

const THREAD = "th-trans";

function event<TType extends AgentEventType>(
  seq: number,
  type: TType,
  data: AgentEventDataByType[TType],
): AnyAgentEvent {
  // parseAgentEvent is the single validation seam — test logs go through it
  // so a malformed fixture fails here, not three layers down.
  return parseAgentEvent({ id: `e${seq}`, threadId: THREAD, seq, type, data, createdAt: 0 });
}

const EXEC_1 = `${THREAD}:5`;

/** Full two-call turn: input → call1(bash ls) → result → call2(final text). */
function toolTurnLog(): AnyAgentEvent[] {
  return [
    event(1, "thread.created", { title: "t", machineId: "local" }),
    event(2, "turn.input", {
      turnId: "t1",
      inputId: "i1",
      content: [{ type: "text", text: "列出文件" }],
    }),
    event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
    event(4, "model.call_completed", {
      turnId: "t1",
      modelCallId: 3,
      text: "我来列出文件。",
      toolCalls: [{ name: "bash", arguments: { command: "ls" } }],
    }),
    event(5, "tool.call", {
      turnId: "t1",
      modelCallId: 3,
      tool: "bash",
      arguments: { command: "ls" },
      timeoutMs: 600_000,
    }),
    event(6, "tool.dispatch", {
      turnId: "t1",
      executionId: EXEC_1,
      attempt: 1,
      requestId: "r1",
      outcome: "accepted",
    }),
    event(7, "tool.exec_started", { turnId: "t1", executionId: EXEC_1 }),
    event(8, "tool.output", { turnId: "t1", executionId: EXEC_1, offset: 0, chunk: "a\n" }),
    event(9, "tool.result", {
      turnId: "t1",
      executionId: EXEC_1,
      status: "ok",
      exitCode: 0,
      output: "a\n",
    }),
    event(10, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
    event(11, "model.call_completed", {
      turnId: "t1",
      modelCallId: 10,
      text: "输出是 a。",
      toolCalls: [],
    }),
    event(12, "turn.completed", { turnId: "t1" }),
  ];
}

const WIRE_OPTS = { model: "glm-5.3", maxTokens: 8192, thinking: { type: "disabled" } as const };

describe("translation: event log → model request", () => {
  test("projects the model-visible trio with tool pairing", () => {
    const request = modelRequestFromEvents(toolTurnLog(), "t1", 10);
    expect(request.threadId).toBe(THREAD);
    expect(request.input).toBe("列出文件");
    expect(request.steers).toEqual([]);
    expect(request.priorCalls).toHaveLength(1);
    const prior = request.priorCalls[0];
    if (prior === undefined) throw new Error("missing prior call slice");
    expect(prior.modelCallId).toBe(3);
    expect(prior.text).toBe("我来列出文件。");
    expect(prior.toolCalls).toEqual([{ name: "bash", arguments: { command: "ls" } }]);
    expect(prior.toolResults).toEqual([
      { executionId: EXEC_1, tool: "bash", status: "ok", output: "a\n" },
    ]);
  });

  test("wire body: alternating roles, omp-verbatim bash tool, derived ids", () => {
    const request = modelRequestFromEvents(toolTurnLog(), "t1", 10);
    const body = anthropicRequestBody(request, WIRE_OPTS);
    expect(body.tools).toEqual([BASH_TOOL]);
    expect(BASH_TOOL.input_schema.required).toEqual(["i", "command"]);
    expect(body.system.map((block) => block.type)).toEqual(["text", "text"]);
    expect(SYSTEM_PROMPT_BLOCKS).toHaveLength(2);

    expect(body.messages).toHaveLength(3);
    const [user, assistant, results] = body.messages;
    if (user === undefined || assistant === undefined || results === undefined) {
      throw new Error(`expected 3 messages, got ${body.messages.length}`);
    }
    expect(user.role).toBe("user");
    expect(user.content).toEqual([{ type: "text", text: "列出文件" }]);
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "text", text: "我来列出文件。" },
      { type: "tool_use", id: toolUseIdFor(EXEC_1), name: "bash", input: { command: "ls" } },
    ]);
    expect(results.role).toBe("user");
    expect(results.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: toolUseIdFor(EXEC_1),
        content: "a\n",
        is_error: false,
      },
    ]);
    // ids derive from the log, never from the wire: deterministic + sanitized
    expect(toolUseIdFor("th-x:12")).toBe("toolu_th-x_12");
  });

  test("replay consistency: two replays of the same log serialize identically", () => {
    const log = toolTurnLog();
    const first = JSON.stringify(
      anthropicRequestBody(modelRequestFromEvents(log, "t1", 10), WIRE_OPTS),
    );
    const second = JSON.stringify(
      anthropicRequestBody(modelRequestFromEvents(structuredClone(log), "t1", 10), WIRE_OPTS),
    );
    expect(second).toBe(first);
    // late events (post-call) must not leak into an earlier call's request
    const atCall1 = JSON.stringify(
      anthropicRequestBody(modelRequestFromEvents(log, "t1", 3), WIRE_OPTS),
    );
    expect(atCall1).not.toBe(first);
    expect(atCall1).toContain("列出文件");
  });

  test("state events are context-invisible (ruling ③)", () => {
    const body = JSON.stringify(
      anthropicRequestBody(modelRequestFromEvents(toolTurnLog(), "t1", 10), WIRE_OPTS),
    );
    for (const marker of ["dispatch", "exec_started", "tool.output", "attempt", "requestId"]) {
      expect(body).not.toContain(marker);
    }
  });

  test("steer enters at the boundary of the call that consumed it (I9)", () => {
    const log = [
      event(1, "thread.created", { title: "t", machineId: "local" }),
      event(2, "turn.input", {
        turnId: "t1",
        inputId: "i1",
        content: [{ type: "text", text: "列目录" }],
      }),
      event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
      event(4, "model.call_completed", {
        turnId: "t1",
        modelCallId: 3,
        text: "",
        toolCalls: [{ name: "bash", arguments: { command: "ls" } }],
      }),
      event(5, "tool.call", {
        turnId: "t1",
        modelCallId: 3,
        tool: "bash",
        arguments: { command: "ls" },
        timeoutMs: 600_000,
      }),
      event(6, "tool.result", {
        turnId: "t1",
        executionId: `${THREAD}:5`,
        status: "ok",
        exitCode: 0,
        output: "a b c",
      }),
      event(7, "turn.steer", {
        turnId: "t1",
        inputId: "i2",
        content: [{ type: "text", text: "只要前三个" }],
      }),
      event(8, "model.call_started", { turnId: "t1", consumedSteerSeqs: [7] }),
    ];
    const atCall2 = anthropicRequestBody(modelRequestFromEvents(log, "t1", 8), WIRE_OPTS);
    expect(atCall2.messages).toHaveLength(3);
    const trailing = atCall2.messages[2];
    if (trailing === undefined) throw new Error("missing trailing user message");
    expect(trailing.role).toBe("user");
    expect(trailing.content).toEqual([
      { type: "tool_result", tool_use_id: toolUseIdFor(`${THREAD}:5`), content: "a b c", is_error: false },
      { type: "text", text: "只要前三个" },
    ]);
    // call 1's own request predates the steer
    const atCall1 = anthropicRequestBody(modelRequestFromEvents(log, "t1", 3), WIRE_OPTS);
    expect(JSON.stringify(atCall1)).not.toContain("只要前三个");
  });

  test("dangling tool_use is a projection error, never a silent wire request", () => {
    const log = toolTurnLog().filter((e) => !(e.type === "tool.result"));
    expect(() => modelRequestFromEvents(log, "t1", 10)).toThrow(ProjectionError);
  });

  test("error statuses map to is_error; empty output gets the omp sentinel", () => {
    const log = [
      event(1, "thread.created", { title: "t", machineId: "local" }),
      event(2, "turn.input", {
        turnId: "t1",
        inputId: "i1",
        content: [{ type: "text", text: "跑" }],
      }),
      event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
      event(4, "model.call_completed", {
        turnId: "t1",
        modelCallId: 3,
        text: "",
        toolCalls: [{ name: "bash", arguments: { command: "sleep 999" } }],
      }),
      event(5, "tool.call", {
        turnId: "t1",
        modelCallId: 3,
        tool: "bash",
        arguments: { command: "sleep 999" },
        timeoutMs: 600_000,
      }),
      event(6, "tool.result", {
        turnId: "t1",
        executionId: `${THREAD}:5`,
        status: "timeout",
        exitCode: null,
        output: "",
      }),
      event(7, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
    ];
    const body = anthropicRequestBody(modelRequestFromEvents(log, "t1", 7), WIRE_OPTS);
    const resultMessage = body.messages[2];
    if (resultMessage === undefined) throw new Error("missing result message");
    const block = resultMessage.content[0];
    if (block === undefined) throw new Error("missing tool_result block");
    expect(block).toEqual({
      type: "tool_result",
      tool_use_id: toolUseIdFor(`${THREAD}:5`),
      content: "(empty output)",
      is_error: true,
    });
  });
});
