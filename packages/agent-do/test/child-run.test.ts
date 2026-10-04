import { describe, expect, test } from "vitest";
import type { AgentEventDataByType, AgentEventType } from "../src/fsm-events.js";
import { parseAgentEvent, type AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import { modelRequestFromEvents } from "../src/translate.js";
import {
  childRunVerdict,
  EMPTY_YIELD_ABORT,
  NO_YIELD_WARNING,
  projectChildRun,
  renderAgentHistory,
  renderJournalJsonl,
  renderYieldDelivery,
  SCHEMA_OVERRIDE_MARKER,
  SCHEMA_VIOLATION_PREFIX,
  STRICT_SCHEMA_FAILED,
  YIELD_FORMAT_HINT,
  type ChildRunState,
} from "../src/tools/task/child-run.js";
import { validateAgainstJsonSchema } from "../src/tools/task/schema-validate.js";
import { parseAgentUri, walkJsonPath } from "../src/tools/task/plan.js";
import { runYieldTool } from "../src/tools/yield.js";

/**
 * M1.5 T17 pure-surface tests (proposal §3 T17 L1 unit layer): the child-run
 * gate fold + verdict matrix (reminder ladder tiers, empty abort, strict
 * schema failure, supersession, park), the outputSchema validator subset,
 * the yield tool's per-call verdicts, the agent:// URI grammar + JSON path
 * walker, and the transcript render — all replay-pure, no DO required.
 */

const THREAD = "th-child";

/** Journal builder: appends parsed events under a monotone per-instance seq. */
interface JournalBuilder {
  add<TType extends AgentEventType>(type: TType, data: AgentEventDataByType[TType]): AnyAgentEvent;
  log: AnyAgentEvent[];
}

function createJournal(): JournalBuilder {
  const log: AnyAgentEvent[] = [];
  let seq = 0;
  return {
    add(type, data) {
      const event = parseAgentEvent({
        id: `e${++seq}`,
        threadId: THREAD,
        seq,
        type,
        data,
        createdAt: 0,
      });
      log.push(event);
      return event;
    },
    log,
  };
}

interface IdentityOverrides {
  schema?: unknown;
  mode?: "permissive" | "strict";
}

function addIdentity(journal: JournalBuilder, overrides: IdentityOverrides = {}): void {
  journal.add("task.subagent_identity", {
    spawnId: "sp-1",
    agentId: "Task-1",
    parentThreadId: "th-parent",
    sourceThreadId: null,
    originKind: null,
    depth: 1,
    ...(overrides.schema === undefined
      ? {}
      : { outputSchemaJson: JSON.stringify(overrides.schema) }),
    ...(overrides.mode === undefined ? {} : { schemaMode: overrides.mode }),
  });
}

/** A yield tool.call + terminal result pair at consecutive seqs. */
function addYieldPair(
  journal: JournalBuilder,
  args: { type?: string | string[]; data?: unknown; error?: string },
  result: { status: "ok" | "error"; output: string },
): void {
  const call = journal.add("tool.call", {
    turnId: "t1",
    modelCallId: 1,
    tool: "yield",
    arguments: args,
    timeoutMs: 30_000,
  });
  journal.add("tool.result", {
    turnId: "t1",
    executionId: executionIdFor(THREAD, call.seq),
    status: result.status,
    exitCode: null,
    output: result.output,
  });
}

function addOpenTurn(journal: JournalBuilder, inputId: string): void {
  journal.add("turn.input", {
    turnId: `t-${inputId}`,
    inputId,
    content: [{ type: "text", text: `prompt ${inputId}` }],
  });
  journal.add("turn.completed", { turnId: `t-${inputId}` });
}

function addGrandchildPlan(journal: JournalBuilder, spawnId: string, jobId: string | null): void {
  journal.add("task.spawn_planned", {
    executionId: `ex-${spawnId}`,
    spawnId,
    agentId: `Task-1.${spawnId}`,
    agent: "task",
    childThreadId: `th-${spawnId}`,
    parentThreadId: THREAD,
    machineId: "m",
    mode: jobId === null ? "blocking" : "background",
    jobId,
    task: "t",
    solutionSpace: "s",
    depth: 2,
  });
}

const SCHEMA_VIOLATION_TEXT = `${SCHEMA_VIOLATION_PREFIX} #: missing required property "answer"`;
const ANSWER_SCHEMA = {
  type: "object",
  required: ["answer"],
  properties: { answer: { type: "string" } },
};

describe("M1.5 T17 — outputSchema validator subset", () => {
  const schema = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
  };

  test("valid payloads pass; type/required/items violations carry JSON-pointer paths", () => {
    expect(validateAgainstJsonSchema({ answer: "42", tags: ["a"] }, schema)).toEqual([]);
    expect(validateAgainstJsonSchema({ answer: 42 }, schema)).toEqual([
      "#/answer: expected type string, got number",
    ]);
    expect(validateAgainstJsonSchema({}, schema)).toEqual(['#: missing required property "answer"']);
    expect(validateAgainstJsonSchema({ answer: "x", tags: [1] }, schema)).toEqual([
      "#/tags/0: expected type string, got number",
    ]);
  });

  test("enum, integer, boolean schemas and additionalProperties:false", () => {
    expect(validateAgainstJsonSchema("b", { enum: ["a", "b"] })).toEqual([]);
    expect(validateAgainstJsonSchema("c", { enum: ["a", "b"] })).toHaveLength(1);
    expect(validateAgainstJsonSchema(3, { type: "integer" })).toEqual([]);
    expect(validateAgainstJsonSchema(3.5, { type: "integer" })).toHaveLength(1);
    expect(validateAgainstJsonSchema({}, false)).toHaveLength(1);
    expect(
      validateAgainstJsonSchema(
        { x: 1 },
        { type: "object", properties: {}, additionalProperties: false },
      ),
    ).toEqual(['#: additional property "x" is not allowed']);
    // Unknown keywords are lenient (JSON-Schema draft behavior).
    expect(validateAgainstJsonSchema("anything", { format: "date-time", minLength: 99 })).toEqual([]);
  });
});

