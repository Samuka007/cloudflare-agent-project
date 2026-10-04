import { afterEach, describe, expect, test } from "vitest";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { createRig, resetRuntime } from "./helpers.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import { M0_RENDER_FLAGS, TOOL_REGISTRY, toolRegistryRow, wireToolSet } from "../src/tools/registry.js";
import { runEdgeTool, type EdgeToolContext } from "../src/tools/edge.js";
import {
  TODO_PHASES_ENTRY_TYPE,
  activeBranchAfterRewind,
  checkpointRewindState,
  latestTodoPhases,
  todoJournalState,
} from "../src/tools/session-tree.js";
import { applyParams, clonePhases, formatSummary, resolveTodoParams, type TodoPhase } from "../src/tools/todo-state.js";

afterEach(() => {
  resetRuntime();
});

// ---------------------------------------------------------------------------
// omp-verbatim fixtures (prompts/tools/*.md + tools/checkpoint.ts text)
// ---------------------------------------------------------------------------

// omp prompts/tools/checkpoint.md (prompt.render trims the trailing newline —
// T1 bash/context_notes precedent).
const CHECKPOINT_DESCRIPTION = [
  "Context checkpoint: before exploratory work; later `rewind`, retaining only concise report.",
  "",
  "Use for investigations with many intermediate tool calls (`read`/`grep`/`glob`/`lsp`/etc.) to minimize subsequent context cost.",
  "",
  "Rules:",
  "- MUST `rewind` before yielding after starting a checkpoint.",
  "- NEVER `checkpoint` while another checkpoint active.",
  "- Subagents: disabled by default. Enable: agent-definition `tools:` frontmatter lists `checkpoint` or `rewind`; sister tool auto-included; requires `checkpoint.enabled` setting.",
  "",
  "Typical flow:",
  "1. `checkpoint(goal: …)`",
  "2. Exploratory work",
  "3. `rewind(report: …)` with concise findings",
  "",
  "After `rewind`: intermediate checkpoint messages removed from active context; replaced by report.",
].join("\n");

// omp prompts/tools/rewind.md
const REWIND_DESCRIPTION =
  "End the active checkpoint; rewind context to it, replacing intermediate exploration with your report.";

// omp prompts/tools/todo.md — five single-line paragraphs.
const TODO_DESCRIPTION = [
  "Tasks identified by verbatim content, NEVER generated IDs (task-1). Unique, stable task/phase names; lost text: view, NEVER guess.",
  "Before work, init for 3+ steps, requested task sets, or new instructions. MUST list EVERY user item separately (phased/numbered/bulleted/N); NEVER omit or remember leftovers.",
  "After successful mutation: no active means earliest pending starts (phase order); multiple active means only earliest stays. Blocked NEVER starts automatically; unblock returns pending. Done out of order may rewind pointer but NEVER reopen completed. Mark done immediately; follow phase order.",
  "External waits (user/agent/service): block with optional reason suppresses stop reminder, starts next pending. Unblock when actionable; append a clearing task for agent-actionable blocker.",
  "NEVER call todo alone: init with first work; done/start with next action.",
].join("\n");

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

function callsOf(events: readonly AnyAgentEvent[], tool: string): AnyAgentEvent[] {
  return events.filter((event) => event.type === "tool.call" && event.data.tool === tool);
}

function resultsOf(events: readonly AnyAgentEvent[], tool: string): AnyAgentEvent[] {
  const executionIds = new Set(callsOf(events, tool).map((call) => executionIdFor(call.threadId, call.seq)));
  return events.filter((event) => event.type === "tool.result" && executionIds.has(event.data.executionId));
}

function requireResult(
  events: readonly AnyAgentEvent[],
  tool: string,
  index = 0,
): { seq: number; data: { status: string; output: string } } {
  const result = resultsOf(events, tool)[index];
  if (result?.type !== "tool.result") {
    throw new Error(`no tool.result #${index} for ${tool}`);
  }
  // These fixtures never spill to blobs; stringify the union honestly.
  const output = typeof result.data.output === "string" ? result.data.output : "";
  return { seq: result.seq, data: { status: result.data.status, output } };
}

function todoEntries(events: readonly AnyAgentEvent[]): AnyAgentEvent[] {
  return events.filter((event) => event.type === TODO_PHASES_ENTRY_TYPE);
}

// ---------------------------------------------------------------------------
// Pure state machine — omp docs/tools/todo.md §States/§Errors exhaustively
// (practice 9: the op-dispatch state machine gets a closed-table proof)
// ---------------------------------------------------------------------------

/** One task per status, phase-targeted ops hit all five at once. */
function fiveStatusPhases(): TodoPhase[] {
  return [
    {
      name: "P",
      tasks: [
        { content: "p-task", status: "pending" },
        { content: "ip-task", status: "in_progress" },
        { content: "b-task", status: "blocked", blocker: "waiting" },
        { content: "c-task", status: "completed" },
        { content: "a-task", status: "abandoned" },
      ],
    },
  ];
}

function statusesAfter(op: Parameters<typeof applyParams>[1]): Map<string, string> {
  const { phases } = applyParams(fiveStatusPhases(), op);
  return new Map(firstPhase(phases).tasks.map((task) => [task.content, task.status]));
}

