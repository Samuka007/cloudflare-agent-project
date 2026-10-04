import { describe, expect, test, vi, type Mock } from "vitest";
import type { AgentEventDataByType, AgentEventType } from "../src/fsm-events.js";
import { parseAgentEvent, type AnyAgentEvent } from "../src/fsm-events.js";
import { modelRequestFromEvents } from "../src/translate.js";
import { MAIN_WIRE_TOOLS, subagentWireTools } from "../src/tools/registry.js";
import {
  runTaskTool,
  DEFAULT_TASK_TOOL_CONFIG,
  type TaskToolContext,
} from "../src/tools/task/executor.js";
import { SpawnSemaphore } from "../src/tools/task/semaphore.js";
import {
  canSpawnAtDepth,
  BUNDLED_AGENT_DEFINITIONS,
  INLINE_SUMMARY_CAP_CHARS,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  resolveExecutionMode,
  type SpawnPlanRecord,
} from "../src/tools/task/types.js";
import {
  boundaryOwnerSeqs,
  childAssignment,
  defaultAgentName,
  inlineSummary,
  nestAgentId,
  renderAsyncResultText,
  takenAgentNames,
  truncateDeliveryOutput,
  uniquifyAgentName,
} from "../src/tools/task/plan.js";

/**
 * M1.5 T16 pure-surface tests (proposal §3 T16 L1/L2 unit layer): spawn
 * planning (omp AgentOutputManager + per-item mode), delivery caps, depth
 * policy, wire surfaces, the async-result boundary projection and the
 * executionId re-adopt rule — all replay-pure, no DO required.
 */

describe("M1.5 T16 — depth policy and per-item execution mode", () => {
  test("canSpawnAtDepth mirrors omp task/types.ts:222-224 verbatim", () => {
    expect(canSpawnAtDepth(2, 0)).toBe(true);
    expect(canSpawnAtDepth(2, 1)).toBe(true);
    expect(canSpawnAtDepth(2, 2)).toBe(false);
    expect(canSpawnAtDepth(0, 0)).toBe(false);
    // maxRecursionDepth < 0 disables the cap entirely.
    expect(canSpawnAtDepth(-1, 99)).toBe(true);
  });

  test("resolveExecutionMode follows the omp per-item rule (blocking agent / async flag)", () => {
    const blocking = { name: "scout", blocking: true };
    const plain = { name: "task", blocking: false };
    expect(resolveExecutionMode(blocking, true)).toBe("blocking");
    expect(resolveExecutionMode(blocking, false)).toBe("blocking");
    // omp: async.enabled default on → background job; off → inline sync.
    expect(resolveExecutionMode(plain, true)).toBe("background");
    expect(resolveExecutionMode(plain, false)).toBe("blocking");
    expect(resolveExecutionMode(undefined, true)).toBe("background");
    // The bundled default agent is non-blocking (omp builtins declare none).
    expect(BUNDLED_AGENT_DEFINITIONS[0]?.blocking).toBe(false);
  });
});

describe("M1.5 T16 — agent-id allocation (omp AgentOutputManager rules)", () => {
  test("first allocation keeps the name; repeats get -2, -3 (case-insensitive)", () => {
    expect(uniquifyAgentName("Scout", takenAgentNames([]))).toBe("Scout");
    expect(uniquifyAgentName("Scout", takenAgentNames([plan("Task-1", "scout")]))).toBe("Scout-2");
    expect(
      uniquifyAgentName(
        "Scout",
        takenAgentNames([plan("Task-1", "scout"), plan("Task-2", "Scout-2")]),
      ),
    ).toBe("Scout-3");
  });

  test("taken names fold to first segments — a dot marks a nested child", () => {
    const taken = takenAgentNames([plan("Task-1", "Main.Scout"), plan("Task-2", "Task-9")]);
    expect(taken.has("main")).toBe(true);
    // omp output-manager.ts:57-63: the scan owns only the FIRST segment —
    // "Main.Scout" reserves "Main" in the Main scope; "Scout" belongs to the
    // child's own prefixed scope.
    expect(taken.has("scout")).toBe(false);
    expect(taken.has("task-9")).toBe(true);
    expect(taken.has("main.scout")).toBe(false);
  });

  test("default names derive from journal count; nesting prefixes the parent id", () => {
    expect(defaultAgentName([])).toBe("Task-1");
    expect(defaultAgentName([plan("s1", "Task-1"), plan("s2", "Task-2")])).toBe("Task-3");
    expect(nestAgentId(undefined, "Scout")).toBe("Scout");
    expect(nestAgentId("Main", "Scout")).toBe("Main.Scout");
  });
});

