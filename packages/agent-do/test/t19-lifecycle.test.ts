import { afterEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { newThreadId } from "@cap/protocol";
import { createRig, mockAgentRuntime, resetRuntime, type Rig } from "./helpers.js";
import type { AgentEventDataByType, AgentEventType } from "../src/fsm-events.js";
import { parseAgentEvent, type AnyAgentEvent } from "../src/fsm-events.js";
import { replayEvents } from "../src/turn-state.js";
import { setAgentRuntime } from "../src/injection.js";
import { MockModelProvider } from "../src/testing/mock-provider.js";
import type { AgentDO } from "../src/agent-do.js";
import { BUNDLED_AGENT_DEFINITIONS, setAgentDefinitions } from "../src/tools/task/types.js";
import { childRunVerdict, projectChildRun } from "../src/tools/task/child-run.js";
import {
  abortRevivable,
  decideKill,
  parseProcKillUri,
  projectLifecycle,
  registerIfAvailable,
} from "../src/tools/task/lifecycle.js";
import type { SpawnPlanRecord } from "../src/tools/task/types.js";

/**
 * M1.5 T19 tests (proposal §3 T19 L1 + replay-consistency): the four-state
 * subagent lifecycle `running|idle|parked|aborted` as a journal fold (TTL
 * park via the child DO alarm, `write agent://<id>` revival receipt, the
 * budget-abort asymmetry, registration CAS, kill idempotence and tombstone
 * resistance). Fold-derived throughout: cold-start refolds reach the same
 * registry, and the killed run's gate turns confirm-only.
 */

// ---------------------------------------------------------------------------
// Journal builders (t18 pattern) — child self-view and parent view
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

function createJournal(threadId = THREAD): JournalBuilder {
  const log: AnyAgentEvent[] = [];
  let seq = 0;
  return {
    add(type, data, createdAt = 0) {
      const event = parseAgentEvent({
        id: `e${++seq}`,
        threadId,
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

function addChildIdentity(journal: JournalBuilder): void {
  journal.add("task.subagent_identity", {
    spawnId: "sp-1",
    agentId: "Task-1",
    parentThreadId: "th-parent",
    sourceThreadId: null,
    originKind: null,
    depth: 1,
  });
}

function addChildRunToSettled(journal: JournalBuilder): void {
  journal.add("turn.input", {
    turnId: "t-assign",
    inputId: "i-assign",
    content: [{ type: "text", text: "assignment" }],
  });
  journal.add("model.call_started", { turnId: "t-assign", consumedSteerSeqs: [] });
  const call = journal.add("tool.call", {
    turnId: "t-assign",
    modelCallId: 1,
    tool: "yield",
    arguments: { data: { answer: 42 } },
    timeoutMs: 30_000,
  });
  journal.add("tool.result", {
    turnId: "t-assign",
    executionId: `th-child:${call.seq}`,
    status: "ok",
    exitCode: null,
    output: "ok",
  });
  journal.add("turn.completed", { turnId: "t-assign" }, 1_000);
  journal.add(
    "task.yield_completed",
    { status: "ok", output: "42" },
    2_000,
  );
}

function addParentPlan(journal: JournalBuilder, overrides: Record<string, unknown> = {}): void {
  journal.add("task.spawn_planned", {
    executionId: "th-parent:5",
    spawnId: "sp-1",
    agentId: "Task-1",
    agent: "task",
    childThreadId: "th-child",
    parentThreadId: "th-parent",
    machineId: "m1",
    mode: "background",
    jobId: "job-1",
    task: "Do X",
    solutionSpace: "one fix: rename, names given",
    depth: 1,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fold: the four-state transition map (child self-view)
// ---------------------------------------------------------------------------

describe("T19 fold — four-state transition map (child self-view)", () => {
  test("identity → running; yield_completed → idle + adopt (session kept)", () => {
    const journal = createJournal();
    addChildIdentity(journal);
    expect(projectLifecycle(journal.log).record("Task-1")).toMatchObject({
      state: "running",
      sessionReleased: false,
      idleSince: null,
    });
    addChildRunToSettled(journal);
    const settled = projectLifecycle(journal.log).record("Task-1");
    expect(settled).toMatchObject({
      state: "idle",
      sessionReleased: false,
      idleSince: 2_000,
      abortReason: null,
    });
  });

  test("parked releases the session, keeps the ref; revived returns to idle", () => {
    const journal = createJournal();
    addChildIdentity(journal);
    addChildRunToSettled(journal);
    journal.add("task.subagent_parked", { spawnId: "sp-1", agentId: "Task-1" }, 3_000);
    const parked = projectLifecycle(journal.log).record("Task-1");
    expect(parked).toMatchObject({
      state: "parked",
      sessionReleased: true,
      idleSince: null,
    });

    journal.add(
      "task.subagent_revived",
      { spawnId: "sp-1", agentId: "Task-1", inputId: "revive-m1", from: "Main" },
      4_000,
    );
    const revived = projectLifecycle(journal.log).record("Task-1");
    expect(revived).toMatchObject({ state: "idle", sessionReleased: false, idleSince: null });

    // An idle-again record legitimately parks once more (fresh TTL cycle).
    journal.add("task.subagent_parked", { spawnId: "sp-1", agentId: "Task-1" }, 5_000);
    expect(projectLifecycle(journal.log).record("Task-1")).toMatchObject({
      state: "parked",
      sessionReleased: true,
    });
  });

  test("post-completion activity refreshes the idle clock (TTL origin)", () => {
    const journal = createJournal();
    addChildIdentity(journal);
    addChildRunToSettled(journal);
    // A follow-up turn after adopt: input + completed at 9_000.
    journal.add(
      "turn.input",
      {
        turnId: "t-follow",
        inputId: "i-follow",
        content: [{ type: "text", text: "follow-up" }],
      },
      8_000,
    );
    journal.add("turn.completed", { turnId: "t-follow" }, 9_000);
    expect(projectLifecycle(journal.log).record("Task-1")).toMatchObject({
      state: "idle",
      idleSince: 9_000,
    });
  });

  test("hard abort lands the tombstone; later rows never flip it", () => {
    const journal = createJournal();
    addChildIdentity(journal);
    addChildRunToSettled(journal);
    const abort = journal.add(
      "task.subagent_aborted",
      { spawnId: "sp-1", agentId: "Task-1", reason: "kill" },
      3_000,
    );
    const tombstone = projectLifecycle(journal.log).record("Task-1");
    expect(tombstone).toMatchObject({
      state: "aborted",
      sessionReleased: true,
      abortReason: "kill",
      idleSince: null,
    });

    // Delayed completion / revive / park are confirm-only (tombstone
    // resistance, omp agent-registry.ts:190-193).
    journal.add("task.yield_completed", { status: "ok", output: "late" }, 4_000);
    journal.add(
      "task.subagent_revived",
      { spawnId: "sp-1", agentId: "Task-1", inputId: "revive-late", from: "Main" },
      5_000,
    );
    journal.add("task.subagent_parked", { spawnId: "sp-1", agentId: "Task-1" }, 6_000);
    journal.add(
      "task.subagent_aborted",
      { spawnId: "sp-1", agentId: "Task-1", reason: "wall_clock" },
      7_000,
    );
    expect(projectLifecycle(journal.log).record("Task-1")).toMatchObject({
      state: "aborted",
      abortReason: "kill",
      lastSeq: abort.seq,
    });
  });

  test("budget abort is the ONLY revivable abort (asymmetry)", () => {
    expect(abortRevivable("budget")).toBe(true);
    expect(abortRevivable("kill")).toBe(false);
    expect(abortRevivable("call_signal")).toBe(false);
    expect(abortRevivable("wall_clock")).toBe(false);
    expect(abortRevivable("internal")).toBe(false);

    const journal = createJournal();
    addChildIdentity(journal);
    addChildRunToSettled(journal);
    journal.add(
      "task.subagent_aborted",
      { spawnId: "sp-1", agentId: "Task-1", reason: "budget" },
      3_000,
    );
    // Resumable idle — NOT a tombstone; a later kill may still land.
    expect(projectLifecycle(journal.log).record("Task-1")).toMatchObject({
      state: "idle",
      sessionReleased: false,
      abortReason: "budget",
      idleSince: 3_000,
    });
  });

  test("replay consistency: refolding the same journal reaches the identical registry", () => {
    const journal = createJournal();
    addChildIdentity(journal);
    addChildRunToSettled(journal);
    journal.add("task.subagent_parked", { spawnId: "sp-1", agentId: "Task-1" }, 3_000);
    journal.add(
      "task.subagent_revived",
      { spawnId: "sp-1", agentId: "Task-1", inputId: "revive-m1", from: "Main" },
      4_000,
    );
    journal.add(
      "task.subagent_aborted",
      { spawnId: "sp-1", agentId: "Task-1", reason: "kill" },
      5_000,
    );
    const first = projectLifecycle(journal.log).records();
    const second = projectLifecycle([...journal.log].reverse().slice().reverse()).records();
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Fold: parent-view records + registration CAS
// ---------------------------------------------------------------------------

describe("T19 fold — parent view and registration CAS", () => {
  test("parent view: plan → running, settled → idle, kill → tombstone (sessionFile kept)", () => {
    const journal = createJournal("th-parent");
    addParentPlan(journal);
    const running = projectLifecycle(journal.log).record("Task-1");
    expect(running).toMatchObject({
      state: "running",
      childThreadId: "th-child",
      sessionFile: "th-child",
    });
    journal.add(
      "task.spawn_settled",
      {
        spawnId: "sp-1",
        jobId: "job-1",
        agentId: "Task-1",
        childThreadId: "th-child",
        status: "ok",
        output: "done",
      },
      2_000,
    );
    journal.add("task.subagent_parked", { spawnId: "sp-1", agentId: "Task-1" }, 3_000);
    const parked = projectLifecycle(journal.log).record("Task-1");
    expect(parked).toMatchObject({
      state: "parked",
      sessionReleased: true,
      // ref + sessionFile survive the park; only the live session released.
      sessionFile: "th-child",
    });
    journal.add(
      "task.subagent_aborted",
      { spawnId: "sp-1", agentId: "Task-1", reason: "kill" },
      4_000,
    );
    journal.add(
      "task.spawn_settled",
      {
        spawnId: "sp-1",
        jobId: "job-1",
        agentId: "Task-1",
        childThreadId: "th-child",
        status: "ok",
        output: "late",
      },
      5_000,
    );
    expect(projectLifecycle(journal.log).record("Task-1")).toMatchObject({
      state: "aborted",
      sessionFile: "th-child",
    });
  });

  test("registerIfAvailable claims absent ids, adopts the exact parked ref, refuses the rest", () => {
    const journal = createJournal();
    addChildIdentity(journal);
    addChildRunToSettled(journal);
    const running = projectLifecycle(journal.log);
    expect(registerIfAvailable(running, { agentId: "Fresh", spawnId: "sp-9" })).toEqual({
      ok: true,
      mode: "claim",
    });
    expect(registerIfAvailable(running, { agentId: "Task-1", spawnId: "sp-1" })).toMatchObject({
      ok: false,
    });

    journal.add("task.subagent_parked", { spawnId: "sp-1", agentId: "Task-1" }, 3_000);
    const parked = projectLifecycle(journal.log);
    expect(registerIfAvailable(parked, { agentId: "Task-1", spawnId: "sp-1" })).toEqual({
      ok: true,
      mode: "adopt",
    });
    expect(registerIfAvailable(parked, { agentId: "Task-1", spawnId: "sp-other" })).toMatchObject({
      ok: false,
    });

    journal.add(
      "task.subagent_aborted",
      { spawnId: "sp-1", agentId: "Task-1", reason: "kill" },
      4_000,
    );
    expect(
      registerIfAvailable(projectLifecycle(journal.log), { agentId: "Task-1", spawnId: "sp-1" }),
    ).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Fold: the killed run's gate turns confirm-only
// ---------------------------------------------------------------------------

describe("T19 fold — killed run's childRunVerdict is a noop", () => {
  test("a tombstone resists the cancelled-turn settle and the reminder ladder", () => {
    const journal = createJournal();
    addChildIdentity(journal);
    addChildRunToSettled(journal);
    // Killed mid-run: an open turn with no yield, then the tombstone, then
    // the cancel landing late.
    journal.add(
      "turn.input",
      { turnId: "t2", inputId: "i2", content: [{ type: "text", text: "follow-up" }] },
      6_000,
    );
    const abort = journal.add(
      "task.subagent_aborted",
      { spawnId: "sp-1", agentId: "Task-1", reason: "kill" },
      7_000,
    );
    journal.add("turn.cancelled", { turnId: "t2" }, 8_000);
    const state = projectChildRun(journal.log);
    expect(state.aborted).toEqual({ reason: "kill", seq: abort.seq });
    expect(childRunVerdict(state)).toMatchObject({ kind: "noop" });
    // First abort wins — a later abort row never replaces it.
    journal.add(
      "task.subagent_aborted",
      { spawnId: "sp-1", agentId: "Task-1", reason: "wall_clock" },
      9_000,
    );
    expect(projectChildRun(journal.log).aborted?.reason).toBe("kill");
  });
});

// ---------------------------------------------------------------------------
// proc://kill URI face (pure)
// ---------------------------------------------------------------------------

describe("T19 — parseProcKillUri / decideKill (business-cancel semantics)", () => {
  test("only proc://<jobId>/kill parses", () => {
    expect(parseProcKillUri("proc://job-1/kill")).toEqual({ jobId: "job-1" });
    expect(parseProcKillUri("proc://job-1")).toBeNull();
    expect(parseProcKillUri("proc://job-1/start")).toBeNull();
    expect(parseProcKillUri("proc:///kill")).toBeNull();
    expect(parseProcKillUri("agent://Task-1")).toBeNull();
  });

  test("unknown job, foreign job, and already-settled jobs never kill twice", () => {
    // One real plan row — the lookup is a plain static table.
    const planned: Record<string, SpawnPlanRecord> = {
      "job-2": {
        seq: 7,
        executionId: "th-parent:5",
        spawnId: "sp-2",
        agentId: "Task-2",
        agent: "task",
        childThreadId: "th-child-2",
        parentThreadId: "th-parent",
        machineId: "m1",
        mode: "background",
        jobId: "job-2",
        task: "Do Y",
        solutionSpace: "one fix: rename, names given",
        depth: 1,
      },
    };
    const planForJob = (jobId: string): SpawnPlanRecord | undefined => planned[jobId];
    expect(decideKill("nope", undefined, "th-parent", planForJob)).toEqual({
      kind: "unknown_job",
      jobId: "nope",
    });
    expect(
      decideKill("job-1", { ownerId: "other", status: "running", settlement: null }, "th-parent", planForJob),
    ).toEqual({ kind: "forbidden", jobId: "job-1" });
    expect(
      decideKill(
        "job-1",
        { ownerId: "th-parent", status: "settled", settlement: { status: "ok" } },
        "th-parent",
        planForJob,
      ),
    ).toEqual({ kind: "already_settled", jobId: "job-1", settlementStatus: "ok" });
    const decision = decideKill(
      "job-2",
      { ownerId: null, status: "running", settlement: null },
      undefined,
      planForJob,
    );
    expect(decision).toMatchObject({ kind: "kill", jobId: "job-2" });
  });
});

// ---------------------------------------------------------------------------
// DO-level L1 chains over real child AgentDOs
// ---------------------------------------------------------------------------

const agentNamespace = (env as { AGENT_DO: DurableObjectNamespace }).AGENT_DO;

function childStubOf(childThreadId: string): DurableObjectStub<AgentDO> {
  return agentNamespace.get(agentNamespace.idFromName(childThreadId)) as DurableObjectStub<AgentDO>;
}

async function childEventsOf(childThreadId: string): Promise<AnyAgentEvent[]> {
  return childStubOf(childThreadId).getEvents({}).then((response) => response.events);
}

/** Poll the child DO journal until `type` lands (the rig's waitFor takes a
 * sync predicate over the PARENT journal only). Returns the child journal. */
async function waitForChildEvent(
  childThreadId: string,
  type: AgentEventType,
): Promise<AnyAgentEvent[]> {
  await expect
    .poll(
      async () => {
        const events = await childEventsOf(childThreadId);
        return events.some((event) => event.type === type);
      },
      { timeout: 20_000, interval: 100 },
    )
    .toBe(true);
  return childEventsOf(childThreadId);
}

const SPAWN_ARGS = {
  task: "Report the answer to everything.",
  solutionSpace: "one fix: rename, names given",
};

afterEach(() => {
  resetRuntime();
  setAgentDefinitions(BUNDLED_AGENT_DEFINITIONS);
});

async function planRowOf(rig: Rig): Promise<Extract<AnyAgentEvent, { type: "task.spawn_planned" }>> {
  const events = await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_planned"));
  const plan = events.find((event) => event.type === "task.spawn_planned");
  if (plan?.type !== "task.spawn_planned") throw new Error("no spawn plan");
  return plan;
}

/** Spawn a background child that settles ok, then wait for the full backflow. */
async function spawnSettledChild(
  parentThreadId: string,
  watchdog?: Record<string, number>,
): Promise<{ rig: Rig; plan: Extract<AnyAgentEvent, { type: "task.spawn_planned" }> }> {
  const parentMock = new MockModelProvider([
    { toolCalls: [{ name: "task", arguments: SPAWN_ARGS }] },
    { deltas: ["spawned"] },
  ]);
  const childMock = new MockModelProvider([
    { toolCalls: [{ name: "yield", arguments: { data: { answer: 42 } } }] },
    { deltas: ["status fine"] },
  ]);
  setAgentRuntime(parentThreadId, mockAgentRuntime(parentMock));
  setAgentRuntime("*", mockAgentRuntime(childMock));
  const rig = await createRig({ threadId: parentThreadId, provider: parentMock, watchdog });
  const sent = await rig.stub.sendMessage({
    clientRequestId: "in-1",
    content: [{ type: "text", text: "spawn a worker" }],
    mode: "start",
  });
  const plan = await planRowOf(rig);
  await rig.waitFor((all) => all.some((event) => event.type === "task.async_result"));
  await rig.waitTurnComplete(sent.turnId);
  return { rig, plan };
}

describe("T19 DO chains — TTL park, revival, kill", () => {
  test("idle child parks via the DO alarm; ref + transcript stay readable", async () => {
    const parentThreadId = newThreadId();
    const { rig, plan } = await spawnSettledChild(parentThreadId, {
      taskAgentIdleTtlMs: 700,
    });
    const childThreadId = plan.data.childThreadId;

    // The child DO's own alarm lands the park row (local DO state write).
    // vitest-pool-workers never triggers DO alarms, so the test drives the
    // same maintenance tick the alarm handler calls, with a now past the
    // armed deadline (fold-fresh; the guard re-checks state — no sleeps).
    // The TTL is a per-DO config (the child reads its own watchdog patch).
    await childStubOf(childThreadId).configureWatchdog({ taskAgentIdleTtlMs: 700 });
    const swept = await childStubOf(childThreadId).sweepLifecycle(Date.now() + 60_000);
    expect(swept.parked).toBe(true);
    const childEvents = await childEventsOf(childThreadId);
    const parked = childEvents.find((event) => event.type === "task.subagent_parked");
    if (parked?.type !== "task.subagent_parked") throw new Error("unreachable");
    expect(parked.data.agentId).toBe("Task-1");

    // Parked is still readable: history:// serves from the journal (T17 face).
    const history = await childStubOf(childThreadId).readAgentArtifact({
      agentId: "Task-1",
      kind: "history",
    });
    expect(history.output).toContain("parked");

    // The fold refolds identically after the row (replay consistency).
    const view = projectLifecycle(childEvents);
    const first = view.record("Task-1");
    const second = projectLifecycle(await childEventsOf(childThreadId)).record("Task-1");
    expect(second).toEqual(first);
    expect(second).toMatchObject({ state: "parked", sessionReleased: true });

    // Main never parks: the parent journal carries no park rows at all.
    const parentJournal = await rig.events();
    expect(parentJournal.some((event) => event.type === "task.subagent_parked")).toBe(false);
    expect(() => replayEvents(childEvents)).not.toThrow();
    expect(() => replayEvents(parentJournal)).not.toThrow();
  });

  test("TTL ≤0 disables parking — an idle child stays idle", async () => {
    const parentThreadId = newThreadId();
    const { plan } = await spawnSettledChild(parentThreadId, { taskAgentIdleTtlMs: 0 });
    // ≤0 disables parking outright: even a sweep from far future parks
    // nothing (computeParkDeadline refuses before the deadline math).
    await childStubOf(plan.data.childThreadId).configureWatchdog({ taskAgentIdleTtlMs: 0 });
    const swept = await childStubOf(plan.data.childThreadId).sweepLifecycle(Date.now() + 3_600_000);
    expect(swept.parked).toBe(false);
    const childEvents = await childEventsOf(plan.data.childThreadId);
    expect(childEvents.some((event) => event.type === "task.subagent_parked")).toBe(false);
    expect(projectLifecycle(childEvents).record("Task-1")).toMatchObject({ state: "idle" });
  });

  test("write agent://<parked> revives with a `revived` receipt and a follow-up turn", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: SPAWN_ARGS }] },
      { deltas: ["spawned"] },
    ]);
    const childMock = new MockModelProvider([
      { toolCalls: [{ name: "yield", arguments: { data: { answer: 42 } } }] },
      { deltas: ["status fine, nothing new"] },
    ]);
    setAgentRuntime(parentThreadId, mockAgentRuntime(parentMock));
    setAgentRuntime("*", mockAgentRuntime(childMock));
    const rig = await createRig({
      threadId: parentThreadId,
      provider: parentMock,
      watchdog: { taskAgentIdleTtlMs: 700 },
    });
    const first = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "spawn a worker" }],
      mode: "start",
    });
    const plan = await planRowOf(rig);
    await rig.waitFor((all) => all.some((event) => event.type === "task.async_result"));
    await rig.waitTurnComplete(first.turnId);
    const childThreadId = plan.data.childThreadId;
    // Park first (same maintenance tick the alarm would fire — see the park
    // test); revival needs a PARKED recipient.
    await childStubOf(childThreadId).configureWatchdog({ taskAgentIdleTtlMs: 700 });
    const swept = await childStubOf(childThreadId).sweepLifecycle(Date.now() + 60_000);
    expect(swept.parked).toBe(true);

    // Follow-up through the agent:// write face.
    parentMock.turns.push(
      {
        toolCalls: [
          {
            name: "write",
            arguments: { path: "agent://Task-1", content: "any progress since?" },
          },
        ],
      },
      { deltas: ["asked"] },
    );
    const second = await rig.stub.sendMessage({
      clientRequestId: "in-2",
      content: [{ type: "text", text: "follow up with the worker" }],
      mode: "start",
    });
    const written = await rig.waitFor((all) =>
      all.some(
        (event) =>
          event.type === "tool.result" &&
          event.data.executionId.startsWith(`${parentThreadId}:`) &&
          typeof event.data.output === "string" &&
          event.data.output.includes("revived"),
      ),
    );
    const writeResult = written.find(
      (event) =>
        event.type === "tool.result" &&
        typeof event.data.output === "string" &&
        event.data.output.includes("revived"),
    );
    if (writeResult?.type !== "tool.result") throw new Error("unreachable");
    expect(writeResult.data.output).toContain("Task-1");
    await rig.waitTurnComplete(second.turnId);

    // The child journaled the revival receipt and drove a follow-up turn
    // rebuilt on the SAME transcript (identity + first-run yield still fold).
    const childEvents = await childEventsOf(childThreadId);
    const revived = childEvents.find((event) => event.type === "task.subagent_revived");
    if (revived?.type !== "task.subagent_revived") throw new Error("no revival row");
    expect(revived.data).toMatchObject({ agentId: "Task-1", from: "Main" });
    const followUp = childEvents.find(
      (event) => event.type === "turn.input" && event.data.inputId.startsWith("followup-"),
    );
    if (followUp?.type !== "turn.input") throw new Error("no follow-up turn");
    expect(followUp.data.content[0]?.type === "text" && followUp.data.content[0].text).toBe(
      "Main: any progress since?",
    );
    const gate = projectChildRun(childEvents);
    expect(gate.identity?.agentId).toBe("Task-1");
    expect(gate.completed).toBeDefined();

    // No re-delivery: the run closed at the first receipt — exactly one
    // async-result row even after the follow-up turn.
    const parentEvents = await rig.events();
    expect(parentEvents.filter((event) => event.type === "task.async_result")).toHaveLength(1);
    expect(projectLifecycle(childEvents).record("Task-1")).toMatchObject({
      state: "idle",
      sessionReleased: false,
    });
    expect(() => replayEvents(childEvents)).not.toThrow();
    expect(() => replayEvents(parentEvents)).not.toThrow();
  });

  test("proc:// kill: tombstone both sides, waiters settle cancelled, kill is idempotent", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: SPAWN_ARGS }] },
      { deltas: ["spawned"] },
    ]);
    // The child hangs mid-run: the kill must abort the live session.
    const childMock = new MockModelProvider([{ hang: true }, { deltas: ["unused"] }]);
    setAgentRuntime(parentThreadId, mockAgentRuntime(parentMock));
    setAgentRuntime("*", mockAgentRuntime(childMock));
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });
    const first = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "spawn a worker" }],
      mode: "start",
    });
    const plan = await planRowOf(rig);
    const jobId = plan.data.jobId;
    expect(jobId).not.toBeNull();
    const childThreadId = plan.data.childThreadId;
    // The child turn is live (hung) before the kill lands.
    await waitForChildEvent(childThreadId, "model.call_started");
    await rig.waitTurnComplete(first.turnId);

    // Turn 2: a wait on the job + the kill in the same tool batch — the
    // blocked wait must wake with the cancelled settlement (photo-finish,
    // cancel-entry-1 cooperation with T2).
    parentMock.turns.push(
      {
        toolCalls: [
          { name: "wait", arguments: {} },
          { name: "write", arguments: { path: `proc://${jobId}/kill` } },
        ],
      },
      { deltas: ["done killing"] },
    );
    const second = await rig.stub.sendMessage({
      clientRequestId: "in-2",
      content: [{ type: "text", text: "kill the worker" }],
      mode: "start",
    });
    await waitForChildEvent(childThreadId, "task.subagent_aborted");
    await rig.waitFor((all) =>
      all.some(
        (event) =>
          event.type === "job.settled" &&
          event.data.status === "cancelled",
      ),
    );
    await rig.waitTurnComplete(second.turnId);

    const parentEvents = await rig.events();
    const childEvents = await childEventsOf(childThreadId);
    // Tombstones on BOTH journals, exactly one each.
    expect(parentEvents.filter((event) => event.type === "task.subagent_aborted")).toHaveLength(1);
    expect(childEvents.filter((event) => event.type === "task.subagent_aborted")).toHaveLength(1);
    // The child's live session released: the hung call aborted, turn cancelled.
    expect(childEvents.some((event) => event.type === "turn.cancelled")).toBe(true);
    expect(childEvents.some((event) => event.type === "turn.failed")).toBe(false);
    // The killed run delivered NOTHING — no settlement, no async-result.
    expect(parentEvents.some((event) => event.type === "task.spawn_settled")).toBe(false);
    expect(parentEvents.some((event) => event.type === "task.async_result")).toBe(false);
    // The blocked wait woke with the cancelled job.
    const waitResult = parentEvents.find(
      (event) =>
        event.type === "tool.result" &&
        event.data.executionId === `${parentThreadId}:${parentEvents.find(
          (candidate) => candidate.type === "tool.call" && candidate.data.tool === "wait",
        )?.seq}`,
    );
    if (waitResult?.type !== "tool.result") throw new Error("wait never returned");
    expect(typeof waitResult.data.output === "string" && waitResult.data.output).toContain(
      "cancelled",
    );

    // kill 幂等: a second kill answers a receipt and appends nothing.
    parentMock.turns.push(
      { toolCalls: [{ name: "write", arguments: { path: `proc://${jobId}/kill` } }] },
      { deltas: ["done"] },
    );
    const third = await rig.stub.sendMessage({
      clientRequestId: "in-3",
      content: [{ type: "text", text: "kill again" }],
      mode: "start",
    });
    await rig.waitFor((all) =>
      all.some(
        (event) =>
          event.type === "tool.result" &&
          typeof event.data.output === "string" &&
          event.data.output.includes("kill is a no-op"),
      ),
    );
    await rig.waitTurnComplete(third.turnId);
    const after = await rig.events();
    expect(after.filter((event) => event.type === "task.subagent_aborted")).toHaveLength(1);
    expect(after.filter((event) => event.type === "job.settled")).toHaveLength(1);

    // Tombstone resistance: a late child completion confirms only.
    const late = await rig.stub.completeSubagent({
      spawnId: plan.data.spawnId,
      agentId: plan.data.agentId,
      status: "ok",
      output: "late completion after kill",
    });
    expect(late.duplicated).toBe(true);
    const final = await rig.events();
    expect(final.some((event) => event.type === "task.spawn_settled")).toBe(false);
    expect(final.filter((event) => event.type === "task.subagent_aborted")).toHaveLength(1);
    expect(projectLifecycle(final).record("Task-1")).toMatchObject({
      state: "aborted",
      abortReason: "kill",
    });
    expect(() => replayEvents(final)).not.toThrow();
    expect(() => replayEvents(childEvents)).not.toThrow();
  });

  test("parent call signal detaches: a cancelled call leaves the background child running", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: SPAWN_ARGS }] },
      // The parent turn stays LIVE after the spawn registers (hung second
      // call), so the cancelTurn below actually lands on a live turn.
      { hang: true },
    ]);
    // The child yields normally: the detached run completes on its own.
    const childMock = new MockModelProvider([
      { toolCalls: [{ name: "yield", arguments: { data: { late: true } } }] },
      { deltas: ["done"] },
    ]);
    setAgentRuntime(parentThreadId, mockAgentRuntime(parentMock));
    setAgentRuntime("*", mockAgentRuntime(childMock));
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "spawn a worker" }],
      mode: "start",
    });
    await planRowOf(rig);
    // Cancel the parent turn; the background child is detached.
    await rig.stub.cancelTurn({ turnId: sent.turnId });
    await rig.waitTurnComplete(sent.turnId);
    // The child still completes and the async-result still backflows.
    await rig.waitFor((all) => all.some((event) => event.type === "task.async_result"));
    const parentEvents = await rig.events();
    expect(parentEvents.some((event) => event.type === "turn.cancelled")).toBe(true);
    expect(parentEvents.filter((event) => event.type === "task.async_result")).toHaveLength(1);
    expect(() => replayEvents(parentEvents)).not.toThrow();
  });
});
