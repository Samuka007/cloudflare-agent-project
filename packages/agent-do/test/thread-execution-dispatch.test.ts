import { afterEach, beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { newThreadId } from "@cap/protocol";
import {
  AgentDO,
  clearAgentRuntimes,
  RelaySelectionError,
  setAgentRuntime,
  type AgentRuntime,
} from "../src/index.js";
import { MockModelProvider } from "../src/testing/mock-provider.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import type { RelaySelection } from "../src/provider-catalog.js";
import { mockAgentRuntime } from "./helpers.js";

/** Narrowed turn.input event (the pin assertions read its execution field). */
type TurnInputEvent = Extract<AnyAgentEvent, { type: "turn.input" }>;

/**
 * #351 thread-level provider/model/reasoningLevel dispatch: the journaled
 * selection (thread.created / thread.execution_updated / turn.input pin)
 * resolves through the providerId-keyed relay registry the deploying worker
 * installed — two threads on two models dispatch their OWN RelayConfig rows,
 * a send-time `live` change rides the next turn (never the active one), and
 * an evicted DO replays into the identical dispatch (replay-is-truth).
 *
 * The registry here is the resolver closure the composed worker installs
 * (relayAgentRuntime): the DO consumes the closure, so the fake stands in
 * at exactly the production seam. Catalog drift fails the turn loudly —
 * never a silent re-route (ROADMAP red line).
 */

const agentNamespace = (env as { AGENT_DO: DurableObjectNamespace }).AGENT_DO;

function stubFor(threadId: string): DurableObjectStub<AgentDO> {
  return agentNamespace.get(agentNamespace.idFromName(threadId)) as DurableObjectStub<AgentDO>;
}

async function eventsOf(threadId: string): Promise<AnyAgentEvent[]> {
  return (await stubFor(threadId).getEvents({ sinceSeq: 0 })).events;
}

async function waitFor(
  threadId: string,
  predicate: (events: AnyAgentEvent[]) => boolean,
): Promise<AnyAgentEvent[]> {
  let snapshot = await eventsOf(threadId);
  await expect
    .poll(
      async () => {
        snapshot = await eventsOf(threadId);
        return predicate(snapshot) ? "yes" : "no";
      },
      { timeout: 20_000, interval: 100 },
    )
    .toBe("yes");
  return snapshot;
}

/** The registry stand-in: selection.model picks the row; anything else throws. */
function registryRuntime(
  rows: Record<string, MockModelProvider>,
  fallback: MockModelProvider,
  materialize: RelaySelection | null = null,
): AgentRuntime {
  return {
    resolveExecutionProvider: (selection: RelaySelection) => {
      if (selection.model === undefined) return fallback;
      const row = rows[selection.model];
      if (row === undefined) {
        throw new RelaySelectionError(
          "model_unknown",
          "model",
          `unknown model "${selection.model}"`,
        );
      }
      return row;
    },
    ...(materialize !== null ? { materializeLegacySelection: () => materialize } : {}),
  };
}

async function createThread(threadId: string, execution?: RelaySelection): Promise<void> {
  await stubFor(threadId).createThread({
    threadId,
    title: "dispatch-rig",
    machineId: threadId,
    ...(execution !== undefined ? { execution } : {}),
  });
}

async function send(
  threadId: string,
  clientRequestId: string,
  args?: { execution?: RelaySelection; mode?: "start" | "steer" },
): Promise<{ turnId: string; steer: boolean; duplicated: boolean }> {
  return stubFor(threadId).sendMessage({
    clientRequestId,
    content: [{ type: "text", text: `input ${clientRequestId}` }],
    mode: args?.mode ?? "start",
    ...(args?.execution !== undefined ? { execution: args.execution } : {}),
  });
}

async function waitTurnTerminal(threadId: string, turnId: string): Promise<void> {
  await waitFor(threadId, (all) =>
    all.some(
      (event) =>
        (event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled") &&
        event.data.turnId === turnId,
    ),
  );
}

beforeEach(() => {
  clearAgentRuntimes();
});

afterEach(() => {
  clearAgentRuntimes();
});

test("two threads on two models dispatch their own registry rows", async () => {
  const mockA = new MockModelProvider([{ deltas: ["row-a"] }, { deltas: ["row-a-2"] }]);
  const mockB = new MockModelProvider([{ deltas: ["row-b"] }, { deltas: ["row-b-2"] }]);
  setAgentRuntime("*", registryRuntime({ "model-a": mockA, "model-b": mockB }, mockA));

  const threadA = newThreadId();
  const threadB = newThreadId();
  await createThread(threadA, { model: "model-a" });
  await createThread(threadB, { model: "model-b" });

  const sentA = await send(threadA, "creq-a1");
  const sentB = await send(threadB, "creq-b1");
  await Promise.all([
    waitTurnTerminal(threadA, sentA.turnId),
    waitTurnTerminal(threadB, sentB.turnId),
  ]);

  expect(mockA.calls.length).toBeGreaterThan(0);
  expect(mockB.calls.length).toBeGreaterThan(0);
  // The turns pinned their own row on turn.input — replay reads it back.
  const inputA = (await eventsOf(threadA)).find((event) => event.type === "turn.input");
  const inputB = (await eventsOf(threadB)).find((event) => event.type === "turn.input");
  expect(inputA?.data).toMatchObject({ execution: { model: "model-a" } });
  expect(inputB?.data).toMatchObject({ execution: { model: "model-b" } });
});

test("an evicted DO replays into the identical dispatch (replay-is-truth)", async () => {
  const mockA = new MockModelProvider([
    { deltas: ["before-eviction"] },
    { deltas: ["after-eviction"] },
    { deltas: ["still-a"] },
  ]);
  const mockB = new MockModelProvider([{ deltas: ["never-called"] }]);
  setAgentRuntime("*", registryRuntime({ "model-a": mockA, "model-b": mockB }, mockA));

  const threadId = newThreadId();
  await createThread(threadId, { model: "model-a" });
  const first = await send(threadId, "creq-evict-1");
  await waitTurnTerminal(threadId, first.turnId);
  const callsBefore = mockA.calls.length;
  expect(callsBefore).toBeGreaterThan(0);

  await abortAllDurableObjects();
  // Fresh incarnation, same DO name: the journal re-folds the selection and
  // the next turn dispatches the SAME registry row — no fallback, no drift.
  const second = await stubFor(threadId).sendMessage({
    clientRequestId: "creq-evict-2",
    content: [{ type: "text", text: "post-replay input" }],
    mode: "start",
  });
  await waitTurnTerminal(threadId, second.turnId);
  expect(mockA.calls.length).toBeGreaterThan(callsBefore);
  expect(mockB.calls).toHaveLength(0);
});

test("a live selection change rides the next turn and journals once", async () => {
  const mockA = new MockModelProvider([{ deltas: ["a-1"] }, { deltas: ["a-2"] }]);
  const mockB = new MockModelProvider([{ deltas: ["b-1"] }, { deltas: ["b-2"] }]);
  setAgentRuntime("*", registryRuntime({ "model-a": mockA, "model-b": mockB }, mockA));

  const threadId = newThreadId();
  await createThread(threadId, { model: "model-a" });
  const first = await send(threadId, "creq-live-1");
  await waitTurnTerminal(threadId, first.turnId);

  const second = await send(threadId, "creq-live-2", { execution: { model: "model-b" } });
  await waitTurnTerminal(threadId, second.turnId);

  const events = await eventsOf(threadId);
  const updates = events.filter((event) => event.type === "thread.execution_updated");
  expect(updates).toHaveLength(1);
  expect(updates[0]?.data).toEqual({ model: "model-b" });
  const pins = events
    .filter((event): event is TurnInputEvent => event.type === "turn.input")
    .map((event) => event.data.execution?.model);
  expect(pins).toEqual(["model-a", "model-b"]);
  expect(mockB.calls.length).toBeGreaterThan(0);

  // An equal ride is not a change: no second row, no ride on the pin.
  const third = await send(threadId, "creq-live-3", { execution: { model: "model-b" } });
  await waitTurnTerminal(threadId, third.turnId);
  const eventsAfter = await eventsOf(threadId);
  expect(eventsAfter.filter((event) => event.type === "thread.execution_updated")).toHaveLength(1);
});

test("a mid-turn steer applies the thread state but never the running turn", async () => {
  const mockA = new MockModelProvider([
    { hang: true },
    { deltas: ["cancelled"] },
    { deltas: ["unused"] },
  ]);
  const mockB = new MockModelProvider([{ deltas: ["b-after"] }, { deltas: ["b-2"] }]);
  setAgentRuntime("*", registryRuntime({ "model-a": mockA, "model-b": mockB }, mockA));

  const threadId = newThreadId();
  await createThread(threadId, { model: "model-a" });
  const active = await send(threadId, "creq-steer-1");
  await waitFor(threadId, (all) =>
    all.some((event) => event.type === "model.call_started" && event.data.turnId === active.turnId),
  );

  await send(threadId, "creq-steer-2", { mode: "steer", execution: { model: "model-b" } });
  // The thread state row landed; the RUNNING turn still rides model-a.
  const midEvents = await eventsOf(threadId);
  expect(midEvents.some((event) => event.type === "thread.execution_updated")).toBe(true);
  expect(mockB.calls).toHaveLength(0);

  await stubFor(threadId).cancelTurn({ turnId: active.turnId });
  await waitTurnTerminal(threadId, active.turnId);

  // The NEXT turn pins the new selection and dispatches model-b.
  const next = await send(threadId, "creq-steer-3");
  await waitTurnTerminal(threadId, next.turnId);
  // Two turn.input rows exist: the steered ride appends turn.steer (and the
  // thread state row), never a turn.input — live rides the NEXT turn.
  const pins = (await eventsOf(threadId))
    .filter((event): event is TurnInputEvent => event.type === "turn.input")
    .map((event) => event.data.execution?.model);
  expect(pins).toEqual(["model-a", "model-b"]);
  expect(mockB.calls.length).toBeGreaterThan(0);
});

test("catalog drift fails the turn loudly instead of re-routing", async () => {
  // The registry only knows model-a: a journaled selection for the removed
  // model-b must fail the turn (named error), never dispatch the fallback.
  const mockA = new MockModelProvider([{ deltas: ["a"] }]);
  setAgentRuntime("*", registryRuntime({ "model-a": mockA }, mockA));

  const threadId = newThreadId();
  await createThread(threadId, { model: "model-b" });
  const sent = await send(threadId, "creq-drift-1");
  await waitTurnTerminal(threadId, sent.turnId);
  const events = await eventsOf(threadId);
  expect(events.some((event) => event.type === "turn.failed")).toBe(true);
  expect(mockA.calls).toHaveLength(0);
});

test("a pre-#351 journal materializes the legacy row at its next send (#496)", async () => {
  const legacyRow = new MockModelProvider([{ deltas: ["legacy"] }, { deltas: ["legacy-2"] }]);
  const mockB = new MockModelProvider([{ deltas: ["never"] }]);
  setAgentRuntime(
    "*",
    registryRuntime(
      { "glm-5.3": legacyRow },
      legacyRow,
      { providerId: "legacy-provider", model: "glm-5.3" },
    ),
  );

  const threadId = newThreadId();
  await createThread(threadId);
  const sent = await send(threadId, "creq-legacy-1");
  await waitTurnTerminal(threadId, sent.turnId);
  expect(legacyRow.calls.length).toBeGreaterThan(0);
  expect(mockB.calls).toHaveLength(0);
  const events = await eventsOf(threadId);
  // The materialization is thread data: an explicit selection row rides the
  // journal once, and the turn pins it (replay folds the same dispatch).
  const updates = events.filter((event) => event.type === "thread.execution_updated");
  expect(updates).toHaveLength(1);
  expect(updates[0]?.data).toEqual({ providerId: "legacy-provider", model: "glm-5.3" });
  const input = events.find((event): event is TurnInputEvent => event.type === "turn.input");
  expect(input?.data.execution).toEqual({ providerId: "legacy-provider", model: "glm-5.3" });

  // The second send appends nothing further (the pin is already explicit).
  const second = await send(threadId, "creq-legacy-2");
  await waitTurnTerminal(threadId, second.turnId);
  expect(
    (await eventsOf(threadId)).filter((event) => event.type === "thread.execution_updated"),
  ).toHaveLength(1);
});

test("no selection and no materializable row fails the send closed (#496)", async () => {
  const fallback = new MockModelProvider([{ deltas: ["never"] }]);
  setAgentRuntime("*", registryRuntime({}, fallback));

  const threadId = newThreadId();
  await createThread(threadId);
  await expect(send(threadId, "creq-legacy-none")).rejects.toThrow(/selection_missing/);
  // Nothing landed: no turn row, no fallback dispatch.
  const events = await eventsOf(threadId);
  expect(events.some((event) => event.type === "turn.input")).toBe(false);
  expect(fallback.calls).toHaveLength(0);
});

test("exact per-thread registration still wins over the registry (mock rigs)", async () => {
  const exact = new MockModelProvider([{ deltas: ["exact-mock"] }, { deltas: ["exact-2"] }]);
  const registryRow = new MockModelProvider([{ deltas: ["never"] }]);
  setAgentRuntime("*", registryRuntime({ "model-a": registryRow }, exact));
  const threadId = newThreadId();
  setAgentRuntime(threadId, mockAgentRuntime(exact));

  await createThread(threadId, { model: "model-a" });
  const sent = await send(threadId, "creq-exact-1");
  await waitTurnTerminal(threadId, sent.turnId);
  expect(exact.calls.length).toBeGreaterThan(0);
  expect(registryRow.calls).toHaveLength(0);
});

test("createThread journals the create-time selection verbatim", async () => {
  const fallback = new MockModelProvider([{ deltas: ["ok"] }]);
  setAgentRuntime("*", registryRuntime({}, fallback));
  const threadId = newThreadId();
  await createThread(threadId, { providerId: "omp", model: "model-a", reasoningLevel: "none" });
  const created = (await eventsOf(threadId)).find(
    (event): event is Extract<AnyAgentEvent, { type: "thread.created" }> =>
      event.type === "thread.created",
  );
  expect(created?.data.execution).toEqual({
    providerId: "omp",
    model: "model-a",
    reasoningLevel: "none",
  });
});