describe("M1.5 T16 — delivery caps (omp PI_TASK_MAX_OUTPUT_* + result-summary)", () => {
  test("outputs under both caps pass through untouched", () => {
    const out = "line1\nline2";
    expect(
      truncateDeliveryOutput(out, {
        maxOutputBytes: MAX_OUTPUT_BYTES,
        maxOutputLines: MAX_OUTPUT_LINES,
      }),
    ).toEqual({
      text: out,
      truncated: false,
    });
  });

  test("line cap truncates and flags; byte cap cuts mid-UTF-8 safely", () => {
    const manyLines = Array.from({ length: MAX_OUTPUT_LINES + 10 }, (_, i) => `l${i}`).join("\n");
    const lineCapped = truncateDeliveryOutput(manyLines, {
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxOutputLines: MAX_OUTPUT_LINES,
    });
    expect(lineCapped.truncated).toBe(true);
    expect(lineCapped.text.split("\n")).toHaveLength(MAX_OUTPUT_LINES);

    const huge = "完".repeat(600_000);
    const byteCapped = truncateDeliveryOutput(huge, {
      maxOutputBytes: 1000,
      maxOutputLines: MAX_OUTPUT_LINES,
    });
    expect(byteCapped.truncated).toBe(true);
    // subarray cuts mid-codepoint; TextDecoder replaces with at most one
    // U+FFFD (3 bytes) — the re-encoded text stays within cap + replacement.
    expect(new TextEncoder().encode(byteCapped.text).byteLength).toBeLessThanOrEqual(1003);
  });

  test("inline summary forces the agent:// pointer past the 5000-char threshold", () => {
    const small = "short";
    expect(inlineSummary("Scout", small, INLINE_SUMMARY_CAP_CHARS)).toBe(small);
    const big = "x".repeat(INLINE_SUMMARY_CAP_CHARS + 100);
    const summary = inlineSummary("Scout", big, INLINE_SUMMARY_CAP_CHARS);
    expect(summary.startsWith("x".repeat(INLINE_SUMMARY_CAP_CHARS))).toBe(true);
    expect(summary).toContain("agent://Scout");
  });

  test("async-result delivery text carries the omp status prefixes", () => {
    expect(renderAsyncResultText("Scout", "ok", "done")).toBe(
      "Background task Scout complete.\n\ndone",
    );
    expect(renderAsyncResultText("Scout", "error", "boom")).toBe(
      "Background task Scout failed.\n\nboom",
    );
  });
});

describe("M1.5 T16 — wire surfaces", () => {
  test("main surface carries task, never the hidden yield; subagent surface is the inverse plus cap", () => {
    expect(MAIN_WIRE_TOOLS).toContain("task");
    expect(MAIN_WIRE_TOOLS).not.toContain("yield");
    const full = subagentWireTools(false);
    expect(full).toContain("task");
    expect(full).toContain("yield");
    // Past the depth cap the tool is stripped (omp canSpawnAtDepth gate);
    // the hidden yield stays — the child still needs it to finish.
    const capped = subagentWireTools(true);
    expect(capped).not.toContain("task");
    expect(capped).toContain("yield");
  });

  test("child assignment prompt is the omp subagent-user-prompt template", () => {
    expect(childAssignment("Do the thing")).toBe("Complete assignment thoroughly:\n\nDo the thing");
  });
});