describe("M1.5 T17 — child-run fold (projectChildRun)", () => {
  test("incremental sections accumulate in call order; terminal data wins last", () => {
    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    addYieldPair(journal, { type: ["Research"], data: "found X" }, { status: "ok", output: "Section recorded." });
    addYieldPair(journal, { type: ["Research"], data: "found X + Y" }, { status: "ok", output: "Section recorded." });
    addYieldPair(journal, { type: ["Caveats"] }, { status: "ok", output: "Section recorded." });
    addYieldPair(journal, { data: { answer: 42 } }, { status: "ok", output: "Result submitted." });
    const state = projectChildRun(journal.log);
    // accumulate-by-section: the repeated ["Research"] label list updated the
    // first section in place — one entry per distinct section, first-order.
    expect(state.sections).toHaveLength(2);
    expect(state.sections[0]?.data).toBe("found X + Y"); // same label updates the section in place
    expect(state.sections[1]?.labels).toEqual(["Caveats"]);
    expect(state.sections[1]?.data).toBeUndefined();
    expect(state.terminal?.form).toBe("data");
    expect(state.terminal?.data).toEqual({ answer: 42 });
    expect(state.stale).toBe(false);
  });

  test("empty streak counts payload-less rejections and resets on any accepted yield", () => {
    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    addYieldPair(journal, {}, { status: "error", output: YIELD_FORMAT_HINT });
    addYieldPair(journal, {}, { status: "error", output: YIELD_FORMAT_HINT });
    expect(projectChildRun(journal.log).emptyStreak).toBe(2);
    addYieldPair(journal, { data: "ok now" }, { status: "ok", output: "Result submitted." });
    expect(projectChildRun(journal.log).emptyStreak).toBe(0);
  });

  test("schema-fail streak counts SCHEMA_VIOLATION rejections; identity mirrors the contract", () => {
    const journal = createJournal();
    addIdentity(journal, { schema: ANSWER_SCHEMA });
    addOpenTurn(journal, "assign");
    addYieldPair(journal, { data: {} }, { status: "error", output: SCHEMA_VIOLATION_TEXT });
    addYieldPair(journal, { data: {} }, { status: "error", output: SCHEMA_VIOLATION_TEXT });
    const state = projectChildRun(journal.log);
    expect(state.schemaFailStreak).toBe(2);
    expect(state.outputSchema).toEqual(ANSWER_SCHEMA);
    expect(state.schemaMode).toBe("permissive");
  });

  test("stale: an async-result seq after the terminal yield voids it; a fresh yield heals", () => {
    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    addYieldPair(journal, { data: "v1" }, { status: "ok", output: "Result submitted." });
    addGrandchildPlan(journal, "sp-gc", "job-1");
    journal.add("task.async_result", {
      spawnId: "sp-gc",
      agentId: "Task-1.sp-gc",
      jobId: "job-1",
      status: "ok",
      output: "gc",
    });
    expect(projectChildRun(journal.log).stale).toBe(true);
    addYieldPair(journal, { data: "v2" }, { status: "ok", output: "Result submitted." });
    const healed = projectChildRun(journal.log);
    expect(healed.stale).toBe(false);
    expect(healed.terminal?.data).toBe("v2");
  });

  test("pendingSpawns: plans without settlement", () => {
    const journal = createJournal();
    addIdentity(journal, { schema: { type: "string" }, mode: "strict" });
    addOpenTurn(journal, "assign");
    addGrandchildPlan(journal, "sp-a", null);
    const open = projectChildRun(journal.log);
    expect(open.pendingSpawns).toEqual(["sp-a"]);
    journal.add("task.spawn_settled", {
      spawnId: "sp-a",
      jobId: null,
      agentId: "Task-1.sp-a",
      childThreadId: "th-sp-a",
      status: "ok",
      output: "done",
    });
    expect(projectChildRun(journal.log).pendingSpawns).toEqual([]);
    expect(open.schemaMode).toBe("strict");
  });
});

