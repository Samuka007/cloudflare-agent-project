import { describe, expect, test, vi, type Mock } from "vitest";
import type { AgentEventDataByType, AgentEventType } from "../src/fsm-events.js";
import { parseAgentEvent, type AnyAgentEvent } from "../src/fsm-events.js";
import { modelRequestFromEvents } from "../src/translate.js";
import {
  BUDGET_FORCED_YIELD_TEXT,
  budgetHardLimit,
  budgetNoticeText,
  childRunVerdict,
  projectChildRun,
  type ChildBudgetPolicy,
} from "../src/tools/task/child-run.js";
import {
  DEFAULT_TASK_TOOL_CONFIG,
  resolveSpawnItems,
  runTaskTool,
  type RunSubagentRequest,
  type TaskToolContext,
} from "../src/tools/task/executor.js";
import type { SpawnPlanRecord, SpawnSettledRecord } from "../src/tools/task/types.js";
import { executionIdFor } from "../src/ids.js";
import { SpawnSemaphore } from "../src/tools/task/semaphore.js";

/**
 * M1.5 T18 tests (proposal §3 T18 L1 + replay-consistency): batch container
 * validation (five rejections + container-model rejection, flat lenient
 * accept), the session-level spawn semaphore (cap, dispatch→settlement
 * permits, in-place resize), and the child-run budget ladder (soft notice →
 * 1.5× hard stop forcing one terminal yield → partial-findings report), all
 * journal-derived so cold-start refolds reach the same verdict.
 */

// ---------------------------------------------------------------------------
// Batch container validation (omp task/index.ts:245-287 verbatim faces)
// ---------------------------------------------------------------------------

describe("T18 — resolveSpawnItems: the five batch rejections + container model", () => {
  const item = { task: "Do X", solutionSpace: "one fix: rename, names given" };

  test("empty tasks array is rejected", () => {
    const result = resolveSpawnItems({ context: "ctx", tasks: [] });
    expect("error" in result && result.error).toContain("non-empty array");
  });

  test("missing context is rejected", () => {
    const result = resolveSpawnItems({ tasks: [item] });
    expect("error" in result && result.error).toContain("requires `context`");
  });

  test("an item missing its task is rejected", () => {
    const result = resolveSpawnItems({ context: "ctx", tasks: [{ solutionSpace: "s" }] });
    expect("error" in result && result.error).toContain("requires a non-empty `task`");
  });

  test("duplicate item names are rejected case-insensitively", () => {
    const result = resolveSpawnItems({
      context: "ctx",
      tasks: [{ ...item, name: "Scout" }, { ...item, name: "SCOUT" }],
    });
    expect("error" in result && result.error).toContain('duplicate tasks[] item name "SCOUT"');
  });

  test("top-level task coexisting with tasks is rejected", () => {
    const result = resolveSpawnItems({ task: "flat", context: "ctx", tasks: [item] });
    expect("error" in result && result.error).toContain("mutually exclusive");
  });

  test("a model on the batch container is rejected — per-item only", () => {
    const result = resolveSpawnItems({ context: "ctx", tasks: [item], model: "m" });
    expect("error" in result && result.error).toContain("batch container is rejected");
  });

  test("a valid batch normalizes per-item fields", () => {
    const result = resolveSpawnItems({
      context: "shared",
      tasks: [
        { ...item, name: "Scout", model: "m1", schemaMode: "strict" },
        { ...item, agent: "task" },
      ],
    });
    expect("items" in result && result.items).toEqual([
      { name: "Scout", task: "Do X", solutionSpace: "one fix: rename, names given", model: "m1", schemaMode: "strict" },
      { agent: "task", task: "Do X", solutionSpace: "one fix: rename, names given" },
    ]);
  });

  test("the flat form stays accepted (omp lenientArgValidation)", () => {
    const result = resolveSpawnItems({ ...item, name: "Solo" });
    expect("items" in result && result.items).toEqual([
      { name: "Solo", task: "Do X", solutionSpace: "one fix: rename, names given" },
    ]);
    const noTask = resolveSpawnItems({ solutionSpace: "s" });
    expect("error" in noTask && noTask.error).toContain("`task` must be a non-empty");
    const noSpace = resolveSpawnItems({ task: "t" });
    expect("error" in noSpace && noSpace.error).toContain("`solutionSpace`");
  });
});

