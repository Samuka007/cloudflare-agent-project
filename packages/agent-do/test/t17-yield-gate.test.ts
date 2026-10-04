import { afterEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { newThreadId } from "@cap/protocol";
import { createRig, resetRuntime } from "./helpers.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { replayEvents } from "../src/turn-state.js";
import { setAgentRuntime } from "../src/injection.js";
import type { ModelProvider, ModelRequest, ModelStreamChunk } from "../src/provider.js";
import { MockModelProvider } from "../src/testing/mock-provider.js";
import type { AgentDO } from "../src/agent-do.js";
import {
  BUNDLED_AGENT_DEFINITIONS,
  projectSpawnPlans,
  settlementForSpawn,
  setAgentDefinitions,
} from "../src/tools/task/types.js";
import { EMPTY_YIELD_ABORT, NO_YIELD_WARNING } from "../src/tools/task/child-run.js";

/**
 * M1.5 T17 L1 chains (proposal §3 T17 acceptance) over REAL AgentDOs wired
 * through the AGENT_DO namespace binding, exactly like the composed
 * deployment: the reminder ladder three tiers (last forced), the
 * 3-consecutive-empty abort, the schema 3-strike override with the invalid
 * sidecar still written and readable through the agent:// extraction matrix,
 * and the yield-supersession photo-finish (late async-result voids the stale
 * yield and forces the re-yield — task semantics §7 "移植必抄").
 */

const agentNamespace = (env as { AGENT_DO: DurableObjectNamespace }).AGENT_DO;

function childEventsOf(childThreadId: string): Promise<AnyAgentEvent[]> {
  const stub = agentNamespace.get(
    agentNamespace.idFromName(childThreadId),
  ) as DurableObjectStub<AgentDO>;
  return stub.getEvents({}).then((response) => response.events);
}

const SPAWN_ARGS = {
  task: "Report the answer to everything.",
  solutionSpace: "one fix: rename, names given",
};

afterEach(() => {
  resetRuntime();
  setAgentDefinitions(BUNDLED_AGENT_DEFINITIONS);
});

/**
 * Supersession choreography provider: the FIRST unknown thread is the child
 * (served from the base script; once its input carries the [superseded]
 * reminder marker, from the fresh re-yield script), every later unknown
 * thread is the grandchild, held on the gate until the test opens it — the
 * async-result lands strictly after the stale yield, making the supersession
 * ordering deterministic. Every script ends with a no-tool entry: the mock
 * repeats its last entry, and a trailing tool-call entry would loop the turn
 * forever.
 */
class ChoreographyProvider implements ModelProvider {
  private childThread: string | null = null;
  private readonly base = new MockModelProvider([
    {
      toolCalls: [
        { name: "task", arguments: { task: "grandchild work", solutionSpace: "one fix: rename, names given" } },
      ],
    },
    { toolCalls: [{ name: "yield", arguments: { data: "v1-stale" } }] },
    { deltas: ["base done"] },
  ]);
  private readonly fresh = new MockModelProvider([
    { toolCalls: [{ name: "yield", arguments: { data: "v2-fresh" } }] },
    { deltas: ["fresh done"] },
  ]);
  private readonly grandchild = new MockModelProvider([
    { toolCalls: [{ name: "yield", arguments: { data: "gc-result" } }] },
    { deltas: ["gc done"] },
  ]);
  constructor(private readonly gate: Promise<boolean>) {}
  async *streamTurn(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamChunk> {
    this.childThread ??= request.threadId;
    if (request.threadId === this.childThread) {
      const target = request.input.includes("[superseded]") ? this.fresh : this.base;
      yield* target.streamTurn(request, options);
      return;
    }
    await this.gate;
    yield* this.grandchild.streamTurn(request, options);
  }
}

function toolResultOf(
  events: readonly AnyAgentEvent[],
  threadId: string,
  callSeq: number,
): { status: string; output: string } | undefined {
  const executionId = `${threadId}:${callSeq}`;
  const result = events.find(
    (event) => event.type === "tool.result" && event.data.executionId === executionId,
  );
  if (result?.type !== "tool.result") return undefined;
  return {
    status: result.data.status,
    output: typeof result.data.output === "string" ? result.data.output : "",
  };
}

describe("M1.5 T17 — reminder ladder (≤3 tiers, forced finish, SYSTEM WARNING)", () => {
  test("three text-only turns draw reminders 1..3; the 3rd forces toolChoice=yield; then the warning settles", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: SPAWN_ARGS }] },
      { deltas: ["spawned"] },
    ]);
    const childMock = new MockModelProvider([
      { deltas: ["thinking 1"] },
      { deltas: ["thinking 2"] },
      { deltas: ["thinking 3"] },
      { deltas: ["still nothing"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    const { turnId } = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "spawn a worker" }],
      mode: "start",
    });
    await rig.waitFor((all) =>
      all.some(
        (event) =>
          event.type === "task.spawn_settled" &&
          event.data.status === "error" &&
          event.data.output === NO_YIELD_WARNING,
      ),
    );
    await rig.waitTurnComplete(turnId);

    // Ladder shape: exactly three reminder markers, three reminder turns.
    const childThreadId = (await rig.events()).find(
      (event) => event.type === "task.spawn_planned",
    );
    if (childThreadId?.type !== "task.spawn_planned") throw new Error("no spawn plan");
    const childEvents = await childEventsOf(childThreadId.data.childThreadId);
    const reminders = childEvents.filter((event) => event.type === "task.yield_reminder");
    expect(reminders).toHaveLength(3);
    const inputs = childEvents.filter(
      (event): event is Extract<AnyAgentEvent, { type: "turn.input" }> =>
        event.type === "turn.input",
    );
    expect(inputs).toHaveLength(4); // assignment + three reminders
    const reminderTexts = inputs.slice(1).map((event) =>
      event.data.content[0]?.type === "text" ? event.data.content[0].text : "",
    );
    expect(reminderTexts[0]).toContain("Reminder 1/3");
    expect(reminderTexts[1]).toContain("Reminder 2/3");
    expect(reminderTexts[2]).toContain("Final reminder (3/3)");

    // Forced finish: the third reminder turn's model calls pin toolChoice.
    expect(childMock.callCount()).toBe(4);
    expect(childMock.calls[0]?.toolChoice).toBeUndefined();
    expect(childMock.calls[1]?.toolChoice).toBeUndefined();
    expect(childMock.calls[2]?.toolChoice).toBeUndefined();
    expect(childMock.calls[3]?.toolChoice).toEqual({ name: "yield" });

    // Terminal warning + failed settlement + receipt.
    const warning = childEvents.find((event) => event.type === "task.yield_warning");
    expect(warning?.type === "task.yield_warning" && warning.data.text).toBe(NO_YIELD_WARNING);
    const parentEvents = await rig.events();
    const settled = parentEvents.find((event) => event.type === "task.spawn_settled");
    expect(settled?.type === "task.spawn_settled" && settled.data.status).toBe("error");
    const receipt = childEvents.find((event) => event.type === "task.yield_completed");
    expect(receipt?.type === "task.yield_completed" && receipt.data.status).toBe("error");

    // Replay consistency on both logs.
    expect(() => replayEvents(parentEvents)).not.toThrow();
    expect(() => replayEvents(childEvents)).not.toThrow();
  });
});