describe("M1.5 T17 — reminder ladder verdict (childRunVerdict)", () => {
  test("no yield yet → reminders 1..3, the last forced; exhaustion settles the SYSTEM WARNING", () => {
    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    let state = projectChildRun(journal.log);
    const first = childRunVerdict(state);
    expect(first).toMatchObject({ kind: "remind", forced: false });
    if (first.kind === "remind") {
      expect(first.text).toContain("Reminder 1/3");
      expect(first.text).toContain(YIELD_FORMAT_HINT);
    }

    state = withReminders(state, 1);
    expect(childRunVerdict(state)).toMatchObject({ kind: "remind", forced: false });

    state = withReminders(state, 2);
    const third = childRunVerdict(state);
    expect(third).toMatchObject({ kind: "remind", forced: true });
    if (third.kind === "remind") expect(third.text).toContain("Final reminder (3/3)");

    state = withReminders(state, 3);
    expect(childRunVerdict(state)).toEqual({ kind: "settle", status: "error", output: NO_YIELD_WARNING });
  });

  test("supersession re-runs the ladder from tier 1 with the supersede prefix", () => {
    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    addYieldPair(journal, { data: "v1" }, { status: "ok", output: "Result submitted." });
    journal.add("task.async_result", {
      spawnId: "sp",
      agentId: "Task-1.G",
      jobId: "j",
      status: "ok",
      output: "late",
    });
    const state = projectChildRun(journal.log);
    const verdict = childRunVerdict(state);
    expect(verdict).toMatchObject({ kind: "remind", forced: false });
    if (verdict.kind === "remind") expect(verdict.text).toContain("[superseded]");
    // The stale yield itself is never delivered.
    expect(childRunVerdict(state)).not.toMatchObject({ kind: "settle", status: "ok" });
  });

  test("interrupted reminder marker (no turn yet) re-sends the same inputId", () => {
    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    journal.add("task.yield_reminder", { inputId: "yield-reminder-1", forced: false });
    const state = projectChildRun(journal.log);
    expect(childRunVerdict(state)).toMatchObject({ kind: "remind", reuseInputId: "yield-reminder-1" });
  });

  test("terminal yield with pending spawns parks; clean terminal settles with sections", () => {
    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    addGrandchildPlan(journal, "sp-gc", "job-1");
    addYieldPair(journal, { type: ["Findings"], data: "F" }, { status: "ok", output: "Section recorded." });
    addYieldPair(journal, { data: { done: true } }, { status: "ok", output: "Result submitted." });
    expect(childRunVerdict(projectChildRun(journal.log))).toMatchObject({ kind: "noop" });

    journal.add("task.spawn_settled", {
      spawnId: "sp-gc",
      jobId: "job-1",
      agentId: "Task-1.sp-gc",
      childThreadId: "th-sp-gc",
      status: "ok",
      output: "gc",
    });
    const verdict = childRunVerdict(projectChildRun(journal.log));
    expect(verdict).toMatchObject({ kind: "settle", status: "ok" });
    if (verdict.kind === "settle") {
      expect(verdict.output).toContain("## Findings");
      expect(verdict.output).toContain('"done": true');
    }
  });

  test("error-form yield settles status error with the error text", () => {
    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    addYieldPair(journal, { error: "upstream exploded" }, { status: "ok", output: "Result submitted." });
    expect(childRunVerdict(projectChildRun(journal.log))).toEqual({
      kind: "settle",
      status: "error",
      output: "upstream exploded",
    });
  });

  test("quality gates: 3 consecutive empty submissions abort; strict schema failure fails the run", () => {
    const emptyJournal = createJournal();
    addIdentity(emptyJournal);
    addOpenTurn(emptyJournal, "assign");
    for (let i = 0; i < 3; i++) {
      addYieldPair(emptyJournal, {}, { status: "error", output: YIELD_FORMAT_HINT });
    }
    expect(childRunVerdict(projectChildRun(emptyJournal.log))).toEqual({
      kind: "settle",
      status: "error",
      output: EMPTY_YIELD_ABORT,
    });

    const strictJournal = createJournal();
    addIdentity(strictJournal, { schema: ANSWER_SCHEMA, mode: "strict" });
    addOpenTurn(strictJournal, "assign");
    for (let i = 0; i < 3; i++) {
      addYieldPair(strictJournal, { data: {} }, { status: "error", output: SCHEMA_VIOLATION_TEXT });
    }
    expect(childRunVerdict(projectChildRun(strictJournal.log))).toEqual({
      kind: "settle",
      status: "error",
      output: STRICT_SCHEMA_FAILED,
    });
  });

  test("run guards: no identity → noop; settled receipt → noop; cancelled turn settles failed", () => {
    expect(childRunVerdict(projectChildRun([]))).toMatchObject({ kind: "noop" });

    const settledJournal = createJournal();
    addIdentity(settledJournal);
    addOpenTurn(settledJournal, "assign");
    settledJournal.add("task.yield_completed", { status: "ok", output: "delivered" });
    expect(childRunVerdict(projectChildRun(settledJournal.log))).toMatchObject({ kind: "noop" });

    const cancelJournal = createJournal();
    addIdentity(cancelJournal);
    cancelJournal.add("turn.input", {
      turnId: "t1",
      inputId: "i1",
      content: [{ type: "text", text: "go" }],
    });
    cancelJournal.add("turn.cancelled", { turnId: "t1" });
    expect(childRunVerdict(projectChildRun(cancelJournal.log))).toEqual({
      kind: "settle",
      status: "error",
      output: "Subagent run cancelled before yielding.",
    });
  });
});

