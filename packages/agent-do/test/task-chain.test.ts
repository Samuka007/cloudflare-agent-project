import { afterEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { newThreadId } from "@cap/protocol";
import { createRig, resetRuntime, type Rig } from "./helpers.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { replayEvents } from "../src/turn-state.js";
import { setAgentRuntime } from "../src/injection.js";
import { MockModelProvider } from "../src/testing/mock-provider.js";
import { anthropicRequestBody } from "../src/relay/wire.js";
import type { AgentDO } from "../src/agent-do.js";
import {
  BUNDLED_AGENT_DEFINITIONS,
  settlementForSpawn,
  subagentIdentityOf,
} from "../src/tools/task/types.js";
import { NO_YIELD_WARNING } from "../src/tools/task/child-run.js";
import { setAgentDefinitions } from "../src/tools/task/types.js";

/**
 * M1.5 T16 L1 chain (proposal §3 T16 acceptance): spawn → child AgentDO
 * running → yield → backflow into the parent session — over REAL AgentDO
 * instances wired through the AGENT_DO namespace binding, exactly like the
 * composed deployment. Replay-consistency assertions fold both logs through
 * the FSM after every chain.
 */

const agentNamespace = (env as { AGENT_DO: DurableObjectNamespace }).AGENT_DO;

function childEventsOf(childThreadId: string): Promise<AnyAgentEvent[]> {
  const stub = agentNamespace.get(
    agentNamespace.idFromName(childThreadId),
  ) as DurableObjectStub<AgentDO>;
  return stub.getEvents({}).then((response) => response.events);
}

/** Parent turn 1 emits the task call; turn 2 closes the turn with text. */
const PARENT_TASK_ARGS = {
  task: "Report the answer to everything.",
  solutionSpace: "one fix: rename, names given",
};

afterEach(() => {
  resetRuntime();
  setAgentDefinitions(BUNDLED_AGENT_DEFINITIONS);
});

async function driveParentTurn(rig: Rig, inputId: string): Promise<string> {
  const sent = await rig.stub.sendMessage({
    clientRequestId: inputId,
    content: [{ type: "text", text: "spawn a worker" }],
    mode: "start",
  });
  return sent.turnId;
}

describe("M1.5 T16 — L1 chain over real child AgentDOs", () => {
  test("background spawn: plan → child identity → yield → T2 settle + async-result backflow", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: PARENT_TASK_ARGS }] },
      { deltas: ["spawned"] },
    ]);
    // The child DO resolves the "*" fallback runtime (same isolate).
    const childMock = new MockModelProvider([
      { toolCalls: [{ name: "yield", arguments: { data: { answer: 42 } } }] },
      { deltas: ["submitted"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    const turnId = await driveParentTurn(rig, "in-1");
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_planned"));
    await rig.waitFor((all) => all.some((event) => event.type === "task.async_result"));
    await rig.waitTurnComplete(turnId);

    const parentEvents = await rig.events();
    const plans = parentEvents.filter((event) => event.type === "task.spawn_planned");
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    if (plan?.type !== "task.spawn_planned") throw new Error("unreachable");
    // bb same-host constructive default: machineId inherits the parent binding.
    expect(plan.data.machineId).toBe(parentThreadId);
    expect(plan.data.parentThreadId).toBe(parentThreadId);
    expect(plan.data.mode).toBe("background");
    expect(plan.data.jobId).not.toBeNull();
    expect(plan.data.depth).toBe(1);
    expect(plan.data.agentId).toBe("Task-1"); // unnamed → journal-count default
    const childThreadId = plan.data.childThreadId;

    // The task execution itself returned the registration receipt.
    const taskCall = parentEvents.find(
      (event) => event.type === "tool.call" && event.data.tool === "task",
    );
    if (taskCall?.type !== "tool.call") throw new Error("no task tool.call journaled");
    const taskResult = parentEvents.find(
      (event) =>
        event.type === "tool.result" &&
        event.data.executionId === `${parentThreadId}:${taskCall.seq}`,
    );
    expect(taskResult).toBeDefined();
    if (taskResult?.type === "tool.result") {
      expect(taskResult.data.status).toBe("ok");
      expect(taskResult.data.output).toContain("Background: Task-1");
      expect(taskResult.data.output).toContain(`agent://Task-1`);
    }

    // T2 JobRegistry: owner-scoped background job, settled by the callback.
    const registered = parentEvents.find((event) => event.type === "job.registered");
    expect(registered?.type === "job.registered" && registered.data.label).toBe("Task-1");
    const settled = parentEvents.find((event) => event.type === "job.settled");
    expect(settled?.type === "job.settled" && settled.data.status).toBe("ok");
    expect(settled?.type === "job.settled" && settled.data.output).toContain("42");

    // Backflow rows: settlement + the model-visible async-result follow-up.
    const settlements = parentEvents.filter((event) => event.type === "task.spawn_settled");
    expect(settlements).toHaveLength(1);
    const asyncResults = parentEvents.filter((event) => event.type === "task.async_result");
    expect(asyncResults).toHaveLength(1);
    if (asyncResults[0]?.type === "task.async_result") {
      // Raw settlement output; the delivery prefix rides projection (translate).
      expect(asyncResults[0].data.output).toContain("42");
    }

    // Child DO journal: identity, assignment prompt, yield, completion.
    const childEvents = await childEventsOf(childThreadId);
    const identity = subagentIdentityOf(childEvents);
    expect(identity).toBeDefined();
    expect(identity?.parentThreadId).toBe(parentThreadId);
    expect(identity?.depth).toBe(1);
    const childInput = childEvents.find((event) => event.type === "turn.input");
    if (childInput?.type !== "turn.input") throw new Error("child never driven");
    expect(childInput.data.content[0]?.type === "text" && childInput.data.content[0].text).toBe(
      "Complete assignment thoroughly:\n\nReport the answer to everything.",
    );
    const childYield = childEvents.find(
      (event) => event.type === "tool.call" && event.data.tool === "yield",
    );
    expect(childYield).toBeDefined();
    expect(childEvents.some((event) => event.type === "turn.completed")).toBe(true);

    // The child ran on the subagent surface (hidden yield, Main's default model).
    expect(childMock.calls.length).toBeGreaterThan(0);
    expect(childMock.calls[0]?.toolSurface).toBe("subagent");
    expect(childMock.calls[0]?.spawnPolicyBlocked).toBe(false);
    // Parent stayed on the main surface.
    expect(parentMock.calls[0]?.toolSurface).toBeUndefined();

    // Replay consistency: both logs fold through the FSM cleanly, and the
    // parent's settlement projection agrees with the journal.
    expect(() => replayEvents(parentEvents)).not.toThrow();
    expect(() => replayEvents(childEvents)).not.toThrow();
    expect(settlementForSpawn(parentEvents, childThreadId)?.status).toBe("ok");
  });

  test("blocking agent runs inline: wake on settle, SingleResult merge, no job row", async () => {
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
      { toolCalls: [{ name: "yield", arguments: { data: "findings", type: "result" } }] },
      { deltas: ["ok"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    const turnId = await driveParentTurn(rig, "in-1");
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_settled"));
    await rig.waitFor((all) =>
      all.some(
        (event) =>
          event.type === "tool.result" &&
          typeof event.data.output === "string" &&
          event.data.output.includes("Task Scout (scout) completed."),
      ),
    );
    await rig.waitTurnComplete(turnId);

    const parentEvents = await rig.events();
    // Blocking: no background registration, no async-result row.
    expect(parentEvents.some((event) => event.type === "job.registered")).toBe(false);
    expect(parentEvents.some((event) => event.type === "task.async_result")).toBe(false);
    const plan = parentEvents.find((event) => event.type === "task.spawn_planned");
    if (plan?.type !== "task.spawn_planned") throw new Error("no spawn plan");
    expect(plan.data.mode).toBe("blocking");
    expect(plan.data.jobId).toBeNull();
    expect(plan.data.agentId).toBe("Scout");
    // The blocking tool.result merged the child's yield payload inline.
    const inline = parentEvents.find(
      (event) =>
        event.type === "tool.result" &&
        typeof event.data.output === "string" &&
        event.data.output.includes("Task Scout (scout) completed."),
    );
    if (inline?.type !== "tool.result") throw new Error("no inline result");
    expect(inline.data.status).toBe("ok");
    expect(inline.data.output).toContain("findings");
    expect(() => replayEvents(parentEvents)).not.toThrow();
  });

  test("child exiting without yield settles the spawn failed with the SYSTEM WARNING", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: PARENT_TASK_ARGS }] },
      { deltas: ["noted"] },
    ]);
    const childMock = new MockModelProvider([{ deltas: ["wrote prose, never yielded"] }]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    const turnId = await driveParentTurn(rig, "in-1");
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_settled"));
    await rig.waitTurnComplete(turnId);

    const parentEvents = await rig.events();
    const settlement = parentEvents.find((event) => event.type === "task.spawn_settled");
    if (settlement?.type !== "task.spawn_settled") throw new Error("no settlement");
    expect(settlement.data.status).toBe("error");
    expect(settlement.data.output).toBe(NO_YIELD_WARNING);
    const asyncResult = parentEvents.find((event) => event.type === "task.async_result");
    if (asyncResult?.type !== "task.async_result") throw new Error("no async result");
    expect(asyncResult.data.status).toBe("error");
    // The row stores the raw settlement output; the "Background task …
    // failed." delivery prefix is added at projection time (translate).
    expect(asyncResult.data.output).toContain(NO_YIELD_WARNING);
  });

  test("duplicate completion callbacks dedup by spawnId (cross-DO message dedup)", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: PARENT_TASK_ARGS }] },
      { deltas: ["spawned"] },
    ]);
    const childMock = new MockModelProvider([
      { toolCalls: [{ name: "yield", arguments: { data: { ok: true } } }] },
      { deltas: ["done"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    const turnId = await driveParentTurn(rig, "in-1");
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_settled"));
    await rig.waitTurnComplete(turnId);

    const parentEvents = await rig.events();
    const plan = parentEvents.find((event) => event.type === "task.spawn_planned");
    if (plan?.type !== "task.spawn_planned") throw new Error("no spawn plan");
    const first = await rig.stub.completeSubagent({
      spawnId: plan.data.spawnId,
      agentId: plan.data.agentId,
      status: "ok",
      output: "late duplicate",
    });
    expect(first.duplicated).toBe(true);
    const stillOne = (await rig.events()).filter((event) => event.type === "task.spawn_settled");
    expect(stillOne).toHaveLength(1);
    // (A completion for an unknown spawn throws not_found in
    // completeSubagent — same verdict as onExecutionUpdate's unknown
    // executionId. Not asserted through a remote stub: the vitest workers
    // plugin reports remote RPC errors as unhandled rejections.)
  });

  test("L2 (#228): the child's context keeps the dispatched task across the reminder ladder", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: PARENT_TASK_ARGS }] },
      { deltas: ["spawned"] },
    ]);
    // Turn 1: the child answers the assignment with plain text and no yield —
    // the T17 ladder injects a reminder turn; turn 2: the forced yield; turn 3
    // closes after the yielded call (mock's last entry would repeat).
    const childMock = new MockModelProvider([
      { deltas: ["OK"] },
      { toolCalls: [{ name: "yield", arguments: { data: { answer: "OK" } } }] },
      { deltas: ["done"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    const turnId = await driveParentTurn(rig, "in-1");
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_settled"));
    await rig.waitTurnComplete(turnId);

    // Two turns ran: the assignment turn and the reminder turn.
    expect(childMock.calls.length).toBeGreaterThanOrEqual(2);
    const [firstRequest, reminderRequest] = childMock.calls;

    // L2 literal assertion: the child's FIRST turn context carries the
    // dispatched task 原文 (assignment prompt = opener + task, no context).
    expect(firstRequest?.input).toBe(
      `Complete assignment thoroughly:\n\n${PARENT_TASK_ARGS.task}`,
    );

    // The defect this pins (#228): the reminder turn's request must NOT be a
    // context reset — the assignment turn rides priorTurns (input + recorded
    // call history), so the reminder-yield still knows what the run produced.
    expect(reminderRequest?.input).toContain("Reminder");
    expect(reminderRequest?.priorTurns).toHaveLength(1);
    const prior = reminderRequest?.priorTurns?.[0];
    expect(prior?.input).toBe(firstRequest?.input);
    expect(prior?.calls).toHaveLength(1);
    expect(prior?.calls[0]?.text).toBe("OK");

    // Model-visible proof: the wire body of the reminder request carries the
    // dispatched task text (roles alternate: user → assistant → user).
    if (reminderRequest === undefined) throw new Error("no reminder-turn request");
    const body = anthropicRequestBody(reminderRequest, {
      model: "glm-5.3",
      maxTokens: 8192,
      thinking: { type: "disabled" },
    });
    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(body.messages)).toContain(PARENT_TASK_ARGS.task);

    // The yielded run still settles ok at the parent (settlement rides the
    // yield data, not the "no task" degenerate output the old projection
    // provoked on live models).
    const parentEvents = await rig.events();
    expect(() => replayEvents(parentEvents)).not.toThrow();
    const plan = parentEvents.find((event) => event.type === "task.spawn_planned");
    if (plan?.type !== "task.spawn_planned") throw new Error("no spawn plan");
    const childThreadId = plan.data.childThreadId;
    expect(settlementForSpawn(parentEvents, childThreadId)?.status).toBe("ok");
  });
});