describe("M1.5 T17 — yield quality gate (3 consecutive empty submissions abort)", () => {
  test("three empty yields abort the run without entering the reminder ladder", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: SPAWN_ARGS }] },
      { deltas: ["spawned"] },
    ]);
    const childMock = new MockModelProvider([
      { toolCalls: [{ name: "yield", arguments: {} }] },
      { toolCalls: [{ name: "yield", arguments: {} }] },
      { toolCalls: [{ name: "yield", arguments: {} }] },
      { deltas: ["giving up"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "spawn a worker" }],
      mode: "start",
    });
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_settled"));

    const parentEvents = await rig.events();
    const settled = parentEvents.find((event) => event.type === "task.spawn_settled");
    expect(settled?.type === "task.spawn_settled" && settled.data.status).toBe("error");
    expect(settled?.type === "task.spawn_settled" && settled.data.output).toBe(EMPTY_YIELD_ABORT);
    const plan = parentEvents.find((event) => event.type === "task.spawn_planned");
    if (plan?.type !== "task.spawn_planned") throw new Error("no spawn plan");
    const childEvents = await childEventsOf(plan.data.childThreadId);
    expect(childEvents.some((event) => event.type === "task.yield_reminder")).toBe(false);
    expect(childEvents.some((event) => event.type === "task.yield_warning")).toBe(false);
    const emptyResults = childEvents.filter(
      (event) =>
        event.type === "tool.call" &&
        event.data.tool === "yield" &&
        Object.keys(event.data.arguments).length === 0,
    );
    expect(emptyResults).toHaveLength(3);
    expect(() => replayEvents(childEvents)).not.toThrow();
  });
});