describe("M1.5 T17 — yield tool per-call verdicts", () => {
  function journalWithSchemaStreak(streak: number, mode?: "permissive" | "strict"): AnyAgentEvent[] {
    const journal = createJournal();
    addIdentity(journal, { schema: ANSWER_SCHEMA, ...(mode === undefined ? {} : { mode }) });
    addOpenTurn(journal, "assign");
    for (let i = 0; i < streak; i++) {
      addYieldPair(journal, { data: {} }, { status: "error", output: SCHEMA_VIOLATION_TEXT });
    }
    return journal.log;
  }

  test("shape rules: mutual exclusion, empty submission, incremental error ban", async () => {
    const ctx = { events: () => journalWithSchemaStreak(0) };
    expect(await runYieldTool({ data: 1, error: "x" }, ctx)).toMatchObject({ status: "error" });
    expect(await runYieldTool({}, ctx)).toMatchObject({ status: "error", output: YIELD_FORMAT_HINT });
    expect(await runYieldTool({ type: ["S"], error: "x" }, ctx)).toMatchObject({ status: "error" });
    expect(await runYieldTool({ type: ["S"], data: "body" }, ctx)).toMatchObject({
      status: "ok",
      output: "Section recorded.",
    });
  });

  test("schema rejections escalate 1/3 → 3/3, then permissive accepts with schemaOverridden", async () => {
    const first = await runYieldTool({ data: {} }, { events: () => journalWithSchemaStreak(0) });
    expect(first.status).toBe("error");
    expect(first.output).toContain(SCHEMA_VIOLATION_PREFIX);
    expect(first.output).toContain("rejection 1/3");

    const third = await runYieldTool({ data: {} }, { events: () => journalWithSchemaStreak(2) });
    expect(third.status).toBe("error");
    expect(third.output).toContain(SCHEMA_OVERRIDE_MARKER); // next-one-accepted warning

    const fourth = await runYieldTool({ data: {} }, { events: () => journalWithSchemaStreak(3) });
    expect(fourth).toMatchObject({ status: "ok" });
    expect(fourth.output).toContain(SCHEMA_OVERRIDE_MARKER);
  });

  test("strict mode keeps rejecting past the ladder; no override", async () => {
    const verdict = await runYieldTool({ data: {} }, { events: () => journalWithSchemaStreak(3, "strict") });
    expect(verdict.status).toBe("error");
    expect(verdict.output).toContain("schemaMode strict");
  });

  test("valid payloads and schema-less spawns pass straight through", async () => {
    expect(
      await runYieldTool({ data: { answer: "42" } }, { events: () => journalWithSchemaStreak(0) }),
    ).toMatchObject({ status: "ok", output: "Result submitted." });

    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    expect(
      await runYieldTool({ data: { anything: true } }, { events: () => journal.log }),
    ).toMatchObject({ status: "ok" });
  });
});