describe("M1.5 T16 — async-result boundary projection (translate)", () => {
  const THREAD = "th-task";

  function event<TType extends AgentEventType>(
    seq: number,
    type: TType,
    data: AgentEventDataByType[TType],
  ): AnyAgentEvent {
    return parseAgentEvent({ id: `e${seq}`, threadId: THREAD, seq, type, data, createdAt: 0 });
  }

  test("a background completion rides the first call boundary after it, once", () => {
    const log: AnyAgentEvent[] = [
      event(1, "thread.created", { title: "t", machineId: "local" }),
      event(2, "turn.input", {
        turnId: "t1",
        inputId: "i1",
        content: [{ type: "text", text: "go" }],
      }),
      event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
      event(4, "model.call_completed", {
        turnId: "t1",
        modelCallId: 3,
        text: "spawning",
        toolCalls: [],
      }),
      event(5, "turn.completed", { turnId: "t1" }),
      // Between turns: the background result lands.
      event(6, "task.async_result", {
        spawnId: "thr-x",
        agentId: "Task-1",
        jobId: "job-1",
        status: "ok",
        output: "done work",
      }),
      event(7, "turn.input", {
        turnId: "t2",
        inputId: "i2",
        content: [{ type: "text", text: "next" }],
      }),
      event(8, "model.call_started", { turnId: "t2", consumedSteerSeqs: [] }),
      event(9, "model.call_completed", {
        turnId: "t2",
        modelCallId: 8,
        text: "ack",
        toolCalls: [],
      }),
      event(10, "turn.completed", { turnId: "t2" }),
      event(11, "turn.input", {
        turnId: "t3",
        inputId: "i3",
        content: [{ type: "text", text: "more" }],
      }),
      event(12, "model.call_started", { turnId: "t3", consumedSteerSeqs: [] }),
      event(13, "model.call_completed", {
        turnId: "t3",
        modelCallId: 12,
        text: "again",
        toolCalls: [],
      }),
      event(14, "turn.completed", { turnId: "t3" }),
    ];
    const request = modelRequestFromEvents(log, "t2", 8);
    // The result rode call 8's boundary (first call after seq 6) — the
    // CURRENT call's trailing injection (wire appends it to the last user
    // message before call 8's response).
    expect(request.asyncResults).toHaveLength(1);
    expect(request.asyncResults[0]?.text).toBe("Background task Task-1 complete.\n\ndone work");
    expect(request.asyncResults[0]?.spawnId).toBe("thr-x");
    // Replay of the EARLIER call must NOT see a future boundary row…
    const earlier = modelRequestFromEvents(log, "t1", 3);
    expect(earlier.asyncResults).toEqual([]);
    expect(earlier.priorCalls).toHaveLength(0); // call 3 IS the first call
    // …and the row never RE-INJECTS: turn t3's request (the projection is
    // turn-scoped — prior turns' calls are invisible, exactly like the prior
    // turns' own text) carries nothing on its trailing boundary.
    const later = modelRequestFromEvents(log, "t3", 12);
    expect(later.asyncResults).toEqual([]);
    expect(later.priorCalls).toHaveLength(0);
  });

  test("boundaryOwnerSeqs attributes to the FIRST call start after the row (-1 = pending)", () => {
    // Never re-enters the call that spawned the job (seq ≤ row).
    expect(boundaryOwnerSeqs([3, 10], 6)).toBe(10);
    expect(boundaryOwnerSeqs([3, 10], 2)).toBe(3);
    expect(boundaryOwnerSeqs([3, 10], 10)).toBe(-1);
    expect(boundaryOwnerSeqs([], 6)).toBe(-1);
  });
});