describe("M1.5 T17 — outputSchema 3-strike override + sidecar + agent:// extraction", () => {
  test("three schema rejections then permissive override; invalid payload readable via agent://", async () => {
    setAgentDefinitions([{ name: "task", blocking: true }]);
    const parentThreadId = newThreadId();
    const answerSchema = {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "string" } },
    };
    const parentMock = new MockModelProvider([
      {
        toolCalls: [
          {
            name: "task",
            arguments: {
              ...SPAWN_ARGS,
              outputSchema: answerSchema,
              schemaMode: "permissive",
            },
          },
        ],
      },
      {
        toolCalls: [
          { name: "read", arguments: { path: "agent://Task-1/answer" } },
          { name: "read", arguments: { path: "agent://Task-1" } },
          { name: "read", arguments: { path: "agent://Task-1/missing" } },
          { name: "read", arguments: { path: "history://Task-1" } },
        ],
      },
      { deltas: ["reads done"] },
    ]);
    const invalidYield = { toolCalls: [{ name: "yield", arguments: { data: { answer: 42 } } }] };
    const childMock = new MockModelProvider([
      invalidYield,
      invalidYield,
      invalidYield,
      invalidYield, // 4th submission: prior failures = 3 → accepted, schemaOverridden
      { deltas: ["done"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    const { turnId } = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "spawn a worker" }],
      mode: "start",
    });
    // Blocking child: the parent turn parks until the settlement lands.
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_settled"));
    await rig.waitFor((all) =>
      all.some(
        (event) =>
          event.type === "tool.result" &&
          typeof event.data.output === "string" &&
          !event.data.output.includes("history://") &&
          event.data.output.includes("transcript Task-1"),
      ),
    );
    await rig.waitTurnComplete(turnId);

    const parentEvents = await rig.events();
    const plan = projectSpawnPlans(parentEvents)[0];
    expect(plan?.mode).toBe("blocking");
    const childEvents = await childEventsOf(plan?.childThreadId ?? "");

    // The child journaled 3 schema rejections, then the override acceptance.
    const schemaResults = childEvents
      .map((event) =>
        event.type === "tool.call" && event.data.tool === "yield"
          ? toolResultOf(childEvents, plan?.childThreadId ?? "", event.seq)
          : undefined,
      )
      .filter((result): result is { status: string; output: string } => result !== undefined);
    expect(schemaResults).toHaveLength(4);
    expect(schemaResults[0]?.status).toBe("error");
    expect(schemaResults[0]?.output).toContain("outputSchema violation:");
    expect(schemaResults[2]?.output).toContain("schemaOverridden"); // next-one-accepted hint
    expect(schemaResults[3]).toMatchObject({ status: "ok" });
    expect(schemaResults[3]?.output).toContain("schemaOverridden");

    // Settlement: ok delivery carrying the invalid payload + the warning.
    const settled = settlementForSpawn(parentEvents, plan?.spawnId ?? "");
    expect(settled?.status).toBe("ok");
    expect(settled?.output).toContain('"answer": 42');
    expect(settled?.output).toContain("[WARNING] schemaOverridden");

    // agent:// extraction matrix over the settled artifacts.
    const taskCall = parentEvents.find(
      (event) => event.type === "tool.call" && event.data.tool === "task",
    );
    if (taskCall?.type !== "tool.call") throw new Error("no task call");
    const readCalls = parentEvents.filter(
      (event) => event.type === "tool.call" && event.data.tool === "read",
    );
    const readResults = readCalls.map((call) =>
      call.type === "tool.call" ? toolResultOf(parentEvents, parentThreadId, call.seq) : undefined,
    );
    expect(readResults[0]).toMatchObject({ status: "ok", output: "42" });
    expect(readResults[1]?.status).toBe("ok");
    expect(readResults[1]?.output).toContain('"answer": 42');
    expect(readResults[2]).toMatchObject({ status: "error" });
    expect(readResults[2]?.output).toContain('failed at segment "missing"');
    expect(readResults[3]?.status).toBe("ok");
    expect(readResults[3]?.output).toContain("transcript Task-1");
    expect(readResults[3]?.output).toContain("identity Task-1 depth=1");

    expect(() => replayEvents(parentEvents)).not.toThrow();
    expect(() => replayEvents(childEvents)).not.toThrow();
  });
});

