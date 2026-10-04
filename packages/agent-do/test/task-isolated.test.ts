import { afterEach, describe, expect, test, vi, type Mock } from "vitest";
import { newThreadId } from "@cap/protocol";
import { createRig, resetRuntime, type Rig } from "./helpers.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { replayEvents } from "../src/turn-state.js";
import { setAgentRuntime } from "../src/injection.js";
import { MockModelProvider } from "../src/testing/mock-provider.js";
import { setAgentDefinitions, BUNDLED_AGENT_DEFINITIONS } from "../src/tools/task/types.js";
import type { IsolationOpOutcome } from "../src/daemon.js";
import type { TaskToolContext, ValidatedSpawnParams } from "../src/tools/task/executor.js";
import {
  DEFAULT_TASK_TOOL_CONFIG,
  isolationRetainedNote,
  parseIsolationPrepare,
  runTaskTool,
} from "../src/tools/task/executor.js";

/**
 * M1.5 T20 L1 (#110) — `task.isolated` across the seam:
 *   - end-to-end over the REAL seam (AgentDO → DAEMON_SERVICE binding → the
 *     reference fake's isolationOp echo): background/keep-alive spawn retains
 *     the workspace (retention note in the settlement row), blocking spawn
 *     releases at settle and folds the release outcome into the settlement,
 *     host-offline prepare fails before the child is ever driven;
 *   - executor-level units over a fake seam: prepare failure journals no plan
 *     row and never creates the child; bring-up failure after prepare
 *     releases the just-prepared workspace (omp failed-startup cleanup).
 */

interface FakeJournalRow {
  op: string;
  isolationOp?: string;
}

async function driveParentTurn(rig: Rig, inputId: string): Promise<string> {
  const sent = await rig.stub.sendMessage({
    clientRequestId: inputId,
    content: [{ type: "text", text: "spawn a worker" }],
    mode: "start",
  });
  return sent.turnId;
}

afterEach(() => {
  resetRuntime();
  setAgentDefinitions(BUNDLED_AGENT_DEFINITIONS);
});

const PARENT_TASK_ARGS = {
  task: "Work in an isolated copy.",
  solutionSpace: "one fix: rename, names given",
  isolated: true,
};