/** First phase of an applyParams result — every fixture phase array is non-empty by construction. */
function firstPhase(phases: TodoPhase[]): TodoPhase {
  const phase = phases[0];
  if (phase === undefined) throw new Error("fixture phase vanished");
  return phase;
}

describe("M1.5 T3 — todo op state machine (T:todo.ts verbatim, practice 9)", () => {
  test("status transition matrix matches omp docs §States", () => {
    // `done` completes any status; `drop` abandons any status.
    expect(statusesAfter({ op: "done", phase: "P" })).toEqual(
      new Map([
        ["p-task", "completed"],
        ["ip-task", "completed"],
        ["b-task", "completed"],
        ["c-task", "completed"],
        ["a-task", "completed"],
      ]),
    );
    expect(statusesAfter({ op: "drop", phase: "P" })).toEqual(
      new Map([
        ["p-task", "abandoned"],
        ["ip-task", "abandoned"],
        ["b-task", "abandoned"],
        ["c-task", "abandoned"],
        ["a-task", "abandoned"],
      ]),
    );
    // `block` only touches open work (pending/in_progress/blocked); closed
    // tasks keep their status, and the blocker note refreshes on re-block.
    const blocked = statusesAfter({ op: "block", phase: "P", reason: "waiting on CI" });
    expect(blocked.get("p-task")).toBe("blocked");
    expect(blocked.get("ip-task")).toBe("blocked");
    expect(blocked.get("b-task")).toBe("blocked");
    expect(blocked.get("c-task")).toBe("completed");
    expect(blocked.get("a-task")).toBe("abandoned");
    // `unblock` returns only blocked targets to pending, clearing the note.
    // (The in_progress task is untouched; normalization keeps it active.)
    const unblocked = statusesAfter({ op: "unblock", phase: "P" });
    expect(unblocked.get("b-task")).toBe("pending");
    expect(unblocked.get("p-task")).toBe("pending");
    expect(unblocked.get("ip-task")).toBe("in_progress");
    expect(unblocked.get("c-task")).toBe("completed");
    expect(unblocked.get("a-task")).toBe("abandoned");
    // `rm` phase-target clears the phase's tasks; task-target removes one.
    expect(firstPhase(applyParams(fiveStatusPhases(), { op: "rm", phase: "P" }).phases).tasks).toEqual([]);
    const rmOne = firstPhase(applyParams(fiveStatusPhases(), { op: "rm", task: "b-task" }).phases).tasks;
    expect(rmOne.map((task) => task.content)).toEqual(["p-task", "ip-task", "c-task", "a-task"]);
  });

  test("start demotes every other active task and re-opens closed targets", () => {
    const { phases } = applyParams(fiveStatusPhases(), { op: "start", task: "a-task" });
    const statuses = new Map(firstPhase(phases).tasks.map((task) => [task.content, task.status]));
    expect(statuses.get("a-task")).toBe("in_progress");
    expect(statuses.get("ip-task")).toBe("pending");
    expect(statuses.get("p-task")).toBe("pending");
  });

  test("normalizeInProgressTask: single-active invariant (demote extras, promote earliest pending, skip blocked)", () => {
    // Multiple in_progress: a mutating op (rm) runs normalization — only
    // the first stays active. (view is read-only: no normalization.)
    const demotedAfterRm = applyParams(
      [
        {
          name: "P",
          tasks: [
            { content: "one", status: "in_progress" },
            { content: "two", status: "in_progress" },
            { content: "gone", status: "pending" },
          ],
        },
      ],
      { op: "rm", task: "gone" },
    );
    expect(firstPhase(demotedAfterRm.phases).tasks.map((task) => task.status)).toEqual(["in_progress", "pending"]);

    // None in_progress: earliest pending promotes.
    const promoted = applyParams(
      [
        {
          name: "P",
          tasks: [
            { content: "done-one", status: "completed" },
            { content: "next", status: "pending" },
            { content: "later", status: "pending" },
          ],
        },
      ],
      { op: "rm", task: "done-one" },
    );
    expect(firstPhase(promoted.phases).tasks.map((task) => task.status)).toEqual(["in_progress", "pending"]);

    // All open work blocked: nothing promotes.
    const allBlocked = applyParams(
      [
        {
          name: "P",
          tasks: [
            { content: "b1", status: "blocked" },
            { content: "b2", status: "blocked" },
          ],
        },
      ],
      { op: "view" },
    );
    expect(firstPhase(allBlocked.phases).tasks.map((task) => task.status)).toEqual(["blocked", "blocked"]);
  });

  test("op error strings are omp-verbatim and any error discards the whole op", () => {
    const phases = clonePhases(fiveStatusPhases());
    const cases: { op: Parameters<typeof applyParams>[1]; error: string }[] = [
      { op: { op: "init" }, error: "Missing list for init operation" },
      {
        op: {
          op: "init",
          list: [
            { phase: "P", items: ["x"] },
            { phase: "P", items: ["y"] },
          ],
        },
        error: 'Duplicate phase "P" in init list',
      },
      {
        op: { op: "init", list: [{ phase: "P", items: ["x", "x"] }] },
        error: 'Duplicate task "x" in init list',
      },
      { op: { op: "start" }, error: "Missing task content" },
      { op: { op: "start", task: "nope" }, error: 'Task "nope" not found' },
      { op: { op: "start", task: "task-3" }, error: 'Task "task-3" not found. Tasks are referenced by content, not by IDs — pass the task\'s full text from the previous result.' },
      { op: { op: "block" }, error: "block requires a task or phase target" },
      { op: { op: "unblock" }, error: "unblock requires a task or phase target" },
      { op: { op: "append", items: ["x"] }, error: "Missing phase name for append operation" },
      { op: { op: "append", phase: "P" }, error: "Missing items for append operation" },
      { op: { op: "append", phase: "P", items: ["p-task"] }, error: 'Task "p-task" already exists' },
      { op: { op: "rm", phase: "Nope" }, error: 'Phase "Nope" not found' },
    ];
    for (const { op, error } of cases) {
      const { phases: after, errors } = applyParams(clonePhases(phases), op);
      expect(errors, JSON.stringify(op)).toEqual([error]);
      // Non-init failing ops never touch the working list (state stays at
      // the pre-call list). A failed init rebuilds an empty working array —
      // the executor's failed-branch discard (effective = previous) is what
      // keeps the model-visible and persisted state at previous.
      if (op.op !== "init") {
        expect(JSON.stringify(after), JSON.stringify(op)).toBe(JSON.stringify(phases));
      }
    }
    // Empty-list hint rides on not-found when the list is empty.
    const empty: TodoPhase[] = [{ name: "P", tasks: [] }];
    expect(applyParams(empty, { op: "start", task: "x" }).errors).toEqual([
      'Task "x" not found (todo list is empty — was it replaced or not yet created?)',
    ]);
  });

  test("targeting rules: task beats phase beats neither", () => {
    const phases: TodoPhase[] = [
      { name: "A", tasks: [{ content: "t1", status: "pending" }] },
      { name: "B", tasks: [{ content: "t2", status: "pending" }] },
    ];
    // Neither target: every task in every phase. (clonePhases — omp execute
    // hands applyParams a clone; the fixture must survive the first call.)
    expect(
      applyParams(clonePhases(phases), { op: "done" }).phases.flatMap((p) => p.tasks.map((t) => t.status)),
    ).toEqual(["completed", "completed"]);
    // Phase target: only that phase — except normalization promotes the
    // earliest pending task globally (omp normalizeInProgressTask), so
    // phase A's task goes in_progress.
    expect(
      applyParams(clonePhases(phases), { op: "done", phase: "B" }).phases.flatMap((p) =>
        p.tasks.map((t) => t.status),
      ),
    ).toEqual(["in_progress", "completed"]);
    // Task target: exactly one (the survivor then auto-promotes — no active
    // task remains).
    expect(
      applyParams(clonePhases(phases), { op: "drop", task: "t1" }).phases.flatMap((p) =>
        p.tasks.map((t) => t.status),
      ),
    ).toEqual(["abandoned", "in_progress"]);
    // append is the only op that creates a missing phase.
    const appended = applyParams(clonePhases(phases), { op: "append", phase: "C", items: ["t3"] });
    expect(appended.phases.map((p) => p.name)).toEqual(["A", "B", "C"]);
    const appendedPhase = appended.phases[2];
    if (appendedPhase === undefined) throw new Error("appended phase vanished");
    expect(appendedPhase.tasks).toEqual([{ content: "t3", status: "pending" }]);
    // init rebuilds from scratch; flat items synthesize the default phase.
    const flat = applyParams([], { op: "init", items: ["only"] });
    expect(flat.phases).toEqual([{ name: "Tasks", tasks: [{ content: "only", status: "in_progress" }] }]);
    const phased = applyParams([], { op: "init", items: ["only"], phase: "Setup" });
    expect(firstPhase(phased.phases).name).toBe("Setup");
  });

  test("missing-op repair: only unambiguous payloads (omp todo.ts:481-509)", () => {
    // list → init; items+phase → append; bare items with no existing → init;
    // ambiguous targeting stays an error with the omp text.
    expect(resolveTodoParams({ list: [{ phase: "P", items: ["a"] }] }, false)).toEqual({
      op: "init",
      list: [{ phase: "P", items: ["a"] }],
    });
    expect(resolveTodoParams({ items: ["a"], phase: "P" }, true)).toMatchObject({ op: "append" });
    expect(resolveTodoParams({ items: ["a"] }, false)).toMatchObject({ op: "init" });
    // bare items WITH existing phases: ambiguous (init would replace, append
    // needs a phase) — stays a schema error.
    const ambiguous = resolveTodoParams({ items: ["a"] }, true);
    expect(typeof ambiguous).toBe("string");
    expect(ambiguous).toContain("Invalid todo arguments: ");
    const targetingOnly = resolveTodoParams({ task: "x" }, true);
    expect(targetingOnly).toContain("Invalid todo arguments: ");
  });

  test("formatSummary: error prefix, empty states, remaining tree, worked-ahead note", () => {
    expect(formatSummary([], [], true)).toBe("Todo list is empty.");
    expect(formatSummary([], [], false)).toBe("Todo list cleared.");
    expect(formatSummary([], ["boom"], false)).toBe("Errors: boom");
    const rendered = formatSummary(
      [
        {
          name: "Alpha",
          tasks: [
            { content: "one", status: "completed" },
            { content: "two", status: "in_progress" },
            { content: "three", status: "blocked", blocker: "CI down" },
          ],
        },
        { name: "Beta", tasks: [{ content: "four", status: "pending" }] },
      ],
      [],
      false,
    );
    expect(rendered).toBe(
      [
        "Remaining items (2):",
        "  - two [in_progress] (Alpha)",
        "  - four [pending] (Beta)",
        "Overall: 1/4 done, 2 open, 1 blocked.",
        'Active phase 1/2 "Alpha" (1/3).',
        "  Alpha:",
        "    - [X] one",
        "    - [ ] two (in progress)",
        "    - [ ] three (blocked: CI down)",
        "  Beta:",
        "    - [ ] four",
      ].join("\n"),
    );
    // Worked-ahead: open work sits in an earlier phase than closed work.
    const workedAhead = formatSummary(
      [
        { name: "First", tasks: [{ content: "open", status: "pending" }] },
        { name: "Second", tasks: [{ content: "closed", status: "completed" }] },
      ],
      [],
      false,
    );
    expect(workedAhead).toContain(
      'Active phase 1/2 "First" (0/1) — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed).',
    );
  });
});