describe("M1.5 T17 — yield-supersession (late async-result voids the stale yield)", () => {
  test("parked run wakes on the grandchild settlement, ladders with [superseded], fresh yield settles", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: SPAWN_ARGS }] },
      { deltas: ["spawned"] },
    ]);
    // `void` as a type argument trips no-invalid-void-type; boolean sentinel.
    const gate = Promise.withResolvers<boolean>();
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: new ChoreographyProvider(gate.promise) });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "spawn a worker" }],
      mode: "start",
    });
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_planned"));
    const parentEventsNow = await rig.events();
    const plan = projectSpawnPlans(parentEventsNow)[0];
    if (plan === undefined) throw new Error("no spawn plan");

    // Wait for the child's park: first turn complete with the stale-able
    // yield in, grandchild still gated → no settlement at the parent yet.
    // (Synchronous predicate — an async one would resolve on its own truthy
    // promise and open the gate before the park.)
    let parkError: unknown;
    try {
      await expect
        .poll(
          async () => {
            const childEvents = await childEventsOf(plan.childThreadId);
            const turnDone = childEvents.some((event) => event.type === "turn.completed");
            const yieldIn = childEvents.some(
              (event) => event.type === "tool.call" && event.data.tool === "yield",
            );
            const settled = childEvents.some((event) => event.type === "task.yield_completed");
            return turnDone && yieldIn && !settled ? "parked" : "running";
          },
          { timeout: 20_000, interval: 100 },
        )
        .toBe("parked");
    } catch (error) {
      parkError = error;
    } finally {
      // ALWAYS release the gate — a leaked gated driver hangs the worker.
      gate.resolve(true);
    }
    if (parkError !== undefined) {
      console.log(
        "D PARK TIMEOUT — child events:",
        (await childEventsOf(plan.childThreadId))
          .map((event) => `${event.seq}:${event.type}`)
          .join(","),
      );
      throw parkError instanceof Error
        ? parkError
        : new Error(`park poll failed: ${JSON.stringify(parkError)}`);
    }
    expect((await rig.events()).some((event) => event.type === "task.spawn_settled")).toBe(false);

    try {
      await rig.waitFor((all) => {
        const settled = all.find((event) => event.type === "task.spawn_settled");
        return settled?.type === "task.spawn_settled" && settled.data.output.includes("v2-fresh");
      });
    } finally {
      gate.resolve(true);
    }

    const parentEvents = await rig.events();
    const childEvents = await childEventsOf(plan.childThreadId);

    // Supersession chain on the child: async-result after the yield, a
    // [superseded] reminder, and the fresh terminal yield.
    expect(childEvents.some((event) => event.type === "task.async_result")).toBe(true);
    const reminders = childEvents.filter((event) => event.type === "task.yield_reminder");
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    const reminderInputs = childEvents.filter(
      (event): event is Extract<AnyAgentEvent, { type: "turn.input" }> =>
        event.type === "turn.input",
    );
    expect(
      reminderInputs.some(
        (event) =>
          event.data.content[0]?.type === "text" &&
          event.data.content[0].text.includes("[superseded]"),
      ),
    ).toBe(true);
    const receipt = childEvents.find((event) => event.type === "task.yield_completed");
    expect(receipt?.type === "task.yield_completed" && receipt.data.output).toContain("v2-fresh");

    // Exactly one settlement reached the parent — the FRESH yield, never v1.
    const settlements = parentEvents.filter((event) => event.type === "task.spawn_settled");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.type === "task.spawn_settled" && settlements[0].data.output).toContain("v2-fresh");
    expect(settlements[0]?.type === "task.spawn_settled" && settlements[0].data.output).not.toContain("v1-stale");

    expect(() => replayEvents(parentEvents)).not.toThrow();
    expect(() => replayEvents(childEvents)).not.toThrow();
  });
});