describe("M1.5 T17 — delivery rendering", () => {
  test("sections render as markdown headings; finalize falls back to the assistant turn", () => {
    const rendered = renderYieldDelivery({
      sections: [
        { labels: ["Research"], data: "found X", callSeq: 4 },
        { labels: ["Caveats"], callSeq: 6 },
      ],
      terminal: {
        callSeq: 9,
        form: "finalize",
        assistantText: "final answer prose",
        schemaOverridden: false,
      },
    });
    expect(rendered).toEqual({
      status: "ok",
      output: "## Research\n\nfound X\n\n## Caveats\n\nfinal answer prose",
    });
  });

  test("schemaOverridden appends the warning; string data passes through raw", () => {
    const rendered = renderYieldDelivery({
      sections: [],
      terminal: { callSeq: 3, form: "data", data: "plain", schemaOverridden: true },
    });
    expect(rendered.status).toBe("ok");
    expect(rendered.output.startsWith("plain\n\n[WARNING]")).toBe(true);
    expect(rendered.output).toContain(SCHEMA_OVERRIDE_MARKER);
  });
});

describe("M1.5 T17 — agent:// grammar and JSON path walker", () => {
  test("parseAgentUri: bare id, extraction suffix, nested dot ids, malformed", () => {
    expect(parseAgentUri("agent://Task-1")).toEqual({ agentId: "Task-1" });
    expect(parseAgentUri("agent://Task-1/answer")).toEqual({ agentId: "Task-1", path: ["answer"] });
    expect(parseAgentUri("agent://Task-1/nested/0")).toEqual({ agentId: "Task-1", path: ["nested", "0"] });
    expect(parseAgentUri("agent://Main.Task-1.Sub")).toEqual({ agentId: "Main.Task-1.Sub" });
    expect(parseAgentUri("agent://all")).toEqual({ agentId: "all" });
    expect(parseAgentUri("agent://")).toBeNull();
    expect(parseAgentUri("history://Task-1")).toBeNull();
  });

  test("walkJsonPath: object keys and array indexes; failure names the segment", () => {
    const value = { nested: ["a", { deep: true }] };
    expect(walkJsonPath(value, ["nested", "1", "deep"])).toEqual({ ok: true, value: true });
    expect(walkJsonPath(value, ["nested", "5"])).toEqual({ ok: false, failedAt: "5" });
    expect(walkJsonPath(value, ["missing"])).toEqual({ ok: false, failedAt: "missing" });
    expect(walkJsonPath(value, [])).toEqual({ ok: true, value });
  });
});