describe("M1.5 T20 — isolated spawn over the real daemon seam", () => {
  test("background isolated spawn: prepare → plan row carries isolation → keep-alive retention note", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: PARENT_TASK_ARGS }] },
      { deltas: ["spawned"] },
    ]);
    const childMock = new MockModelProvider([
      { toolCalls: [{ name: "yield", arguments: { data: { done: true } } }] },
      { deltas: ["submitted"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    const turnId = await driveParentTurn(rig, "in-1");
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_settled"));
    await rig.waitTurnComplete(turnId);

    const events = await rig.events();
    const plan = events.find((event) => event.type === "task.spawn_planned");
    if (plan?.type !== "task.spawn_planned") throw new Error("no plan row");
    // The prepare outcome rides the plan row (JSON-encoded isolation info).
    const isolationJson = plan.data.isolationJson;
    if (typeof isolationJson !== "string") throw new Error("plan row carries no isolation info");
    const isolation = JSON.parse(isolationJson) as {
      workspaceDir: string;
      backend: string;
      mergeMode: string;
      applyGate: boolean;
    };
    expect(isolation.workspaceDir).toContain("/tmp/fake-isolation/Task-1");
    expect(isolation.mergeMode).toBe("patch");
    expect(isolation.applyGate).toBe(true);

    // Keep-alive (background): settled with the retained-workspace note.
    const settled = events.find((event) => event.type === "task.spawn_settled");
    if (settled?.type !== "task.spawn_settled") throw new Error("no settlement row");
    expect(settled.data.status).toBe("ok");
    expect(settled.data.output).toContain(
      "isolated workspace retained at /tmp/fake-isolation/Task-1",
    );
    expect(settled.data.output).toContain("write agent://<id>");

    // The prepare RPC audited on the service journal; release NEVER ran
    // (keep-alive: only an explicit release captures-merges).
    const serviceJournal = (await Promise.resolve(rig.service.journal())) as FakeJournalRow[];
    expect(
      serviceJournal.filter(
        (entry) => entry.op === "isolation_op" && entry.isolationOp === "prepare",
      ),
    ).toHaveLength(1);
    expect(
      serviceJournal.filter(
        (entry) => entry.op === "isolation_op" && entry.isolationOp === "release",
      ),
    ).toHaveLength(0);

    expect(() => replayEvents(events)).not.toThrow();
  });

  test("blocking isolated spawn: release rides the settlement (one-shot capture-merge at run end)", async () => {
    setAgentDefinitions([{ name: "scout", blocking: true }]);
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      {
        toolCalls: [
          { name: "task", arguments: { ...PARENT_TASK_ARGS, agent: "scout", name: "Scout" } },
        ],
      },
      { deltas: ["inline done"] },
    ]);
    const childMock = new MockModelProvider([
      { toolCalls: [{ name: "yield", arguments: { data: "findings" } }] },
      { deltas: ["ok"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    const turnId = await driveParentTurn(rig, "in-1");
    await rig.waitFor((all) =>
      all.some(
        (event) =>
          event.type === "tool.result" &&
          typeof event.data.output === "string" &&
          event.data.output.includes("Task Scout (scout) completed."),
      ),
    );
    await rig.waitTurnComplete(turnId);

    const events = await rig.events();
    const settled = events.find((event) => event.type === "task.spawn_settled");
    if (settled?.type !== "task.spawn_settled") throw new Error("no settlement row");
    // The release outcome ("No changes to apply. (child …)") is folded into
    // the settlement the blocking caller wakes on.
    expect(settled.data.output).toContain("No changes to apply.");
    const serviceJournal = (await Promise.resolve(rig.service.journal())) as FakeJournalRow[];
    expect(
      serviceJournal.filter(
        (entry) => entry.op === "isolation_op" && entry.isolationOp === "release",
      ),
    ).toHaveLength(1);
    expect(() => replayEvents(events)).not.toThrow();
  });

  test("prepare failure (host offline) fails BEFORE the child is driven; no plan row", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: PARENT_TASK_ARGS }] },
      { deltas: ["ack"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });
    await rig.service.setHostOnline(false);

    const turnId = await driveParentTurn(rig, "in-1");
    // A failed prepare is an error TOOL RESULT (the child was never planned
    // nor driven — there is no settlement row to wait for).
    await rig.waitFor((all) =>
      all.some(
        (event) =>
          event.type === "tool.result" &&
          typeof event.data.output === "string" &&
          event.data.output.includes("isolation prepare failed"),
      ),
    );
    await rig.waitTurnComplete(turnId);

    const events = await rig.events();
    expect(events.some((event) => event.type === "task.spawn_planned")).toBe(false);
    const taskResult = events.find(
      (event) =>
        event.type === "tool.result" &&
        typeof event.data.output === "string" &&
        event.data.output.includes("isolation prepare failed"),
    );
    if (taskResult?.type !== "tool.result") throw new Error("no prepare-failure tool result");
    expect(taskResult.data.output).toContain("host offline");
  });
});

// ---------------------------------------------------------------------------
// Executor-level units over a fake seam (no DO) — failure-path matrix.
// ---------------------------------------------------------------------------

interface FakeSeam {
  calls: { op: "prepare" | "release"; arguments: Record<string, unknown> }[];
  prepareOutcome: "ok" | "error" | "host_offline";
}

interface FakeHarness {
  context: TaskToolContext;
  createThread: Mock;
  runSubagent: Mock;
}

function isolationOpFor(
  seam: FakeSeam,
): (request: {
  machineId: string;
  threadId: string;
  op: "prepare" | "release";
  arguments: Record<string, unknown>;
  timeoutMs: number;
}) => Promise<IsolationOpOutcome> {
  return (request) => {
    seam.calls.push({ op: request.op, arguments: request.arguments });
    if (request.op === "release") {
      return Promise.resolve({
        kind: "ok",
        result: { status: "ok", exitCode: 0, output: "Merged branch: omp/task/Task-1" },
      });
    }
    if (seam.prepareOutcome === "host_offline") return Promise.resolve({ kind: "host_offline" });
    if (seam.prepareOutcome === "error") {
      return Promise.resolve({
        kind: "error",
        error:
          "Working tree carries 2 GiB of uncommitted content, over the 1 GiB isolation-snapshot budget",
      });
    }
    return Promise.resolve({
      kind: "ok",
      result: {
        status: "ok",
        exitCode: 0,
        output: JSON.stringify({
          workspaceDir: "/tmp/fake-isolation/Task-1",
          backend: "rcopy",
          fellBack: true,
          fallbackReason: "no fuse",
          mergeMode: "patch",
          applyGate: true,
        }),
      },
    });
  };
}