describe("M1.5 T17 — agent://all broadcast and resolution edges", () => {
  test("write-only broadcast, foreign-id errors, direct delivery, history render", async () => {
    setAgentDefinitions([{ name: "task", blocking: true }]);
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: SPAWN_ARGS }] },
      {
        toolCalls: [
          { name: "write", arguments: { path: "agent://all", content: "broadcast ping" } },
          { name: "read", arguments: { path: "agent://all" } },
          { name: "read", arguments: { path: "agent://Nobody" } },
          { name: "write", arguments: { path: "agent://Task-1", content: "direct ping" } },
          { name: "read", arguments: { path: "history://Task-1" } },
        ],
      },
      { deltas: ["edges done"] },
    ]);
    const childMock = new MockModelProvider([
      { toolCalls: [{ name: "yield", arguments: { data: { answer: "42" } } }] },
      { deltas: ["done"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });

    const { turnId } = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "spawn a worker" }],
      mode: "start",
    });
    await rig.waitFor((all) =>
      all.some(
        (event) =>
          event.type === "tool.result" &&
          typeof event.data.output === "string" &&
          event.data.output.includes("transcript Task-1"),
      ),
    );
    await rig.waitTurnComplete(turnId);

    const parentEvents = await rig.events();
    const plan = projectSpawnPlans(parentEvents)[0];
    const childEvents = await childEventsOf(plan?.childThreadId ?? "");

    const edgeCalls = parentEvents.filter(
      (event): event is Extract<AnyAgentEvent, { type: "tool.call" }> =>
        event.type === "tool.call" &&
        (event.data.tool === "read" || event.data.tool === "write") &&
        typeof event.data.arguments.path === "string" &&
        (event.data.arguments.path.startsWith("agent://") ||
          event.data.arguments.path.startsWith("history://")),
    );
    const edgeResults = edgeCalls.map((call) => toolResultOf(parentEvents, parentThreadId, call.seq));
    expect(edgeResults[0]).toMatchObject({ status: "ok", output: "Broadcast to 1 subagent(s)." });
    expect(edgeResults[1]).toMatchObject({ status: "error" });
    expect(edgeResults[1]?.output).toContain("write-only");
    expect(edgeResults[2]).toMatchObject({ status: "error" });
    expect(edgeResults[2]?.output).toContain("Nobody");
    expect(edgeResults[3]).toMatchObject({ status: "ok", output: "Delivered to Task-1." });
    expect(edgeResults[4]?.status).toBe("ok");

    // Both deliveries landed as peer messages on the child journal.
    const peerMessages = childEvents.filter(
      (event): event is Extract<AnyAgentEvent, { type: "peer.message" }> =>
        event.type === "peer.message",
    );
    expect(peerMessages).toHaveLength(2);
    const texts = peerMessages.map(
      (event) => event.data.text,
    );
    expect(texts).toContain("broadcast ping");
    expect(texts).toContain("direct ping");
    expect(peerMessages[0]?.type === "peer.message" && peerMessages[0].data.from).toBe("Main");

    expect(() => replayEvents(parentEvents)).not.toThrow();
    expect(() => replayEvents(childEvents)).not.toThrow();
  });
});