describe("M1.5 T17 — transcript render and journal JSONL", () => {
  test("renderAgentHistory: compact, deterministic, seq-tagged lines", () => {
    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    addYieldPair(journal, { data: { answer: 42 } }, { status: "ok", output: "Result submitted." });
    journal.add("task.yield_warning", { text: NO_YIELD_WARNING });
    const text = renderAgentHistory(journal.log, "Task-1");
    expect(text.startsWith("transcript Task-1 —")).toBe(true);
    expect(text).toContain("identity Task-1 depth=1");
    expect(text).toContain("input: prompt assign");
    expect(text).toContain("yield → ok: Result submitted.");
    expect(text).toContain(NO_YIELD_WARNING);
    // Deterministic: same log, same render.
    expect(renderAgentHistory(journal.log, "Task-1")).toBe(text);
  });

  test("renderJournalJsonl: one {seq,type,data} per line", () => {
    const journal = createJournal();
    addIdentity(journal);
    addOpenTurn(journal, "assign");
    const lines = renderJournalJsonl(journal.log).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ seq: 1, type: "task.subagent_identity" });
  });
});

describe("M1.5 T17 — translate: the forced reminder turn pins toolChoice", () => {
  test("task.yield_reminder bound to the turn's inputId → toolChoice {name: yield}", () => {
    const journal = createJournal();
    journal.add("turn.input", {
      turnId: "t-assign",
      inputId: "assign-1",
      content: [{ type: "text", text: "go" }],
    });
    journal.add("model.call_started", { turnId: "t-assign", consumedSteerSeqs: [] });
    journal.add("model.call_completed", {
      turnId: "t-assign",
      modelCallId: 2,
      text: "talking",
      toolCalls: [],
    });
    journal.add("turn.completed", { turnId: "t-assign" });
    journal.add("task.yield_reminder", { inputId: "forced-1", forced: true });
    journal.add("turn.input", {
      turnId: "t-forced",
      inputId: "forced-1",
      content: [{ type: "text", text: "reminder" }],
    });
    journal.add("model.call_started", { turnId: "t-forced", consumedSteerSeqs: [] });
    const forced = modelRequestFromEvents(journal.log, "t-forced", 7);
    expect(forced.toolChoice).toEqual({ name: "yield" });
    const plain = modelRequestFromEvents(journal.log, "t-assign", 2);
    expect(plain.toolChoice).toBeUndefined();
  });
});

/** Overlay `count` additional reminder markers (post-terminal) onto a state. */
function withReminders(state: ChildRunState, count: number): ChildRunState {
  const baseSeq = state.terminal?.callSeq ?? 0;
  const reminders = Array.from({ length: count }, (_unused, index) => ({
    seq: baseSeq + 100 + index,
    inputId: `reminder-${index + 1}`,
    turnId: `t-reminder-${index + 1}`,
    terminal: "completed" as const,
  }));
  return { ...state, reminders };
}
