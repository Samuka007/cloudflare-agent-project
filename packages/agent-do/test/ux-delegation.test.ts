import { describe, expect, test } from "vitest";
import { parseThreadEvent, type TypedThreadEvent } from "@cap/protocol";
import { parseAgentEvent, type AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import { projectToUxEvents } from "../src/ux-projection.js";

/**
 * #275 J2+J3 — task.* journal family → delegation-row ux projection:
 * the synthetic toolCall{spawnAgent} row (#229 S1+S3), the thread-scoped
 * backgroundTask family (bb same-name-same-shape), transport folding
 * (#229 §2.3-1), generational item ids, and the 500ms progress throttle.
 * Pure journal-fold tests: every fixture is a synthetic raw row, so the
 * replay-stability assertions run on the exact projection the server seam
 * serves.
 */

const THREAD = "thr_parent";
const CHILD = "thr_child_1";
const TURN = "turn_1";
/**
 * Foreign-anchor literal for child-journal fixtures (the parent-side call id
 * a child's identity row mirrors).
 */
const PARENT_CALL_ID = `${THREAD}:10`;
/**
 * Bare task-call executionId, derived from the journaled seq exactly like
 * the DO does (executionIdFor = `${threadId}:${seq}`) — set by taskCall().
 */
let CALL_ID = "";

let seqCounter = 0;

function row(type: AnyAgentEvent["type"], data: unknown, createdAt = 1_000): AnyAgentEvent {
  seqCounter += 1;
  return parseAgentEvent({
    threadId: THREAD,
    seq: seqCounter,
    id: `evt-${seqCounter}`,
    type,
    data,
    createdAt,
  });
}

function taskCall(createdAt = 1_000): AnyAgentEvent {
  const call = row(
    "tool.call",
    {
      turnId: TURN,
      modelCallId: 1,
      tool: "task",
      arguments: { task: "x" },
      timeoutMs: 600_000,
    },
    createdAt,
  );
  CALL_ID = executionIdFor(THREAD, call.seq);
  return call;
}

function spawnPlanned(overrides?: {
  executionId?: string;
  mode?: "blocking" | "background";
  jobId?: string | null;
  /** Explicit undefined = pre-J1 journal (no attribution anchor). */
  parentToolCallId?: string;
}): AnyAgentEvent {
  return row("task.spawn_planned", {
    executionId: overrides?.executionId ?? CALL_ID,
    spawnId: "sp_1",
    agentId: "task-1",
    agent: "scout",
    childThreadId: CHILD,
    parentThreadId: THREAD,
    machineId: "mach_1",
    mode: overrides?.mode ?? "background",
    jobId: overrides?.jobId ?? "job_1",
    task: "Report the answer",
    solutionSpace: "",
    parentToolCallId:
      overrides && "parentToolCallId" in overrides ? overrides.parentToolCallId : CALL_ID,
    depth: 1,
  });
}

function spawnSettled(overrides?: {
  spawnId?: string;
  jobId?: string | null;
  status?: "ok" | "error";
  output?: string;
}): AnyAgentEvent {
  return row("task.spawn_settled", {
    spawnId: overrides?.spawnId ?? "sp_1",
    jobId: overrides?.jobId ?? "job_1",
    agentId: "task-1",
    childThreadId: CHILD,
    status: overrides?.status ?? "ok",
    output: overrides?.output ?? "42",
  });
}

function taskResult(
  status: "ok" | "cancelled" | "outcome_unknown",
  createdAt = 1_000,
): AnyAgentEvent {
  return row(
    "tool.result",
    { turnId: TURN, executionId: CALL_ID, status, exitCode: null, output: "receipt" },
    createdAt,
  );
}

describe("#275 J2 — background spawn projects the spawnAgent delegation row", () => {
  test("transport task call folds; one synthetic delegation row carries the badge data", () => {
    const ux = projectToUxEvents([taskCall(), spawnPlanned(), spawnSettled()]).map(
      parseThreadEvent,
    );

    // Transport folding: the native task toolCall never reaches the ux face.
    const toolRows = ux.filter(
      (event) =>
        (event.type === "item/started" || event.type === "item/completed") &&
        event.data.item.type === "toolCall" &&
        event.data.item.tool === "task",
    );
    expect(toolRows).toHaveLength(0);

    const started = ux.find(
      (event): event is Extract<TypedThreadEvent, { type: "item/started" }> =>
        event.type === "item/started",
    );
    expect(started).toBeDefined();
    if (started?.type !== "item/started") throw new Error("unreachable");
    expect(started.data.turnId).toBe(TURN);
    const item = started.data.item;
    if (item.type !== "toolCall") throw new Error("delegation row must be a toolCall item");
    expect(item).toMatchObject({
      id: CALL_ID,
      tool: "spawnAgent",
      status: "pending",
      arguments: {
        senderThreadId: THREAD,
        receiverThreadIds: [CHILD],
        description: "Report the answer",
        subagent_type: "scout",
      },
    });

    // Background terminal rides the thread-scoped family: no turnId in the
    // payload (bb threadScope ruling), generational id, subagent badge join.
    const completed = ux.find(
      (event): event is Extract<TypedThreadEvent, { type: "item/backgroundTask/completed" }> =>
        event.type === "item/backgroundTask/completed",
    );
    expect(completed).toBeDefined();
    if (completed?.type !== "item/backgroundTask/completed") throw new Error("unreachable");
    expect(completed.data).not.toHaveProperty("turnId");
    expect(completed.data.item).toMatchObject({
      id: "task:sp_1#0",
      taskType: "local_subagent",
      description: "Report the answer",
      status: "completed",
      taskStatus: "completed",
      summary: "42",
      skipTranscript: false,
      parentToolCallId: CALL_ID,
    });

    // No turn-scoped item/completed for the background row (the family owns
    // the terminal — a closed turn must not be appended into).
    const turnScopedCompletions = ux.filter(
      (event) =>
        event.type === "item/completed" &&
        event.data.item.type === "toolCall" &&
        event.data.item.tool === "spawnAgent",
    );
    expect(turnScopedCompletions).toHaveLength(0);
  });

  test("background registration receipt (tool.result ok) projects nothing", () => {
    const ux = projectToUxEvents([taskCall(), spawnPlanned(), taskResult("ok")]).map(
      parseThreadEvent,
    );
    expect(ux.filter((event) => event.type === "item/completed")).toHaveLength(0);
  });

  test("blocking spawn settles turn-scoped with the delivery output", () => {
    const settle = spawnSettled({ jobId: null, status: "ok", output: "blocking answer" });
    const ux = projectToUxEvents([
      taskCall(),
      spawnPlanned({ mode: "blocking", jobId: null }),
      settle,
    ]).map(parseThreadEvent);
    const completed = ux.find(
      (event): event is Extract<TypedThreadEvent, { type: "item/completed" }> =>
        event.type === "item/completed",
    );
    expect(completed).toBeDefined();
    if (completed?.type !== "item/completed") throw new Error("unreachable");
    expect(completed.data.turnId).toBe(TURN);
    const item = completed.data.item;
    if (item.type !== "toolCall") throw new Error("unreachable");
    expect(item).toMatchObject({
      id: CALL_ID,
      tool: "spawnAgent",
      status: "completed",
      output: "blocking answer",
    });
    expect(ux.filter((event) => event.type.startsWith("item/backgroundTask"))).toHaveLength(0);
  });

  test("error settle lands failed", () => {
    const ux = projectToUxEvents([
      taskCall(),
      spawnPlanned(),
      spawnSettled({ status: "error", output: "child blew up" }),
    ]).map(parseThreadEvent);
    const completed = ux.find(
      (event): event is Extract<TypedThreadEvent, { type: "item/backgroundTask/completed" }> =>
        event.type === "item/backgroundTask/completed",
    );
    if (completed?.type !== "item/backgroundTask/completed") throw new Error("no terminal");
    expect(completed.data.item.status).toBe("failed");
    expect(completed.data.item.error).toBe("child blew up");
  });

  test("cancelled task call (no settle row) seals the delegation row interrupted", () => {
    const ux = projectToUxEvents([taskCall(), spawnPlanned(), taskResult("outcome_unknown")]).map(
      parseThreadEvent,
    );
    const completed = ux.find(
      (event): event is Extract<TypedThreadEvent, { type: "item/completed" }> =>
        event.type === "item/completed",
    );
    expect(completed).toBeDefined();
    if (completed?.type !== "item/completed") throw new Error("no cancel seal");
    const item = completed.data.item;
    if (item.type !== "toolCall") throw new Error("unreachable");
    expect(item.status).toBe("interrupted");
  });
});

describe("#275 J2 — abort semantics", () => {
  test("kill tombstone lands interrupted once; a racing settle confirms, never flips", () => {
    const abort = row("task.subagent_aborted", {
      spawnId: "sp_1",
      agentId: "task-1",
      reason: "kill",
    });
    const lateSettle = spawnSettled({ status: "ok", output: "raced the kill" });
    const ux = projectToUxEvents([taskCall(), spawnPlanned(), abort, lateSettle]).map(
      parseThreadEvent,
    );
    const terminals = ux.filter(
      (event) => event.type === "item/backgroundTask/completed" || event.type === "item/completed",
    );
    expect(terminals).toHaveLength(1);
    const only = terminals[0];
    if (only?.type !== "item/backgroundTask/completed") throw new Error("expected family terminal");
    expect(only.data.item.status).toBe("interrupted");
    expect(only.data.item.taskStatus).toBe("stopped");
  });

  test("budget abort is revivable — the row stays pending (no terminal)", () => {
    const abort = row("task.subagent_aborted", {
      spawnId: "sp_1",
      agentId: "task-1",
      reason: "budget",
    });
    const ux = projectToUxEvents([taskCall(), spawnPlanned(), abort]).map(parseThreadEvent);
    expect(ux.map((event) => event.type)).toEqual(["item/started"]);
  });
});

describe("#275 J3 — thread-scoped progress family", () => {
  test("parked/revived project paused/running progress with the 500ms throttle", () => {
    const parked = row("task.subagent_parked", { spawnId: "sp_1", agentId: "task-1" }, 2_000);
    const revivedFast = row(
      "task.subagent_revived",
      { spawnId: "sp_1", agentId: "task-1", inputId: "revive-m1", from: "main" },
      2_100, // < 500ms after the parked row — throttled away
    );
    const parkedAgain = row("task.subagent_parked", { spawnId: "sp_1", agentId: "task-1" }, 3_000);
    const ux = projectToUxEvents([
      taskCall(),
      spawnPlanned(),
      parked,
      revivedFast,
      parkedAgain,
    ]).map(parseThreadEvent);
    const progress = ux.filter(
      (event): event is Extract<TypedThreadEvent, { type: "item/backgroundTask/progress" }> =>
        event.type === "item/backgroundTask/progress",
    );
    expect(progress).toHaveLength(2);
    const [first, second] = progress;
    expect(first?.data.item.taskStatus).toBe("paused");
    expect(first?.data.item.status).toBe("pending");
    expect(first?.data).not.toHaveProperty("turnId");
    expect(second?.data.item.taskStatus).toBe("paused");
  });

  test("child-journal identity anchors parked/revived to the parent delegation row", () => {
    // Child face: no spawn_planned, but the mirrored identity row carries the
    // attribution anchor — the child's lifecycle rows join the PARENT row.
    const identity = row("task.subagent_identity", {
      spawnId: "sp_1",
      agentId: "task-1",
      parentThreadId: THREAD,
      sourceThreadId: null,
      originKind: null,
      depth: 1,
      parentToolCallId: PARENT_CALL_ID,
    });
    const parked = row("task.subagent_parked", { spawnId: "sp_1", agentId: "task-1" }, 5_000);
    const childUx = projectToUxEvents([identity, parked]).map(parseThreadEvent);
    const progress = childUx.find(
      (event): event is Extract<TypedThreadEvent, { type: "item/backgroundTask/progress" }> =>
        event.type === "item/backgroundTask/progress",
    );
    expect(progress).toBeDefined();
    if (progress?.type !== "item/backgroundTask/progress") throw new Error("unreachable");
    expect(progress.data.item.parentToolCallId).toBe(PARENT_CALL_ID);
    expect(progress.data.item.taskStatus).toBe("paused");
  });
});

describe("#275 J2 — replay and compatibility", () => {
  test("batch spawns project one delegation row per item under the shared anchor", () => {
    const call = taskCall();
    const planned0 = spawnPlanned({ executionId: `${CALL_ID}#0` });
    const planned1 = row("task.spawn_planned", {
      ...spawnPlanned({ executionId: `${CALL_ID}#1` }).data,
      spawnId: "sp_2",
      agentId: "task-2",
      childThreadId: "thr_child_2",
    });
    const settle0 = spawnSettled({ spawnId: "sp_1", output: "first" });
    const settle1 = spawnSettled({ spawnId: "sp_2", output: "second" });
    const ux = projectToUxEvents([call, planned0, planned1, settle0, settle1]).map(
      parseThreadEvent,
    );
    const rows = ux.filter(
      (event): event is Extract<TypedThreadEvent, { type: "item/started" }> =>
        event.type === "item/started",
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.map((event) => (event.data.item.type === "toolCall" ? event.data.item.id : "")),
    ).toEqual([`${CALL_ID}#0`, `${CALL_ID}#1`]);
    const terminals = ux.filter(
      (event): event is Extract<TypedThreadEvent, { type: "item/backgroundTask/completed" }> =>
        event.type === "item/backgroundTask/completed",
    );
    expect(terminals).toHaveLength(2);
    expect(terminals.map((event) => event.data.item.id)).toEqual(["task:sp_1#0", "task:sp_2#0"]);
  });

  test("pre-J1 journals (no parentToolCallId) keep their old face — no delegation row", () => {
    const legacyPlan = row("task.spawn_planned", {
      ...spawnPlanned().data,
      parentToolCallId: undefined,
    });
    const legacySettle = row("task.spawn_settled", {
      ...spawnSettled().data,
      parentToolCallId: undefined,
    });
    const ux = projectToUxEvents([taskCall(), legacyPlan, legacySettle]).map(parseThreadEvent);
    expect(ux).toHaveLength(0);
  });

  test("full re-projection is identical — reload neither loses nor duplicates rows", () => {
    const journal = [
      taskCall(),
      spawnPlanned(),
      row("task.subagent_parked", { spawnId: "sp_1", agentId: "task-1" }, 2_000),
      spawnSettled({ output: "done" }),
    ];
    const first = projectToUxEvents(journal);
    const second = projectToUxEvents(journal);
    expect(second).toEqual(first);
    // And the typed re-parse matches envelope-for-envelope (I3 on the ux view).
    expect(second.map(parseThreadEvent)).toEqual(first.map(parseThreadEvent));
  });
});