// ---------------------------------------------------------------------------
// Batch dispatch through the executor (journal-first per item)
// ---------------------------------------------------------------------------

interface FakeContext {
  context: TaskToolContext;
  events: AnyAgentEvent[];
  runRequests: RunSubagentRequest[];
  releases: Map<string, () => void>;
  recordSpawnPlan: Mock;
  recordSpawnSettlement: Mock;
}

function fakeContext(overrides: {
  executionId?: string;
  depth?: number;
  maxConcurrency?: number;
  holdDispatches?: Promise<void>;
} = {}): FakeContext {
  const events: AnyAgentEvent[] = [];
  const runRequests: RunSubagentRequest[] = [];
  const releases = new Map<string, () => void>();
  const config = {
    ...DEFAULT_TASK_TOOL_CONFIG,
    maxConcurrency: overrides.maxConcurrency ?? DEFAULT_TASK_TOOL_CONFIG.maxConcurrency,
  };
  const semaphore = new SpawnSemaphore(config.maxConcurrency);
  let seq = 0;
  const recordSpawnPlan = vi.fn((plan: SpawnPlanRecord) => {
    // Mirror the DO wrapper: the raw outputSchema JSON-encodes onto the row.
    const { outputSchema, ...rest } = plan;
    events.push(
      parseAgentEvent({
        id: `e${++seq}`,
        threadId: "th-p",
        seq,
        type: "task.spawn_planned",
        data: {
          ...rest,
          ...(outputSchema === undefined
            ? {}
            : { outputSchemaJson: JSON.stringify(outputSchema) }),
        },
        createdAt: 0,
      }),
    );
    return Promise.resolve();
  });
  const recordSpawnSettlement = vi.fn((settlement: SpawnSettledRecord) => {
    const { seq: _seq, ...data } = settlement;
    events.push(
      parseAgentEvent({
        id: `e${++seq}`,
        threadId: "th-p",
        seq,
        type: "task.spawn_settled",
        data,
        createdAt: 0,
      }),
    );
    // The DO contract: the settlement sink releases the dispatch→settlement
    // permit (agent-do.ts recordSpawnSettlement / taskSpawnSink).
    releases.get(settlement.spawnId)?.();
    return Promise.resolve();
  });
  const context: TaskToolContext = {
    executionId: overrides.executionId ?? "th-p:9",
    turnId: "t1",
    threadId: "th-p",
    machineId: "th-p",
    depth: overrides.depth ?? 0,
    parentAgentId: undefined,
    events: () => Promise.resolve(events),
    recordSpawnPlan,
    recordSpawnSettlement,
    registry: {
      register: () => Promise.resolve(),
      settle: () => Promise.resolve(),
    },
    subagentHost: {
      createThread: (request) =>
        Promise.resolve({ threadId: request.threadId, duplicated: false }),
      runSubagent: (request) => {
        runRequests.push(request);
        return (overrides.holdDispatches ?? Promise.resolve()).then(() => ({
          turnId: "t-child",
          duplicated: false,
        }));
      },
    },
    wake: () => Promise.resolve("cancelled" as const),
    isolationOp: undefined,
    semaphore,
    trackSpawnRelease: (spawnId, release) => {
      releases.set(spawnId, release);
    },
    config,
  };
  return { context, events, runRequests, releases, recordSpawnPlan, recordSpawnSettlement };
}

