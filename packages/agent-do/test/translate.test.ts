import { describe, expect, test } from "vitest";
import type { AgentEventDataByType, AgentEventType } from "../src/fsm-events.js";
import { parseAgentEvent, type AnyAgentEvent } from "../src/fsm-events.js";
import { modelRequestFromEvents, ProjectionError } from "../src/translate.js";
import { anthropicRequestBody, toolUseIdFor, SYSTEM_PROMPT_BLOCKS } from "../src/relay/wire.js";
import { MAIN_WIRE_TOOLS, M0_RENDER_FLAGS, wireToolSet } from "../src/tools/registry.js";

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

const WIRE_OPTS = { model: "test-model", maxTokens: 8192, thinking: { type: "disabled" } as const };

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
    // The Main surface (M1.5 T16): every registered row minus the hidden
    // `yield` tail — the body renders MAIN_WIRE_TOOLS, not the raw registry.
    expect(body.tools).toEqual(wireToolSet(M0_RENDER_FLAGS, MAIN_WIRE_TOOLS));
    const bash = (body.tools ?? []).find((tool) => tool.name === "bash");
    if (bash === undefined) throw new Error("bash missing from registry-rendered tool set");
    expect(bash.input_schema.required).toEqual(["command", "i"]);
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
      {
        type: "tool_result",
        tool_use_id: toolUseIdFor(`${THREAD}:5`),
        content: "a b c",
        is_error: false,
      },
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

  test("error statuses map to is_error + the #454 marker; empty output rides the sentinel", () => {
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
      content: "[tool error] (empty output)",
      is_error: true,
    });
  });

  test("#454 not-executed result: the marker carries the refusal code", () => {
    const log = [
      event(1, "thread.created", { title: "t", machineId: "cloud" }),
      event(2, "turn.input", {
        turnId: "t1",
        inputId: "i1",
        content: [{ type: "text", text: "跑 hostname" }],
      }),
      event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
      event(4, "model.call_completed", {
        turnId: "t1",
        modelCallId: 3,
        text: "",
        toolCalls: [{ name: "bash", arguments: { command: "hostname" } }],
      }),
      event(5, "tool.call", {
        turnId: "t1",
        modelCallId: 3,
        tool: "bash",
        arguments: { command: "hostname" },
        timeoutMs: 600_000,
      }),
      event(6, "tool.result", {
        turnId: "t1",
        executionId: `${THREAD}:5`,
        status: "error",
        exitCode: null,
        errorCode: "host_offline",
        output: "tool not executed: bound host offline",
      }),
      event(7, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
    ];
    const request = modelRequestFromEvents(log, "t1", 7);
    const prior = request.priorCalls[0];
    if (prior === undefined) throw new Error("missing prior call slice");
    expect(prior.toolResults).toEqual([
      {
        executionId: `${THREAD}:5`,
        tool: "bash",
        status: "error",
        output: "tool not executed: bound host offline",
        errorCode: "host_offline",
      },
    ]);
    // Anthropic face: is_error stays, and the content is unmistakably a
    // refusal — never a bare host_offline token reading as stdout.
    const body = anthropicRequestBody(request, WIRE_OPTS);
    const block = body.messages[2]?.content[0];
    expect(block).toEqual({
      type: "tool_result",
      tool_use_id: toolUseIdFor(`${THREAD}:5`),
      content: "[tool error host_offline] tool not executed: bound host offline",
      is_error: true,
    });
  });
});