describe("M1.5 T16 — executionId re-adopt (recovery, never a second spawn)", () => {
  interface FakeContext {
    context: TaskToolContext;
    recordSpawnPlan: Mock;
    registryRegister: Mock;
  }

  function fakeContext(overrides: { events: AnyAgentEvent[]; depth?: number }): FakeContext {
    const recordSpawnPlan = vi.fn(() => Promise.resolve());
    const registryRegister = vi.fn(() => Promise.resolve());
    const recordSpawnSettlement = vi.fn(() => Promise.resolve());
    const registrySettle = vi.fn(() => Promise.resolve());
    const context: TaskToolContext = {
      executionId: "th-p:5",
      turnId: "t1",
      threadId: "th-p",
      machineId: "th-p",
      depth: overrides.depth ?? 0,
      parentAgentId: undefined,
      events: () => Promise.resolve(overrides.events),
      recordSpawnPlan,
      recordSpawnSettlement,
      registry: {
        register: registryRegister,
        settle: registrySettle,
      },
      subagentHost: {
        createThread: (request) => Promise.resolve({ threadId: request.threadId, duplicated: false }),
        runSubagent: () => Promise.resolve({ turnId: "t-child", duplicated: false }),
      },
      isolationOp: undefined,
      wake: () => Promise.resolve("cancelled" as const),
      semaphore: new SpawnSemaphore(DEFAULT_TASK_TOOL_CONFIG.maxConcurrency),
      trackSpawnRelease: () => undefined,
      config: DEFAULT_TASK_TOOL_CONFIG,
    };
    return { context, recordSpawnPlan, registryRegister };
  }

  function spawnPlanEvent(
    seq: number,
    over: Partial<AgentEventDataByType["task.spawn_planned"]> = {},
  ): AnyAgentEvent {
    return parseAgentEvent({
      id: `e${seq}`,
      threadId: "th-p",
      seq,
      type: "task.spawn_planned",
      data: {
        executionId: "th-p:5",
        spawnId: "thr-child",
        agentId: "Task-1",
        agent: "task",
        childThreadId: "thr-child",
        parentThreadId: "th-p",
        machineId: "th-p",
        mode: "background",
        jobId: "job-1",
        task: "Do X",
        solutionSpace: "one fix: rename, names given",
        depth: 1,
        ...over,
      },
      createdAt: 0,
    });
  }

  function settlementEvent(seq: number): AnyAgentEvent {
    return parseAgentEvent({
      id: `e${seq}`,
      threadId: "th-p",
      seq,
      type: "task.spawn_settled",
      data: {
        spawnId: "thr-child",
        jobId: "job-1",
        agentId: "Task-1",
        childThreadId: "thr-child",
        status: "ok",
        output: "Background task Task-1 complete.\n\nDone",
      },
      createdAt: 0,
    });
  }

  test("a settled plan answers from the journal — no plan append, no host call", async () => {
    const { context, recordSpawnPlan, registryRegister } = fakeContext({
      events: [spawnPlanEvent(20), settlementEvent(21)],
    });
    const result = await runTaskTool(
      { task: "Do X", solutionSpace: "one fix: rename, names given" },
      context,
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain("Task-1");
    expect(result.output).toContain("Done");
    expect(recordSpawnPlan).not.toHaveBeenCalled();
    expect(registryRegister).not.toHaveBeenCalled();
  });

  test("an unsettled background plan replays the registration receipt only", async () => {
    const { context, recordSpawnPlan, registryRegister } = fakeContext({ events: [spawnPlanEvent(20)] });
    const result = await runTaskTool(
      { task: "Do X", solutionSpace: "one fix: rename, names given" },
      context,
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain("agent://Task-1");
    expect(recordSpawnPlan).not.toHaveBeenCalled();
    expect(registryRegister).not.toHaveBeenCalled();
  });

  test("spawn past the depth cap is refused without journal access", async () => {
    const { context, recordSpawnPlan } = fakeContext({
      events: [],
      depth: DEFAULT_TASK_TOOL_CONFIG.maxRecursionDepth,
    });
    const result = await runTaskTool(
      { task: "Do X", solutionSpace: "one fix: rename, names given" },
      context,
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("task.maxRecursionDepth");
    expect(recordSpawnPlan).not.toHaveBeenCalled();
  });

  test("empty required strings are rejected beyond the schema", async () => {
    const { context } = fakeContext({ events: [] });
    const noTask = await runTaskTool({ task: "  ", solutionSpace: "open" }, context);
    expect(noTask.status).toBe("error");
    const noSpace = await runTaskTool({ task: "Do X", solutionSpace: " " }, context);
    expect(noSpace.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function plan(spawnId: string, agentId: string): SpawnPlanRecord {
  return {
    seq: 0,
    executionId: `${spawnId}:1`,
    spawnId,
    agentId,
    agent: "task",
    childThreadId: spawnId,
    parentThreadId: "th-p",
    machineId: "th-p",
    mode: "background",
    jobId: null,
    task: "t",
    solutionSpace: "s",
    depth: 1,
  };
}