describe("T18 — batch dispatch: one call → N journaled spawns", () => {
  test("per-item plans carry #index executionIds and the shared context", async () => {
    const fake = fakeContext();
    const result = await runTaskTool(
      {
        context: "Shared interfaces: names given per item.",
        tasks: [
          { name: "Alpha", task: "Do A", solutionSpace: "one fix: names given" },
          { task: "Do B", solutionSpace: "open" },
        ],
      },
      fake.context,
    );
    expect(result.status).toBe("ok");
    // Two plans, per-item executionIds, both carrying the batch context.
    const executions = fake.events
      .map((event) => (event.type === "task.spawn_planned" ? event.data : undefined))
      .filter((data) => data !== undefined)
      .map((data) => ({ executionId: data.executionId, context: data.context, agentId: data.agentId }));
    expect(executions).toEqual([
      { executionId: "th-p:9#0", context: "Shared interfaces: names given per item.", agentId: "Alpha" },
      { executionId: "th-p:9#1", context: "Shared interfaces: names given per item.", agentId: "Task-2" },
    ]);
    // The child drive requests render the context into the assignment.
    expect(fake.runRequests).toHaveLength(2);
    expect(fake.runRequests[0]?.context).toContain("Shared interfaces");
    expect(fake.runRequests[1]?.context).toContain("Shared interfaces");
    // Unnamed items auto-allocate against the growing plan projection.
    expect(fake.runRequests[1]?.agentId).toBe("Task-2");
  });

  test("a container-model rejection fails the call before any journal write", async () => {
    const fake = fakeContext();
    const result = await runTaskTool(
      {
        context: "ctx",
        tasks: [{ task: "Do A", solutionSpace: "s" }],
        model: "m",
      },
      fake.context,
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("batch container is rejected");
    expect(fake.recordSpawnPlan).not.toHaveBeenCalled();
    expect(fake.runRequests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Session semaphore: cap, dispatch→settlement permits, in-place resize
// ---------------------------------------------------------------------------

describe("T18 — spawn semaphore: one permit per SpawnRun, in-place resize", () => {
  const batch = (n: number) => ({
    context: "ctx",
    tasks: Array.from({ length: n }, (_unused, index) => ({
      task: `Do ${index}`,
      solutionSpace: "open",
    })),
  });

  test("cap 1 serializes dispatches until each run settles", async () => {
    const fake = fakeContext({ maxConcurrency: 1 });
    const running = runTaskTool(batch(2), fake.context);
    // Yield to the executor loop: item 0 dispatched, item 1 queued on the
    // permit (settlement releases it — none has landed yet).
    await vi.waitFor(() => {
      expect(fake.runRequests).toHaveLength(1);
    });
    expect(fake.context.semaphore.inFlight()).toBe(1);
    // The DO-side settlement of run 0 frees the slot → run 1 dispatches.
    const plan = fake.events.find(
      (event): event is Extract<AnyAgentEvent, { type: "task.spawn_planned" }> =>
        event.type === "task.spawn_planned",
    );
    expect(plan).toBeDefined();
    if (plan === undefined) return;
    // completeSubagent's settlement sink (journal row + permit release).
    await fake.context.recordSpawnSettlement({
      spawnId: plan.data.spawnId,
      jobId: plan.data.jobId,
      agentId: plan.data.agentId,
      childThreadId: plan.data.childThreadId,
      status: "ok",
      output: "Background task done.",
    });
    await running;
    expect(fake.runRequests).toHaveLength(2);
    // Run 1's permit is still held (its settlement hasn't landed).
    expect(fake.context.semaphore.inFlight()).toBe(1);
    const second = fake.events.filter(
      (event): event is Extract<AnyAgentEvent, { type: "task.spawn_planned" }> =>
        event.type === "task.spawn_planned",
    )[1];
    expect(second).toBeDefined();
    if (second === undefined) return;
    await fake.context.recordSpawnSettlement({
      spawnId: second.data.spawnId,
      jobId: second.data.jobId,
      agentId: second.data.agentId,
      childThreadId: second.data.childThreadId,
      status: "ok",
      output: "Background task done.",
    });
    expect(fake.context.semaphore.inFlight()).toBe(0);
  });

  test("in-place resize unblocks queued spawns without a settlement", async () => {
    const fake = fakeContext({ maxConcurrency: 1 });
    const running = runTaskTool(batch(2), fake.context);
    await vi.waitFor(() => {
      expect(fake.runRequests).toHaveLength(1);
    });
    // omp task/index.ts:639-643: acquire-time cap reads — raising the cap
    // mid-flight admits the queued spawn immediately.
    fake.context.semaphore.resize(2);
    await running;
    expect(fake.runRequests).toHaveLength(2);
    expect(fake.context.semaphore.inFlight()).toBe(2);
  });

  test("maxConcurrency 0 is unlimited", async () => {
    const fake = fakeContext({ maxConcurrency: 0 });
    await runTaskTool(batch(3), fake.context);
    expect(fake.runRequests).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Child-run budget ladder (task semantics §4.1) — replay-pure fold
// ---------------------------------------------------------------------------

const THREAD = "th-child";

interface JournalBuilder {
  add<TType extends AgentEventType>(
    type: TType,
    data: AgentEventDataByType[TType],
    createdAt?: number,
  ): AnyAgentEvent;
  log: AnyAgentEvent[];
}

function createJournal(): JournalBuilder {
  const log: AnyAgentEvent[] = [];
  let seq = 0;
  return {
    add(type, data, createdAt = 0) {
      const event = parseAgentEvent({
        id: `e${++seq}`,
        threadId: THREAD,
        seq,
        type,
        data,
        createdAt,
      });
      log.push(event);
      return event;
    },
    log,
  };
}

function addIdentity(journal: JournalBuilder, createdAt = 0): void {
  journal.add(
    "task.subagent_identity",
    {
      spawnId: "sp-1",
      agentId: "Task-1",
      parentThreadId: "th-parent",
      sourceThreadId: null,
      originKind: null,
      depth: 1,
    },
    createdAt,
  );
}

function addCalls(journal: JournalBuilder, count: number): void {
  for (let index = 0; index < count; index++) {
    journal.add("model.call_started", { turnId: "t1", consumedSteerSeqs: [] });
  }
}

/** Assignment turn: input + completed (no usable yield inside). */
function addAssignmentTurn(journal: JournalBuilder, inputId = "i1"): void {
  journal.add("turn.input", {
    turnId: `t-${inputId}`,
    inputId,
    content: [{ type: "text", text: "assignment" }],
  });
  journal.add("turn.completed", { turnId: `t-${inputId}` });
}

const SOFT = 4;

function policy(overrides: Partial<ChildBudgetPolicy> = {}): ChildBudgetPolicy {
  return { softRequestBudget: SOFT, maxRuntimeMs: 0, now: 0, ...overrides };
}

describe("T18 — budget ladder: notice → hard stop → partial findings", () => {
  test("the hard limit is ceil(1.5 × soft)", () => {
    expect(budgetHardLimit(200)).toBe(300);
    expect(budgetHardLimit(1)).toBe(2);
    expect(budgetNoticeText(200, 300)).toContain("200");
  });

  test("crossing the soft cap notices once; the journaled row keeps it idempotent", () => {
    const journal = createJournal();
    addIdentity(journal);
    addAssignmentTurn(journal);
    addCalls(journal, SOFT);
    const state = projectChildRun(journal.log);
    const first = childRunVerdict(state, policy());
    expect(first).toMatchObject({ kind: "notice" });
    if (first.kind !== "notice") return;
    expect(first.text).toContain("yield");

    // Replay: after the notice row lands, the same fold never re-notices.
    journal.add("task.budget_notice", { inputId: "budget-notice-1" });
    const replay = childRunVerdict(projectChildRun(journal.log), policy());
    expect(replay).toMatchObject({ kind: "remind", reason: "ladder" });
  });

  test("crossing the hard stop forces ONE budget yield attempt, then settles partial findings", () => {
    const journal = createJournal();
    addIdentity(journal);
    addAssignmentTurn(journal);
    addCalls(journal, budgetHardLimit(SOFT));
    journal.add("model.call_completed", {
      turnId: "t1",
      modelCallId: 1,
      text: "partial analysis so far",
      toolCalls: [],
    });
    const state = projectChildRun(journal.log);

    const armed = childRunVerdict(state, policy());
    expect(armed).toEqual({
      kind: "remind",
      text: BUDGET_FORCED_YIELD_TEXT,
      forced: true,
      reason: "budget",
    });

    // Replay determinism: the same journal folds to the same verdict.
    expect(childRunVerdict(projectChildRun(journal.log), policy())).toEqual(armed);

    // The forced attempt ended (turn terminal, still no usable yield):
    // the compressed ladder settles partial findings as the formal report.
    journal.add("task.yield_reminder", {
      inputId: "i1",
      forced: true,
      reason: "budget",
    });
    journal.add("turn.input", {
      turnId: "t-forced",
      inputId: "i-forced",
      content: [{ type: "text", text: "forced" }],
    });
    journal.add("turn.completed", { turnId: "t-forced" });
    const settled = childRunVerdict(projectChildRun(journal.log), policy());
    expect(settled).toMatchObject({ kind: "settle", status: "ok" });
    if (settled.kind !== "settle") return;
    expect(settled.output).toContain("[budget stop]");
    expect(settled.output).toContain("partial analysis so far");
  });

  test("a usable terminal yield wins the race against the budget", () => {
    const journal = createJournal();
    addIdentity(journal);
    addAssignmentTurn(journal);
    addCalls(journal, budgetHardLimit(SOFT) + 10);
    const yieldCall = journal.add("tool.call", {
      turnId: "t1",
      modelCallId: 1,
      tool: "yield",
      arguments: { data: { done: true } },
      timeoutMs: 30_000,
    });
    journal.add("tool.result", {
      turnId: "t1",
      executionId: executionIdFor(THREAD, yieldCall.seq),
      status: "ok",
      exitCode: null,
      output: "ok",
    });
    const state = projectChildRun(journal.log);
    const verdict = childRunVerdict(state, policy());
    expect(verdict).toMatchObject({ kind: "settle", status: "ok" });
    if (verdict.kind !== "settle") return;
    expect(verdict.output).not.toContain("[budget stop]");
    expect(verdict.output).toContain("done");
  });

  test("the wall clock (maxRuntimeMs > 0) trips the hard tier from the identity timestamp", () => {
    const journal = createJournal();
    addIdentity(journal, 1000);
    addAssignmentTurn(journal);
    addCalls(journal, 1);
    const verdict = childRunVerdict(projectChildRun(journal.log), {
      softRequestBudget: 0,
      maxRuntimeMs: 500,
      now: 2000,
    });
    expect(verdict).toMatchObject({ kind: "remind", reason: "budget", forced: true });
    // Inside the window: normal ladder (no usable yield yet → first reminder).
    const inside = childRunVerdict(projectChildRun(journal.log), {
      softRequestBudget: 0,
      maxRuntimeMs: 5000,
      now: 2000,
    });
    expect(inside).toMatchObject({ kind: "remind", reason: "ladder" });
  });
});

describe("T18 — translate: the budget-forced marker pins toolChoice", () => {
  test("reason=budget reminder bound to the turn input pins yield", () => {
    const journal = createJournal();
    journal.add("turn.input", {
      turnId: "t1",
      inputId: "i1",
      content: [{ type: "text", text: "assignment" }],
    });
    const call = journal.add("model.call_started", { turnId: "t1", consumedSteerSeqs: [] });
    journal.add("task.yield_reminder", {
      inputId: "i1",
      forced: true,
      reason: "budget",
    });
    const request = modelRequestFromEvents(journal.log, "t1", call.seq);
    expect(request.toolChoice).toEqual({ name: "yield" });
  });
});