function fakeContext(events: AnyAgentEvent[], seam: FakeSeam): FakeHarness {
  const createThread: Mock = vi.fn((request: { threadId: string }) =>
    Promise.resolve({ threadId: request.threadId, duplicated: false }),
  );
  const runSubagent: Mock = vi.fn(() => Promise.resolve({ turnId: "t-child", duplicated: false }));
  const context: TaskToolContext = {
    executionId: "th-p:5",
    turnId: "t1",
    threadId: "th-p",
    machineId: "th-p",
    depth: 0,
    parentAgentId: undefined,
    events: () => Promise.resolve(events),
    recordSpawnPlan: () => Promise.resolve(),
    recordSpawnSettlement: () => Promise.resolve(),
    registry: { register: () => Promise.resolve(), settle: () => Promise.resolve() },
    subagentHost: { createThread, runSubagent },
    isolationOp: isolationOpFor(seam),
    wake: () => Promise.resolve("cancelled" as const),
    config: DEFAULT_TASK_TOOL_CONFIG,
  };
  return { context, createThread, runSubagent };
}

const BASE_PARAMS: ValidatedSpawnParams = {
  task: "Work isolated",
  solutionSpace: "one fix",
  isolated: true,
};

describe("M1.5 T20 — executor isolation units", () => {
  test("prepare success precedes the plan row and the child; the payload parses", async () => {
    const seam: FakeSeam = { calls: [], prepareOutcome: "ok" };
    const { context, createThread } = fakeContext([], seam);
    const result = await runTaskTool(BASE_PARAMS, context);
    expect(result.status).toBe("ok");
    expect(seam.calls.map((call) => call.op)).toEqual(["prepare"]);
    expect(seam.calls[0]?.arguments.agentId).toBe("Task-1");
    expect(typeof seam.calls[0]?.arguments.threadId).toBe("string");
    expect(createThread).toHaveBeenCalledTimes(1);
    const info = parseIsolationPrepare(
      JSON.stringify({
        workspaceDir: "/tmp/w",
        backend: "overlayfs",
        fellBack: false,
        fallbackReason: null,
        mergeMode: "patch",
        applyGate: true,
      }),
    );
    expect(info.workspaceDir).toBe("/tmp/w");
  });

  test("prepare failure settles failed without any child DO call", async () => {
    const seam: FakeSeam = { calls: [], prepareOutcome: "error" };
    const { context, createThread, runSubagent } = fakeContext([], seam);
    const result = await runTaskTool(BASE_PARAMS, context);
    expect(result.status).toBe("error");
    expect(result.output).toContain("isolation prepare failed");
    expect(result.output).toContain("isolation-snapshot budget");
    expect(createThread).not.toHaveBeenCalled();
    expect(runSubagent).not.toHaveBeenCalled();
    expect(seam.calls).toHaveLength(1);
  });

  test("host-offline prepare fails loudly with the offline detail", async () => {
    const seam: FakeSeam = { calls: [], prepareOutcome: "host_offline" };
    const { context, createThread } = fakeContext([], seam);
    const result = await runTaskTool(BASE_PARAMS, context);
    expect(result.status).toBe("error");
    expect(result.output).toContain("daemon host offline");
    expect(createThread).not.toHaveBeenCalled();
  });

  test("bring-up failure after prepare releases the just-prepared workspace", async () => {
    const seam: FakeSeam = { calls: [], prepareOutcome: "ok" };
    const { context, createThread, runSubagent } = fakeContext([], seam);
    runSubagent.mockRejectedValueOnce(new Error("child DO unreachable"));
    const result = await runTaskTool(BASE_PARAMS, context);
    expect(result.status).toBe("error");
    expect(result.output).toContain("child DO unreachable");
    // The child DID get created — the failure is the drive, not the bring-up.
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(seam.calls.map((call) => call.op)).toEqual(["prepare", "release"]);
    expect(seam.calls[1]?.arguments.threadId).toBe(seam.calls[0]?.arguments.threadId);
  });

  test("the retention note names the workspace and the gate-dependent fate", () => {
    const open = isolationRetainedNote({ workspaceDir: "/tmp/w", applyGate: true });
    expect(open).toContain("/tmp/w");
    expect(open).toContain("explicit release captures and merges");
    const closed = isolationRetainedNote({ workspaceDir: "/tmp/w", applyGate: false });
    expect(closed).toContain("captures its delta without applying");
  });
});