// #147 — the context assembly consumes the checkpoint/rewind boundary
// (decomposition.md 上下文装配 row; omp session-context.ts:339-343): after a
// completed rewind the next turn's request truncates at the checkpoint
// boundary and the report rides as the prefix overlay.
describe("translation: rewind boundary cut (#147)", () => {
  /** Long hidden-span material — must never reach a post-cut request. */
  const EXPLORATION = "instrumentation drill: pump the loop, trace the drain manifold, ".repeat(20);
  const SUMMARY = "leak is in the drain path";

  /**
   * t1: checkpoint (boundary = seq 6) → think exploration → rewind (seq 14)
   * → turn end (seq 16); t2 starts post-cut at seq 17.
   */
  function rewindJournal(): AnyAgentEvent[] {
    return [
      event(1, "thread.created", { title: "t", machineId: "local" }),
      event(2, "turn.input", {
        turnId: "t1",
        inputId: "i1",
        content: [{ type: "text", text: "find the leak" }],
      }),
      event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
      event(4, "model.call_completed", {
        turnId: "t1",
        modelCallId: 3,
        text: "",
        toolCalls: [{ name: "checkpoint", arguments: { goal: "find the leak" } }],
      }),
      event(5, "tool.call", {
        turnId: "t1",
        modelCallId: 3,
        tool: "checkpoint",
        arguments: { goal: "find the leak" },
        timeoutMs: 600_000,
      }),
      event(6, "tool.result", {
        turnId: "t1",
        executionId: `${THREAD}:5`,
        status: "ok",
        exitCode: 0,
        output: "Checkpoint: find the leak",
      }),
      event(7, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
      event(8, "model.call_completed", {
        turnId: "t1",
        modelCallId: 7,
        text: "",
        toolCalls: [{ name: "think", arguments: { thoughts: EXPLORATION } }],
      }),
      event(9, "tool.call", {
        turnId: "t1",
        modelCallId: 7,
        tool: "think",
        arguments: { thoughts: EXPLORATION },
        timeoutMs: 600_000,
      }),
      event(10, "tool.result", {
        turnId: "t1",
        executionId: `${THREAD}:9`,
        status: "ok",
        exitCode: 0,
        output: "",
      }),
      event(11, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
      event(12, "model.call_completed", {
        turnId: "t1",
        modelCallId: 11,
        text: "",
        toolCalls: [{ name: "rewind", arguments: { report: `  ${SUMMARY}  ` } }],
      }),
      event(13, "tool.call", {
        turnId: "t1",
        modelCallId: 11,
        tool: "rewind",
        arguments: { report: `  ${SUMMARY}  ` },
        timeoutMs: 600_000,
      }),
      event(14, "tool.result", {
        turnId: "t1",
        executionId: `${THREAD}:13`,
        status: "ok",
        exitCode: 0,
        output: "Rewind requested.",
      }),
      // A hidden-span async follow-up: without the cut its boundary owner is
      // the post-cut call (seq 18) and it re-injects after the rewind.
      event(15, "task.async_result", {
        spawnId: "spawn-1",
        agentId: "Task-1",
        jobId: "job-1",
        status: "ok",
        output: "stale pre-boundary completion",
      }),
      event(16, "turn.completed", { turnId: "t1" }),
      event(17, "turn.input", {
        turnId: "t2",
        inputId: "i2",
        content: [{ type: "text", text: "continue" }],
      }),
      event(18, "model.call_started", { turnId: "t2", consumedSteerSeqs: [] }),
      event(19, "model.call_completed", {
        turnId: "t2",
        modelCallId: 18,
        text: "checking the drain first",
        toolCalls: [{ name: "think", arguments: { thoughts: "post-cut scratch" } }],
      }),
      event(20, "tool.call", {
        turnId: "t2",
        modelCallId: 18,
        tool: "think",
        arguments: { thoughts: "post-cut scratch" },
        timeoutMs: 600_000,
      }),
      event(21, "tool.result", {
        turnId: "t2",
        executionId: `${THREAD}:20`,
        status: "ok",
        exitCode: 0,
        output: "",
      }),
      event(22, "model.call_started", { turnId: "t2", consumedSteerSeqs: [] }),
    ];
  }

  const tokens = (text: string): number => Math.ceil(text.length / 4);

  test("post-rewind turn: summary overlay rides the request, hidden span sealed (token-count bound)", () => {
    const request = modelRequestFromEvents(rewindJournal(), "t2", 18);
    expect(request.branchCut).toEqual({
      checkpointResultSeq: 6,
      rewindResultSeq: 14,
      summary: SUMMARY,
    });
    // The hidden-span async row's boundary owner would be this call — the
    // cut seals it; the summary is the only pre-boundary survivor.
    expect(request.asyncResults).toEqual([]);

    const body = anthropicRequestBody(request, WIRE_OPTS);
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: `[branch-summary] ${SUMMARY}` },
        { type: "text", text: "continue" },
      ],
    });
    const wire = JSON.stringify(body.messages);
    expect(wire).not.toContain("instrumentation drill");
    expect(wire).not.toContain("Rewind requested.");
    expect(wire).not.toContain("stale pre-boundary completion");
    // Acceptance (token 计数断言): the post-rewind wire request is bounded
    // by overlay + input (+ JSON scaffolding slack) — the KB-scale hidden
    // span (~360 estimated tokens) cannot be inside.
    expect(tokens(wire)).toBeLessThanOrEqual(
      tokens(`[branch-summary] ${SUMMARY}`) + tokens("continue") + 40,
    );
  });

  test("the overlay persists across the turn's calls; prior-call slices stay post-cut", () => {
    const request = modelRequestFromEvents(rewindJournal(), "t2", 22);
    expect(request.branchCut).toEqual({
      checkpointResultSeq: 6,
      rewindResultSeq: 14,
      summary: SUMMARY,
    });
    expect(request.priorCalls).toHaveLength(1);
    expect(request.priorCalls[0]?.modelCallId).toBe(18);
    const body = anthropicRequestBody(request, WIRE_OPTS);
    expect(JSON.stringify(body.messages)).toContain(`[branch-summary] ${SUMMARY}`);
  });

  test("the rewind turn's own calls replay uncut (omp: cut applies at turn end)", () => {
    const log = rewindJournal();
    for (const callId of [3, 7, 11]) {
      expect(modelRequestFromEvents(log, "t1", callId).branchCut).toBeUndefined();
    }
    // By the rewind call, the exploration rides the turn's own prior-call
    // slices — the cut has not consumed anything inside this turn.
    const atExploration = modelRequestFromEvents(log, "t1", 11);
    expect(JSON.stringify(anthropicRequestBody(atExploration, WIRE_OPTS))).toContain(
      "instrumentation drill",
    );
  });

  test("un-terminaled rewind turn (crash window) leaves every projection uncut", () => {
    const log = rewindJournal().filter((e) => e.seq !== 16);
    const request = modelRequestFromEvents(log, "t2", 18);
    expect(request.branchCut).toBeUndefined();
  });

  test("root fallback (null boundary) hides the whole pre-cut span", () => {
    // Strip the checkpoint pair (seqs 3-6): the rewind then has no boundary
    // to point at — omp branchWithSummary(null) branches from the root.
    const log = rewindJournal().filter((e) => e.seq < 3 || e.seq > 6);
    const request = modelRequestFromEvents(log, "t2", 18);
    expect(request.branchCut).toEqual({
      checkpointResultSeq: null,
      rewindResultSeq: 14,
      summary: SUMMARY,
    });
    const wire = JSON.stringify(anthropicRequestBody(request, WIRE_OPTS).messages);
    // Fallback with no kept prefix: no t1 material at all reaches the wire.
    expect(wire).not.toContain("find the leak");
    expect(wire).not.toContain("instrumentation drill");
    expect(tokens(wire)).toBeLessThanOrEqual(
      tokens(`[branch-summary] ${SUMMARY}`) + tokens("continue") + 40,
    );
  });

  test("an armed rewind cut keeps pre-boundary turns out of priorTurns (#228 join)", () => {
    // The cut hides t1 (the checkpoint exploration turn): the session fold
    // must not re-admit pre-boundary turns — the summary replaces them.
    const request = modelRequestFromEvents(rewindJournal(), "t2", 18);
    expect(request.priorTurns).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session-scoped fold (#228): prior turns ride every later request — the
// child reminder-turn repro. omp §1.5: context rebuilds from the whole log.
// ---------------------------------------------------------------------------
describe("translation: session fold across turns (#228)", () => {
  /** t1 = answered task; t2 = reminder-style follow-up. Both terminal. */
  function twoTurnLog(): AnyAgentEvent[] {
    return [
      event(1, "thread.created", { title: "t", machineId: "local" }),
      event(2, "turn.input", {
        turnId: "t1",
        inputId: "i1",
        content: [{ type: "text", text: "Reply with exactly: OK" }],
      }),
      event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
      event(4, "model.call_completed", {
        turnId: "t1",
        modelCallId: 3,
        text: "OK",
        toolCalls: [],
      }),
      event(5, "turn.completed", { turnId: "t1" }),
      event(6, "turn.input", {
        turnId: "t2",
        inputId: "i2",
        content: [{ type: "text", text: "Reminder: submit your final result." }],
      }),
      event(7, "model.call_started", { turnId: "t2", consumedSteerSeqs: [] }),
      event(8, "model.call_completed", {
        turnId: "t2",
        modelCallId: 7,
        text: "OK",
        toolCalls: [],
      }),
      event(9, "turn.completed", { turnId: "t2" }),
    ];
  }

  test("prior turn's input and call history ride the second turn's request", () => {
    const request = modelRequestFromEvents(twoTurnLog(), "t2", 7);
    expect(request.input).toBe("Reminder: submit your final result.");
    expect(request.priorCalls).toHaveLength(0); // t2's own first call IS current
    expect(request.priorTurns).toHaveLength(1);
    const prior = request.priorTurns?.[0];
    expect(prior?.input).toBe("Reply with exactly: OK");
    expect(prior?.calls).toHaveLength(1);
    expect(prior?.calls[0]?.text).toBe("OK");
    expect(prior?.calls[0]?.modelCallId).toBe(3);
  });

  test("wire: prior turn renders input → assistant, roles alternate, task text present", () => {
    const body = anthropicRequestBody(modelRequestFromEvents(twoTurnLog(), "t2", 7), WIRE_OPTS);
    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(body.messages)).toContain("Reply with exactly: OK");
    // The reminder text stays the positionally-last user material.
    const last = body.messages[body.messages.length - 1];
    expect(JSON.stringify(last)).toContain("Reminder: submit your final result.");
  });

  test("replaying an earlier turn's request never sees later turns (future-proof)", () => {
    const request = modelRequestFromEvents(twoTurnLog(), "t1", 3);
    expect(request.input).toBe("Reply with exactly: OK");
    expect(request.priorTurns).toBeUndefined();
    expect(request.priorCalls).toHaveLength(0);
  });
});