// ---------------------------------------------------------------------------
// Session-tree projections over synthetic journals
// ---------------------------------------------------------------------------

describe("M1.5 T3 — session-tree projections (T:checkpoint.ts rehydrate/apply semantics)", () => {
  const THREAD = "thr-x";

  function ev(type: string, seq: number, data: Record<string, unknown>): AnyAgentEvent {
    return {
      type,
      seq,
      id: `evt-${seq}`,
      threadId: THREAD,
      createdAt: 1_000 + seq,
      data,
    } as unknown as AnyAgentEvent;
  }

  function call(tool: string, seq: number, args: Record<string, unknown>): AnyAgentEvent {
    return ev("tool.call", seq, { turnId: "t1", modelCallId: 1, tool, arguments: args, timeoutMs: 1_000 });
  }

  function result(tool: string, callSeq: number, seq: number, status: string): AnyAgentEvent {
    return ev("tool.result", seq, {
      turnId: "t1",
      executionId: executionIdFor(THREAD, callSeq),
      status,
      exitCode: null,
      output: "x",
    });
  }

  test("idle journal projects idle; checkpoint wins when latest; completed rewind carries trimmed report", () => {
    expect(checkpointRewindState([], THREAD)).toEqual({ phase: "idle" });

    // cp(ok) → active, boundary = cp result seq.
    const cp = [
      call("checkpoint", 3, { goal: "g" }),
      result("checkpoint", 3, 4, "ok"),
    ];
    expect(checkpointRewindState(cp, THREAD)).toEqual({ phase: "active", checkpointResultSeq: 4 });

    // cp(ok) rw(ok) → completed; boundary = the cp result the rewind targets.
    const journal = [
      ev("thread.created", 1, { title: "t", machineId: "m" }),
      call("checkpoint", 3, { goal: "g" }),
      result("checkpoint", 3, 4, "ok"),
      call("think", 5, { thoughts: "dig" }),
      result("think", 5, 6, "ok"),
      call("rewind", 7, { report: "  findings here  " }),
      result("rewind", 7, 8, "ok"),
    ];
    expect(checkpointRewindState(journal, THREAD)).toEqual({
      phase: "completed",
      checkpointResultSeq: 4,
      rewindResultSeq: 8,
      report: "findings here",
    });

    // A later ok checkpoint clears the retained rewind (active again).
    journal.push(call("checkpoint", 9, { goal: "g2" }), result("checkpoint", 9, 10, "ok"));
    expect(checkpointRewindState(journal, THREAD)).toEqual({ phase: "active", checkpointResultSeq: 10 });

    // error/failed results never decide the phase.
    const errored = [
      call("checkpoint", 3, { goal: "g" }),
      result("checkpoint", 3, 4, "error"),
    ];
    expect(checkpointRewindState(errored, THREAD)).toEqual({ phase: "idle" });
  });

  test("activeBranchAfterRewind: kept ends at the checkpoint boundary, exploration span hidden", () => {
    const journal = [
      ev("thread.created", 1, { title: "t", machineId: "m" }),
      ev("turn.input", 2, { turnId: "t1", inputId: "in", content: [] }),
      call("checkpoint", 3, { goal: "g" }),
      result("checkpoint", 3, 4, "ok"),
      call("think", 5, { thoughts: "dig" }),
      result("think", 5, 6, "ok"),
      call("rewind", 7, { report: "findings" }),
      result("rewind", 7, 8, "ok"),
    ];
    const projection = activeBranchAfterRewind(journal, THREAD);
    if (projection === undefined) throw new Error("completed rewind produced no projection");
    const { kept, hidden, summary } = projection;
    expect(summary).toBe("findings");
    // Partition + boundary: kept ends with the checkpoint tool.result row;
    // hidden is exactly the exploration span plus the rewind execution.
    expect(kept.length + hidden.length).toBe(journal.length);
    expect(kept.at(-1)?.seq).toBe(4);
    expect(hidden.map((event) => event.seq)).toEqual([5, 6, 7, 8]);
    // Message-count consistency (L1): the model-visible exploration rows
    // (think + rewind call/result pairs) are all outside the kept prefix.
    const visible = (events: readonly AnyAgentEvent[]) =>
      events.filter((event) => event.type === "tool.call" || event.type === "tool.result").length;
    expect(visible(kept)).toBe(2); // checkpoint call + result
    expect(visible(hidden)).toBe(4);
    // No completed rewind → no cut.
    expect(activeBranchAfterRewind(cpActiveJournal(), THREAD)).toBeUndefined();

    function cpActiveJournal(): AnyAgentEvent[] {
      return [call("checkpoint", 3, { goal: "g" }), result("checkpoint", 3, 4, "ok")];
    }
  });

  test("todoJournalState folds previous from the newest foreign entry and flags the execution's own snapshot", () => {
    const mine = "thr-x:9";
    const journal: AnyAgentEvent[] = [
      ev(TODO_PHASES_ENTRY_TYPE, 2, {
        version: 1,
        executionId: "thr-x:3",
        op: "init",
        phases: [{ name: "P", tasks: [{ content: "a", status: "pending" }] }],
      }),
      ev(TODO_PHASES_ENTRY_TYPE, 5, {
        version: 1,
        executionId: mine,
        op: "done",
        phases: [{ name: "P", tasks: [{ content: "a", status: "completed" }] }],
      }),
    ];
    expect(todoJournalState(journal, mine)).toEqual({
      previous: [{ name: "P", tasks: [{ content: "a", status: "pending" }] }],
      interrupted: [{ name: "P", tasks: [{ content: "a", status: "completed" }] }],
    });
    // A foreign newest entry short-circuits: no interrupted flag.
    expect(todoJournalState(journal, "thr-x:7").interrupted).toBeUndefined();
    expect(todoJournalState(journal, "thr-x:7").previous).toEqual([
      { name: "P", tasks: [{ content: "a", status: "completed" }] },
    ]);
    expect(latestTodoPhases(journal)).toEqual([{ name: "P", tasks: [{ content: "a", status: "completed" }] }]);
    expect(latestTodoPhases([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Executor branches against a stubbed context (crash-window + omp error text)
// ---------------------------------------------------------------------------

function stubCtx(overrides: Partial<EdgeToolContext> = {}): { ctx: EdgeToolContext; appends: TodoPhase[][] } {
  const appends: TodoPhase[][] = [];
  const ctx: EdgeToolContext = {
    executionId: "thr-x:9",
    threadId: "thr-x",
    appendNotebookRevision: () => Promise.resolve(undefined),
    notebook: () => Promise.resolve(undefined),
    todoState: () => Promise.resolve({ previous: [], interrupted: undefined }),
    appendTodoPhases: (_op, phases) => {
      appends.push(phases);
      return Promise.resolve();
    },
    checkpointRewindState: () => Promise.resolve({ phase: "idle" }),
    ...overrides,
  };
  return { ctx, appends };
}

describe("M1.5 T3 — executor branches (T:checkpoint.ts ToolError paths + crash window)", () => {
  const todoRow = toolRegistryRow("todo");
  const checkpointRow = toolRegistryRow("checkpoint");
  const rewindRow = toolRegistryRow("rewind");

  test("interrupted snapshot completes the re-ask without re-applying the op", async () => {
    if (todoRow === undefined) throw new Error("todo row missing");
    const interrupted: TodoPhase[] = [{ name: "P", tasks: [{ content: "a", status: "completed" }] }];
    const { ctx, appends } = stubCtx({
      todoState: () => Promise.resolve({ previous: [], interrupted }),
    });
    const result = await runEdgeTool(todoRow, { op: "init", items: ["a"] }, ctx);
    expect(result).toEqual({ status: "ok", output: formatSummary(interrupted, [], false) });
    expect(appends).toEqual([]); // never a second journal write
  });

  test("rewind errors: completed-rewind vs no-checkpoint distinction, empty report guard", async () => {
    if (rewindRow === undefined) throw new Error("rewind row missing");
    const completed = stubCtx({
      checkpointRewindState: () =>
        Promise.resolve({
          phase: "completed",
          checkpointResultSeq: 4,
          rewindResultSeq: 8,
          report: "old",
        }),
    });
    expect(await runEdgeTool(rewindRow, { report: "new" }, completed.ctx)).toEqual({
      status: "error",
      output:
        "Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
    });
    const idle = stubCtx({});
    expect(await runEdgeTool(rewindRow, { report: "new" }, idle.ctx)).toEqual({
      status: "error",
      output: "No active checkpoint. Create a checkpoint before calling rewind.",
    });
    const active = stubCtx({
      checkpointRewindState: () => Promise.resolve({ phase: "active", checkpointResultSeq: 4 }),
    });
    // State check runs BEFORE the report trim (omp execute order).
    expect(await runEdgeTool(rewindRow, { report: "   " }, active.ctx)).toEqual({
      status: "error",
      output: "Report cannot be empty.",
    });
    expect(await runEdgeTool(rewindRow, { report: "  findings  " }, active.ctx)).toEqual({
      status: "ok",
      output: "Rewind requested.\nReport captured for context replacement.",
    });
  });

  test("checkpoint rejects nesting and acknowledges with the goal echoed", async () => {
    if (checkpointRow === undefined) throw new Error("checkpoint row missing");
    const active = stubCtx({
      checkpointRewindState: () => Promise.resolve({ phase: "active", checkpointResultSeq: 4 }),
    });
    expect(await runEdgeTool(checkpointRow, { goal: "dig" }, active.ctx)).toEqual({
      status: "error",
      output: "Checkpoint already active.",
    });
    const idle = stubCtx({});
    expect(await runEdgeTool(checkpointRow, { goal: "dig" }, idle.ctx)).toEqual({
      status: "ok",
      output: "Checkpoint: dig\nFinish exploration and formulate findings.",
    });
  });
});

// ---------------------------------------------------------------------------
// Wire rows + end-to-end DO-local execution (L1 with replay consistency)
// ---------------------------------------------------------------------------

describe("M1.5 T3 — registry rows (control-plane §1.1, classification §2.2)", () => {
  test("the session-tree trio is registered class edge with do-local routing and omp intent modes", () => {
    // omp builtin-names.ts order restricted to the registered set: bash,
    // checkpoint, rewind, context_notes, new_context, think, todo.
    expect(TOOL_REGISTRY.map((row) => row.name)).toEqual([
      "bash",
      "checkpoint",
      "rewind",
      "context_notes",
      "new_context",
      "think",
      "todo",
    ]);
    for (const name of ["checkpoint", "rewind", "todo"]) {
      const row = toolRegistryRow(name);
      expect(row?.class).toBe("edge");
      expect(row?.backend).toEqual({ kind: "do-local" });
    }
    // checkpoint/rewind declare function intents → resolveIntentMode omit
    // (checkpoint.ts:62/98 + agent-loop.ts:1025); todo has none → require.
    expect(toolRegistryRow("checkpoint")?.intent).toBe("omit");
    expect(toolRegistryRow("rewind")?.intent).toBe("omit");
    expect(toolRegistryRow("todo")?.intent).toBe("require");
  });

  test("wire definitions are omp prompts verbatim; function-intent rows carry no i field", () => {
    const tools = wireToolSet(M0_RENDER_FLAGS);
    const checkpoint = tools.find((tool) => tool.name === "checkpoint");
    const rewind = tools.find((tool) => tool.name === "rewind");
    const todo = tools.find((tool) => tool.name === "todo");
    expect(checkpoint?.description).toBe(CHECKPOINT_DESCRIPTION);
    expect(checkpoint?.input_schema).toEqual({
      type: "object",
      properties: { goal: { type: "string", description: "investigation goal" } },
      required: ["goal"],
    });
    expect(rewind?.description).toBe(REWIND_DESCRIPTION);
    expect(rewind?.input_schema).toEqual({
      type: "object",
      properties: { report: { type: "string", description: "investigation findings" } },
      required: ["report"],
    });
    expect(todo?.description).toBe(TODO_DESCRIPTION);
    const schema = todo?.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(["op", "i"]);
    expect(schema.properties.task).toEqual({ type: "string", description: "verbatim task content" });
    expect(schema.properties.list).toEqual({
      type: "array",
      description: "phases for init",
      items: {
        type: "object",
        properties: {
          phase: { type: "string" },
          items: { type: "array", minItems: 1, items: { type: "string" } },
        },
        required: ["items", "phase"],
      },
    });
    const properties = schema.properties;
    expect(Object.keys(properties)).toEqual(["i", "op", "items", "list", "phase", "reason", "task"]);
  });
});

describe("M1.5 T3 — todo end-to-end (DO-local, zero daemon, replay-consistent)", () => {
  const INIT = {
    op: "init",
    list: [{ phase: "Setup", items: ["clone repo", "run tests"] }],
  } as const;

  test("init → view → done runs DO-locally with journal-backed snapshots and zero daemon touches", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "todo", arguments: { ...INIT } }] },
        { toolCalls: [{ name: "todo", arguments: { op: "view" } }] },
        { toolCalls: [{ name: "todo", arguments: { op: "done", task: "clone repo" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-t3-todo",
      content: [{ type: "text", text: "track work" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);

    // init + done persist canonical snapshots; view writes nothing.
    const entries = todoEntries(events);
    expect(entries).toHaveLength(2);
    if (entries[0]?.type !== TODO_PHASES_ENTRY_TYPE || entries[1]?.type !== TODO_PHASES_ENTRY_TYPE) {
      throw new Error("entry vanished");
    }
    expect(entries[0].data).toMatchObject({ version: 1, op: "init" });
    expect(entries[0].data.phases).toEqual([
      // Post-normalization: the earliest pending task auto-promotes.
      {
        name: "Setup",
        tasks: [
          { content: "clone repo", status: "in_progress" },
          { content: "run tests", status: "pending" },
        ],
      },
    ]);
    const doneEntry = entries[1].data;
    expect(doneEntry).toMatchObject({ version: 1, op: "done" });
    // The snapshot is keyed to its owning execution (re-ask idempotency key).
    const doneCall = callsOf(events, "todo")[2];
    if (doneCall?.type !== "tool.call") throw new Error("no third todo call");
    expect(doneEntry.executionId).toBe(executionIdFor(doneCall.threadId, doneCall.seq));
    const doneTask = doneEntry.phases[0]?.tasks[0];
    expect(doneTask?.status).toBe("completed");
    const latestTask = latestTodoPhases(events)[0]?.tasks[0];
    expect(latestTask?.status).toBe("completed");

    // View is a pure read: its result renders the list, no journal write.
    const view = requireResult(events, "todo", 1);
    expect(view.data.status).toBe("ok");
    expect(view.data.output).toContain("Overall: 0/2 done, 2 open.");

    // The done result renders the post-normalization summary.
    const done = requireResult(events, "todo", 2);
    expect(done.data.status).toBe("ok");
    expect(done.data.output).toContain("Overall: 1/2 done, 1 open.");
    expect(done.data.output).toContain("- [X] clone repo");

    // init output renders the fresh list with auto-promoted first task.
    const init = requireResult(events, "todo", 0);
    expect(init.data.output).toContain("- clone repo [in_progress] (Setup)");

    // Edge path consumed zero daemon dispatches and zero tool.dispatch rows.
    await expect(rig.service.journal()).resolves.toEqual([]);
    expect(events.some((event) => event.type === "tool.dispatch")).toBe(false);
  });

  test("failed ops are discarded wholesale: error result, no journal entry, state unchanged", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "todo", arguments: { ...INIT } }] },
        { toolCalls: [{ name: "todo", arguments: { op: "rm", task: "ghost" } }] },
        { toolCalls: [{ name: "todo", arguments: { op: "view" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-t3-todo-err",
      content: [{ type: "text", text: "track work" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    const failed = requireResult(events, "todo", 1);
    expect(failed.data.status).toBe("error");
    expect(failed.data.output).toBe(
      "Errors: Task \"ghost\" not found\n" +
        [
          "Remaining items (2):",
          "  - clone repo [in_progress] (Setup)",
          "  - run tests [pending] (Setup)",
          "Overall: 0/2 done, 2 open.",
          'Active phase 1/1 "Setup" (0/2).',
          "  Setup:",
          "    - [ ] clone repo (in progress)",
          "    - [ ] run tests",
        ].join("\n"),
    );
    // Exactly one journal entry (the init); rm wrote nothing.
    expect(todoEntries(events)).toHaveLength(1);
    // The later view still shows the pristine init list.
    expect(requireResult(events, "todo", 2).data.output).toContain("Overall: 0/2 done, 2 open.");
  });

  test("missing-op repair fires through the DO path (lenientArgValidation)", async () => {
    const rig = await createRig({
      turns: [
        // No `op`: bare items on an empty journal repair to init.
        { toolCalls: [{ name: "todo", arguments: { items: ["only task"] } }] },
        // Ambiguous payload on an existing list: schema error with omp text.
        { toolCalls: [{ name: "todo", arguments: { task: "only task" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-t3-todo-fix",
      content: [{ type: "text", text: "track work" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    const repaired = requireResult(events, "todo", 0);
    expect(repaired.data.status).toBe("ok");
    const firstEntry = todoEntries(events)[0];
    expect(firstEntry?.type).toBe(TODO_PHASES_ENTRY_TYPE);
    expect(firstEntry?.type === TODO_PHASES_ENTRY_TYPE ? firstEntry.data.op : undefined).toBe("init");
    const rejected = requireResult(events, "todo", 1);
    expect(rejected.data.status).toBe("error");
    expect(rejected.data.output).toContain("Invalid todo arguments: ");
  });

  test("eviction + replay: identical journal, identical todo tree, contiguous seqs", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "todo", arguments: { ...INIT } }] },
        { toolCalls: [{ name: "todo", arguments: { op: "done", task: "clone repo" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-t3-todo-evict",
      content: [{ type: "text", text: "persist" }],
      mode: "start",
    });
    const before = await rig.waitTurnComplete(sent.turnId);
    expect(todoEntries(before)).toHaveLength(2);

    await abortAllDurableObjects();
    const after = await rig.afterAbort(() => rig.events());
    expect(after.map((event) => [event.seq, event.type, event.id])).toEqual(
      before.map((event) => [event.seq, event.type, event.id]),
    );
    expect(after.map((event) => event.seq)).toEqual(after.map((_, index) => index + 1));
    expect(latestTodoPhases(after)).toEqual(latestTodoPhases(before));
  });

  test("re-asking a terminal todo executionId answers from the journal — zero second snapshot", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "todo", arguments: { ...INIT } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-t3-todo-dedup",
      content: [{ type: "text", text: "go" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    const call = callsOf(events, "todo")[0];
    if (call?.type !== "tool.call") throw new Error("no todo call");
    const executionId = executionIdFor(call.threadId, call.seq);

    await runInDurableObject(rig.stub, async (instance) => {
      const seam = instance as unknown as {
        dispatchExecution: (turnId: string, executionId: string) => Promise<void>;
      };
      await seam.dispatchExecution(sent.turnId, executionId);
    });

    const after = await rig.events();
    expect(todoEntries(after)).toHaveLength(1);
    expect(after.filter((event) => event.type === "tool.result")).toHaveLength(
      events.filter((event) => event.type === "tool.result").length,
    );
    expect(after).toHaveLength(events.length);
  });
});

describe("M1.5 T3 — checkpoint/rewind end-to-end (branchWithSummary 同构 projection)", () => {
  test("checkpoint → exploration → rewind: boundary projection, L1 partition, state machine over rows", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "checkpoint", arguments: { goal: "find the leak" } }] },
        { toolCalls: [{ name: "think", arguments: { thoughts: "instrument the loop" } }] },
        { toolCalls: [{ name: "rewind", arguments: { report: "  leak is in the drain path  " } }] },
        { toolCalls: [{ name: "rewind", arguments: { report: "again" } }] },
        { toolCalls: [{ name: "checkpoint", arguments: { goal: "second pass" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-t3-cp",
      content: [{ type: "text", text: "explore" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    const threadId = events[0]?.threadId;
    if (threadId === undefined) throw new Error("empty event list");

    // checkpoint acknowledges verbatim (T:checkpoint.ts:84 text; docs §Outputs
    // shows an older wording — code is the runtime truth).
    const cp = requireResult(events, "checkpoint", 0);
    expect(cp.data.status).toBe("ok");
    expect(cp.data.output).toBe("Checkpoint: find the leak\nFinish exploration and formulate findings.");

    // rewind acknowledges verbatim; the report rides the tool.call arguments.
    const rw = requireResult(events, "rewind", 0);
    expect(rw.data.status).toBe("ok");
    expect(rw.data.output).toBe("Rewind requested.\nReport captured for context replacement.");

    // Second rewind after completion: omp double-apply guard.
    const rw2 = requireResult(events, "rewind", 1);
    expect(rw2.data.status).toBe("error");
    expect(rw2.data.output).toBe(
      "Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
    );

    // A checkpoint after the completed rewind re-arms (cp clears the retained
    // rewind — omp capture step 5).
    const cp2 = requireResult(events, "checkpoint", 1);
    expect(cp2.data.status).toBe("ok");

    // Journal-derived state machine: completed right after the rewind, active
    // after the second checkpoint. Zero dedicated journal entries (the rows
    // ARE the state — omp docs/tools/checkpoint.md §Side Effects).
    expect(todoEntries(events)).toHaveLength(0);
    const secondCpCall = callsOf(events, "checkpoint")[1];
    if (secondCpCall?.type !== "tool.call") throw new Error("no second checkpoint");
    const secondCpResultSeq = events.find(
      (event) =>
        event.type === "tool.result" &&
        event.data.executionId === executionIdFor(threadId, secondCpCall.seq),
    )?.seq;
    expect(checkpointRewindState(events, threadId)).toEqual({
      phase: "active",
      checkpointResultSeq: secondCpResultSeq,
    });

    // L1 boundary at the rewind moment: partition ends at the first cp result.
    const atRewind = events.filter((event) => event.seq <= requireResult(events, "rewind", 0).seq);
    const projection = activeBranchAfterRewind(atRewind, threadId);
    if (projection === undefined) throw new Error("completed rewind produced no projection");
    const { kept, hidden, summary } = projection;
    expect(summary).toBe("leak is in the drain path");
    expect(kept.at(-1)?.seq).toBe(cp.seq);
    expect(kept.length + hidden.length).toBe(atRewind.length);
    // The exploration span (think) and the rewind execution are all hidden.
    expect(hidden.every((event) => event.seq > cp.seq)).toBe(true);
  });

  test("rewind guards: no-checkpoint error, empty-report error, nested checkpoint error", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "rewind", arguments: { report: "premature" } }] },
        { toolCalls: [{ name: "checkpoint", arguments: { goal: "g" } }] },
        { toolCalls: [{ name: "checkpoint", arguments: { goal: "again" } }] },
        { toolCalls: [{ name: "rewind", arguments: { report: "   " } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-t3-cp-guards",
      content: [{ type: "text", text: "guards" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    expect(requireResult(events, "rewind", 0).data).toMatchObject({
      status: "error",
      output: "No active checkpoint. Create a checkpoint before calling rewind.",
    });
    expect(requireResult(events, "checkpoint", 0).data.status).toBe("ok");
    expect(requireResult(events, "checkpoint", 1).data).toMatchObject({
      status: "error",
      output: "Checkpoint already active.",
    });
    expect(requireResult(events, "rewind", 1).data).toMatchObject({
      status: "error",
      output: "Report cannot be empty.",
    });
    // Only error rows were written; no journal entries of any kind.
    expect(todoEntries(events)).toHaveLength(0);
  });

  test("eviction + replay: checkpoint/rewind state projects identically from the replayed journal", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "checkpoint", arguments: { goal: "evict drill" } }] },
        { toolCalls: [{ name: "rewind", arguments: { report: "report survives" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-t3-cp-evict",
      content: [{ type: "text", text: "explore" }],
      mode: "start",
    });
    const before = await rig.waitTurnComplete(sent.turnId);
    const threadId = before[0]?.threadId;
    if (threadId === undefined) throw new Error("empty event list");

    await abortAllDurableObjects();
    const after = await rig.afterAbort(() => rig.events());
    expect(after.map((event) => [event.seq, event.type, event.id])).toEqual(
      before.map((event) => [event.seq, event.type, event.id]),
    );
    expect(checkpointRewindState(after, threadId)).toEqual(checkpointRewindState(before, threadId));
    expect(activeBranchAfterRewind(after, threadId)).toEqual(activeBranchAfterRewind(before, threadId));
    const replayedState = checkpointRewindState(after, threadId);
    expect(replayedState.phase).toBe("completed");
    expect(replayedState.phase === "completed" ? replayedState.report : undefined).toBe("report survives");
  });
});
