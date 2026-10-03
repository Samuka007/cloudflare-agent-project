import { afterEach, describe, expect, test } from "vitest";
import {
  abortAllDurableObjects,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import type { Rig } from "./helpers.js";
import { createRig, resetRuntime } from "./helpers.js";
import { executionIdFor, callSeqFromExecutionId, threadIdFromExecutionId } from "../src/ids.js";
import { replayEvents, type ReplayState } from "../src/turn-state.js";
import type { AgentEventRecord, AgentEventType, AnyAgentEvent } from "../src/fsm-events.js";
import type { FakeJournalOp } from "../src/testing/fake-daemon.js";

/**
 * The 22 named invariants of docs/design/unified-turn-state.md §7, asserted
 * at L1 against the agent-DO event log, the reference fake daemon-service
 * journal (the #30 contract double), and the deterministic mock relay.
 * One named test per invariant; test names carry the I-number so the
 * invariant→test mapping is greppable.
 */

afterEach(() => {
  resetRuntime();
});

/** Standard two-call turn: one tool call, then a text-only completion. */
const TOOL_TURN = [
  { toolCalls: [{ name: "bash", arguments: { command: "ls" } }] },
  { deltas: ["done"] },
];

const TEXT = "run it";

async function journal(rig: Rig): Promise<FakeJournalOp[]> {
  // The DO RPC returns an unknown[]; the journal is this package's own type.
  return (await rig.service.journal()) as FakeJournalOp[];
}

/**
 * Drive one full tool-calling turn against the fake daemon: send → wait for
 * the tool.call → emit output + exit from the fake client → wait completion.
 */
async function completeToolTurn(rig: Rig, clientRequestId: string): Promise<{
  turnId: string;
  executionId: string;
  callSeq: number;
}> {
  const sent = await rig.stub.sendMessage({
    clientRequestId,
    content: [{ type: "text", text: TEXT }],
    mode: "auto",
  });
  const toolEvents = await rig.waitFor((all) => all.some((event) => event.type === "tool.call"));
  const call = toolEvents.find((event) => event.type === "tool.call");
  const callSeq = call?.seq ?? 0;
  const executionId = executionIdFor(rig.threadId, callSeq);
  await rig.service.clientEmitOutput(executionId, "out");
  await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: "out" });
  await rig.waitTurnComplete(sent.turnId);
  return { turnId: sent.turnId, executionId, callSeq };
}

/** Locate the single execution spawned by a one-tool turn. */
async function pendingExecutionId(rig: Rig): Promise<string> {
  const events = await rig.waitFor((all) => all.some((event) => event.type === "tool.exec_started"));
  const call = events.find((event) => event.type === "tool.call");
  if (call === undefined) throw new Error("tool.call never persisted");
  return executionIdFor(rig.threadId, call.seq);
}

/** Discriminated-union guard: narrows an event to exactly one record type. */
function isEventType<TType extends AgentEventType>(
  event: AnyAgentEvent,
  type: TType,
): event is Extract<AnyAgentEvent, { type: TType }> {
  return event.type === type;
}

function requireEvent<TType extends AgentEventType>(
  events: readonly AnyAgentEvent[],
  type: TType,
  where: string,
): AgentEventRecord<TType> {
  const found = events.find(
    (event): event is AgentEventRecord<TType> & AnyAgentEvent => event.type === type,
  );
  if (found === undefined) throw new Error(`expected a ${type} event ${where}`);
  return found;
}

type CanonicalState = Record<string, unknown>;

/** JSON-safe projection of the replayed FSM state (Maps → objects). */
function canonical(state: ReplayState): CanonicalState {
  return {
    threadId: state.threadId,
    title: state.title,
    machineId: state.machineId,
    latestSeq: state.latestSeq,
    eventCount: state.eventCount,
    activeTurnId: state.activeTurnId,
    turns: Object.fromEntries(state.turns),
    inputIds: Object.fromEntries(state.inputIds),
    modelCalls: Object.fromEntries(state.modelCalls),
    executions: Object.fromEntries(state.executions),
  };
}

/** Read the live in-DO replay state via the sanctioned test hook. */
async function liveState(rig: Rig): Promise<CanonicalState> {
  return runInDurableObject(rig.stub, (instance) => {
    // `state` is private; the plugin's in-DO hook is the test seam for it.
    const internals = instance as unknown as { state: ReplayState };
    return canonical(internals.state);
  });
}

describe("§7 invariants — log shape and input ordering", () => {
  test("I1: event seqs are contiguous 1..N and a same-seq insert conflicts", async () => {
    const rig = await createRig({ turns: [{ deltas: ["hello"] }] });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await rig.waitTurnComplete(sent.turnId);
    const events = await rig.events();
    expect(events.length).toBeGreaterThan(1);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));

    // A second append at an existing seq must fail at the storage layer.
    const conflicted = await runInDurableObject(rig.stub, (_instance, state) => {
      try {
        state.storage.sql.exec(
          "INSERT INTO events (thread_id, seq, id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          rig.threadId,
          1,
          "evt_conflict",
          "thread.created",
          "{}",
          0,
        );
        return false;
      } catch {
        return true;
      }
    });
    expect(conflicted).toBe(true);
  });

  test("I2: turn.input precedes the first model call; duplicate input appends nothing", async () => {
    const rig = await createRig({ turns: [{ deltas: ["hello"] }] });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-2",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await rig.waitTurnComplete(sent.turnId);
    const events = await rig.events();
    const input = requireEvent(events, "turn.input", "for the turn");
    const firstCall = requireEvent(events, "model.call_started", "for the turn");
    expect(firstCall.seq).toBeGreaterThan(input.seq);

    const again = await rig.stub.sendMessage({
      clientRequestId: "in-2",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    expect(again).toEqual({ turnId: sent.turnId, steer: false, duplicated: true });
    expect(await rig.events()).toHaveLength(events.length);
  });

  test("I3: pushed watermarks never exceed the persisted log", async () => {
    const rig = await createRig({ turns: [{ deltas: ["a"] }] });
    const upgrade = await rig.stub.fetch(
      new Request("https://agent-do.test/ws", { headers: { Upgrade: "websocket" } }),
    );
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    if (socket === null) throw new Error("no client socket returned");
    socket.accept();
    const watermarks: number[] = [];
    socket.addEventListener("message", (event) => {
      if (!("data" in event)) return;
      const frame = JSON.parse(String(event.data)) as {
        type?: string;
        metadata?: { latestSeq?: number };
      };
      if (frame.type === "changed" && typeof frame.metadata?.latestSeq === "number") {
        watermarks.push(frame.metadata.latestSeq);
      }
    });
    socket.send(
      JSON.stringify({
        type: "subscribe",
        target: { kind: "thread-detail", threadId: rig.threadId },
      }),
    );

    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-3",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    const finalEvents = await rig.waitTurnComplete(sent.turnId);
    const maxSeq = finalEvents[finalEvents.length - 1]?.seq ?? 0;
    await rig.waitFor(() => (watermarks.at(-1) ?? 0) >= maxSeq);

    const events = await rig.events();
    let previous = 0;
    for (const watermark of watermarks) {
      expect(watermark).toBeLessThanOrEqual(maxSeq);
      // Contiguity: a pushed watermark of N means N events existed in the log.
      expect(events.filter((event) => event.seq <= watermark)).toHaveLength(watermark);
      expect(watermark).toBeGreaterThan(previous);
      previous = watermark;
    }
    socket.close();
  });
});

describe("§7 invariants — execution idempotency and causality", () => {
  test("I4: every dispatch lands after its tool.call is durable", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    await completeToolTurn(rig, "in-4");
    const events = await rig.events();
    const callSeqs = new Set(
      events.filter((event) => event.type === "tool.call").map((event) => event.seq),
    );
    const dispatches = events.filter((event) => event.type === "tool.dispatch");
    expect(dispatches.length).toBeGreaterThan(0);
    for (const dispatch of dispatches) {
      const callSeq = callSeqFromExecutionId(dispatch.data.executionId);
      expect(callSeqs.has(callSeq)).toBe(true);
      expect(dispatch.seq).toBeGreaterThan(callSeq);
    }
  });

  test("I5: executionId ≡ threadId:callSeq and maps to exactly one tool.call", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    const { executionId } = await completeToolTurn(rig, "in-5");
    const events = await rig.events();
    const callSeqs = events.filter((event) => event.type === "tool.call").map((event) => event.seq);
    expect(callSeqs).toHaveLength(1);
    const derived = new Set(callSeqs.map((seq) => executionIdFor(rig.threadId, seq)));
    expect(derived.has(executionId)).toBe(true);

    const references: string[] = [];
    for (const event of events) {
      if (
        event.type === "tool.dispatch" ||
        event.type === "tool.exec_started" ||
        event.type === "tool.output" ||
        event.type === "tool.result"
      ) {
        references.push(event.data.executionId);
      }
    }
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(derived.has(reference)).toBe(true);
      expect(threadIdFromExecutionId(reference)).toBe(rig.threadId);
    }
  });

  test("I6: duplicate result delivery appends nothing and re-acks", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    const { executionId } = await completeToolTurn(rig, "in-6");
    const before = await rig.events();
    expect(before.filter((event) => event.type === "tool.result")).toHaveLength(1);
    const acksBefore = (await journal(rig)).filter(
      (op) => op.op === "ack" && op.executionId === executionId,
    ).length;

    const duplicate = await rig.stub.onExecutionUpdate({
      kind: "exited",
      executionId,
      result: { status: "ok", exitCode: 0, output: "out" },
    });
    expect(duplicate).toEqual({ duplicate: true, acked: true });

    const after = await rig.events();
    expect(after).toHaveLength(before.length);
    expect(after.filter((event) => event.type === "tool.result")).toHaveLength(1);
    const acksAfter = (await journal(rig)).filter(
      (op) => op.op === "ack" && op.executionId === executionId,
    ).length;
    expect(acksAfter).toBe(acksBefore + 1);
  });

  test("I7: call < exec_started < result in seq order", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    const { executionId } = await completeToolTurn(rig, "in-7");
    const events = await rig.events();
    const call = requireEvent(events, "tool.call", "for the execution");
    const started = requireEvent(events, "tool.exec_started", "for the execution");
    const result = requireEvent(events, "tool.result", "for the execution");
    expect(executionIdFor(rig.threadId, call.seq)).toBe(executionId);
    expect(started.data.executionId).toBe(executionId);
    expect(result.data.executionId).toBe(executionId);
    expect(started.seq).toBeGreaterThan(call.seq);
    expect(result.seq).toBeGreaterThan(started.seq);
  });
});

describe("§7 invariants — turn lifecycle", () => {
  test("I8: input during an active turn records a steer, never a second turn", async () => {
    const rig = await createRig({ turns: [{ hang: true }] });
    const first = await rig.stub.sendMessage({
      clientRequestId: "in-8a",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await rig.waitFor((all) => all.some((event) => event.type === "model.call_started"));

    const second = await rig.stub.sendMessage({
      clientRequestId: "in-8b",
      content: [{ type: "text", text: "steer please" }],
      mode: "auto",
    });
    expect(second).toMatchObject({ turnId: first.turnId, steer: true });

    const events = await rig.events();
    expect(events.filter((event) => event.type === "turn.input")).toHaveLength(1);
    const steers = events.filter((event) => event.type === "turn.steer");
    expect(steers).toHaveLength(1);
    expect(steers[0]?.data.turnId).toBe(first.turnId);

    await rig.stub.cancelTurn({ turnId: first.turnId });
    await rig.waitTurnComplete(first.turnId);
  });

  test("I9: a persisted steer is consumed by the next model call", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-9",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    const executionId = await pendingExecutionId(rig);
    const steer = await rig.stub.sendMessage({
      clientRequestId: "in-9-steer",
      content: [{ type: "text", text: "aim lower" }],
      mode: "auto",
    });
    expect(steer.steer).toBe(true);

    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: "" });
    await rig.waitTurnComplete(sent.turnId);

    const events = await rig.events();
    const steerEvent = requireEvent(events, "turn.steer", "for the turn");
    const nextCall = events.find(
      (event): event is AgentEventRecord<"model.call_started"> =>
        isEventType(event, "model.call_started") && event.seq > steerEvent.seq,
    );
    if (nextCall === undefined) throw new Error("no model call after the steer");
    expect(nextCall.data.consumedSteerSeqs).toContain(steerEvent.seq);
  });

  test("I10: nothing new starts after cancel_requested; exactly one terminal", async () => {
    const rig = await createRig({ turns: [{ hang: true }] });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-10",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await rig.waitFor((all) => all.some((event) => event.type === "model.call_started"));
    expect(await rig.stub.cancelTurn({ turnId: sent.turnId })).toEqual({ accepted: true });
    const events = await rig.waitTurnComplete(sent.turnId);

    const cancel = requireEvent(events, "turn.cancel_requested", "for the turn");
    const afterCancel = events.filter(
      (event) =>
        event.seq > cancel.seq && "turnId" in event.data && event.data.turnId === sent.turnId,
    );
    expect(afterCancel.some((event) => event.type === "model.call_started")).toBe(false);
    expect(afterCancel.some((event) => event.type === "tool.call")).toBe(false);

    const isTerminalForTurn = (
      event: AnyAgentEvent,
    ): event is Extract<
      AnyAgentEvent,
      { type: "turn.completed" | "turn.failed" | "turn.cancelled" }
    > =>
      isEventType(event, "turn.completed") ||
      isEventType(event, "turn.failed") ||
      isEventType(event, "turn.cancelled");
    const terminals = events.filter(
      (event) => isTerminalForTurn(event) && event.data.turnId === sent.turnId,
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("turn.cancelled");
  });
});

describe("§7 invariants — model-call accounting", () => {
  test("I11: provider calls ≡ model.call_started; eviction mid-stream never re-calls", async () => {
    // Warm path: one call attempt per started event.
    const warm = await createRig({ turns: [{ deltas: ["x"] }] });
    const warmSent = await warm.stub.sendMessage({
      clientRequestId: "in-11a",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await warm.waitTurnComplete(warmSent.turnId);
    const warmEvents = await warm.events();
    expect(warm.provider.callCount()).toBe(
      warmEvents.filter((event) => event.type === "model.call_started").length,
    );

    // Seal path: evict mid-call; recovery seals instead of re-calling.
    const hung = await createRig({ turns: [{ hang: true }] });
    const hungSent = await hung.stub.sendMessage({
      clientRequestId: "in-11b",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await hung.waitFor((all) => all.some((event) => event.type === "model.call_started"));
    expect(hung.provider.callCount()).toBe(1);

    await abortAllDurableObjects();
    await hung.afterAbort(() => hung.events());
    const revived = await hung.waitTurnComplete(hungSent.turnId);
    expect(revived.some((event) => event.type === "model.call_sealed")).toBe(true);
    expect(
      revived.some(
        (event) =>
          event.type === "turn.failed" && event.data.reason === "interrupted_mid_stream",
      ),
    ).toBe(true);
    expect(revived.filter((event) => event.type === "model.call_started")).toHaveLength(1);
    expect(hung.provider.callCount()).toBe(1);
  });

  test("I12: every modelCallId has exactly one terminal event", async () => {
    const completed = await createRig({ turns: [{ deltas: ["x"] }] });
    const completedSent = await completed.stub.sendMessage({
      clientRequestId: "in-12a",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await completed.waitTurnComplete(completedSent.turnId);

    const sealed = await createRig({
      turns: [{ deltas: ["aa", "bb", "cc"], failMidStreamAfter: 2 }],
      watchdog: { deltaFlushBytes: 1, deltaFlushMs: 1 },
    });
    const sealedSent = await sealed.stub.sendMessage({
      clientRequestId: "in-12b",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await sealed.waitTurnComplete(sealedSent.turnId);

    const retried = await createRig({
      turns: [{ failBeforeFirstByte: { message: "boom", retryable: true } }, { deltas: ["ok"] }],
      watchdog: { retryBackoffBaseMs: 1 },
    });
    const retriedSent = await retried.stub.sendMessage({
      clientRequestId: "in-12c",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await retried.waitTurnComplete(retriedSent.turnId);

    const cancelled = await createRig({ turns: [{ hang: true }] });
    const cancelledSent = await cancelled.stub.sendMessage({
      clientRequestId: "in-12d",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await cancelled.waitFor((all) => all.some((event) => event.type === "model.call_started"));
    await cancelled.stub.cancelTurn({ turnId: cancelledSent.turnId });
    await cancelled.waitTurnComplete(cancelledSent.turnId);

    for (const rig of [completed, sealed, retried, cancelled]) {
      const events = await rig.events();
      const callIds = events
        .filter((event) => event.type === "model.call_started")
        .map((event) => event.seq);
      expect(callIds.length).toBeGreaterThan(0);
      for (const id of callIds) {
        const terminals = events.filter(
          (event) =>
            (event.type === "model.call_completed" ||
              event.type === "model.call_sealed" ||
              event.type === "model.call_failed") &&
            event.data.modelCallId === id,
        );
        expect(terminals).toHaveLength(1);
      }
    }
  });

  test("I13: no model.delta follows the seal", async () => {
    const rig = await createRig({
      turns: [{ deltas: ["aaaa", "bbbb", "cccc"], failMidStreamAfter: 2 }],
      watchdog: { deltaFlushBytes: 1, deltaFlushMs: 1 },
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-13",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await rig.waitTurnComplete(sent.turnId);
    const events = await rig.events();
    const seal = requireEvent(events, "model.call_sealed", "after the mid-stream break");
    const deltas = events.filter(
      (event) =>
        event.type === "model.delta" &&
        event.data.modelCallId === seal.data.modelCallId &&
        event.seq > seal.seq,
    );
    expect(deltas).toHaveLength(0);
    // Meaningfulness: at least one delta was persisted before the seal.
    expect(
      events.some(
        (event) =>
          event.type === "model.delta" && event.data.modelCallId === seal.data.modelCallId,
      ),
    ).toBe(true);
  });
});

describe("§7 invariants — recovery", () => {
  test("I14: replay is deterministic; cold start folds the same log", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-14",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    await pendingExecutionId(rig); // park mid-turn: execution non-terminal

    const before = await liveState(rig);
    const logBefore = await rig.events();
    expect(canonical(replayEvents(logBefore))).toEqual(before);
    expect(canonical(replayEvents(logBefore))).toEqual(canonical(replayEvents(logBefore)));

    await abortAllDurableObjects();
    await rig.afterAbort(() => rig.events()); // revival + recovery verbs
    const after = await liveState(rig);
    const logAfter = await rig.events();
    expect(after).toEqual(canonical(replayEvents(logAfter)));

    // Dedup indices were rebuilt from the log, not memory.
    const again = await rig.stub.sendMessage({
      clientRequestId: "in-14",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    expect(again.duplicated).toBe(true);
    expect(await rig.events()).toHaveLength(logAfter.length);

    const call = logAfter.find((event) => event.type === "tool.call");
    if (call === undefined) throw new Error("tool.call missing after revival");
    const executionId = executionIdFor(rig.threadId, call.seq);
    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: "" });
    await rig.waitTurnComplete(sent.turnId);
  });

  test("I15: the watchdog re-asks a silent execution with the same executionId", async () => {
    const rig = await createRig({
      turns: TOOL_TURN,
      watchdog: { execTimeoutMs: 10, execGraceMs: 10 },
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-15",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    const executionId = await pendingExecutionId(rig);
    const before = await rig.events();
    expect(
      before.filter(
        (event) => event.type === "tool.dispatch" && event.data.executionId === executionId,
      ),
    ).toHaveLength(1);

    expect(await runDurableObjectAlarm(rig.stub)).toBe(true);
    const after = await rig.waitFor(
      (all) =>
        all.filter(
          (event) =>
            event.type === "tool.dispatch" && event.data.executionId === executionId,
        ).length >= 2,
    );
    const dispatches = after.filter(
      (event): event is AgentEventRecord<"tool.dispatch"> =>
        isEventType(event, "tool.dispatch") && event.data.executionId === executionId,
    );
    expect(dispatches[1]?.data.attempt).toBe(2);
    // The re-ask never spawned twice — the journal is the dedup point.
    expect(await rig.service.spawnAckCount(executionId)).toBe(1);

    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: "" });
    await rig.waitTurnComplete(sent.turnId);
  });

  test("I16: eviction before the result — journal dedup keeps the spawn count at 1", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-16",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    const executionId = await pendingExecutionId(rig);
    expect(await rig.service.spawnAckCount(executionId)).toBe(1);

    await abortAllDurableObjects();
    await rig.afterAbort(() => rig.events()); // both DOs revive; journal replays

    // Recovery re-dispatched; the journal answered from its records.
    expect(await rig.service.spawnAckCount(executionId)).toBe(1);
    expect(await rig.service.derivedState(executionId)).toBe("RUNNING");

    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: "out" });
    const finalEvents = await rig.waitTurnComplete(sent.turnId);
    expect(
      finalEvents.filter(
        (event) => event.type === "tool.result" && event.data.executionId === executionId,
      ),
    ).toHaveLength(1);
    expect(await rig.service.spawnAckCount(executionId)).toBe(1);
  });
});

describe("§7 invariants — daemon-service contract (reference fake = #30 wire shape)", () => {
  test("I17: replacement closes the old session; grace keeps in-flight undisturbed", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-17",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    const executionId = await pendingExecutionId(rig);

    const first = await rig.service.dial("host-a");
    expect(first.replaced).toBe(false);
    const second = await rig.service.dial("host-a");
    expect(second.replaced).toBe(true);
    expect((await journal(rig)).some((op) => op.op === "session_replaced")).toBe(true);

    const stale = await rig.service.clientMessage("host-a", first.sessionId);
    expect(stale.accepted).toBe(false);
    expect((await journal(rig)).some((op) => op.op === "stale_session_rejected")).toBe(true);

    // Inside the grace window nothing is marked orphaned.
    expect((await journal(rig)).some((op) => op.op === "orphan_suspect")).toBe(false);
    expect(await rig.service.derivedState(executionId)).toBe("RUNNING");

    const suspects = await rig.service.lapseLease("host-a");
    expect(suspects).toEqual([executionId]);
    expect((await journal(rig)).filter((op) => op.op === "orphan_suspect")).toHaveLength(1);

    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: "" });
    await rig.waitTurnComplete(sent.turnId);
  });

  test("I18: new-boot restart kill-list exactly covers old RUNNING; outcome_unknown lands", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-18",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    const executionId = await pendingExecutionId(rig);

    await rig.service.clientDisconnect();
    await rig.service.clientRestartNewBoot();
    const kills = await rig.service.clientKills();
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ executionId, verified: true });

    const events = await rig.waitFor((all) =>
      all.some(
        (event) =>
          event.type === "tool.result" &&
          event.data.executionId === executionId &&
          event.data.status === "outcome_unknown",
      ),
    );
    const result = requireEvent(events, "tool.result", "with outcome_unknown");
    expect(
      events.filter(
        (event) =>
          event.type === "tool.output" &&
          event.data.executionId === executionId &&
          event.seq > result.seq,
      ),
    ).toHaveLength(0);
    await rig.waitTurnComplete(sent.turnId);
  });

  test("I19: journal replay reconstructs identical derived state", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-19",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    const executionId = await pendingExecutionId(rig);
    await rig.service.clientEmitOutput(executionId, "chunk-one");

    const replay = await rig.service.evictAndReplayState([executionId]);
    expect(replay.statesBefore).toEqual(replay.statesAfter);
    expect(replay.offsetsBefore).toEqual(replay.offsetsAfter);
    expect(replay.offsetsBefore[executionId]).toBe("chunk-one".length);

    // The durable mirror survives a hard abort of the whole DO.
    await abortAllDurableObjects();
    await rig.afterAbort(() => rig.service.journal());
    expect(await rig.service.derivedState(executionId)).toBe("RUNNING");
    expect(await rig.service.spawnAckCount(executionId)).toBe(1);

    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: "chunk-one" });
    await rig.waitTurnComplete(sent.turnId);
  });

  test("I20: overlapping resume bytes dedup once; gaps are explicit markers", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-20",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    const executionId = await pendingExecutionId(rig);

    await rig.service.clientEmitOutput(executionId, "abc");
    await rig.service.clientDisconnect();
    await rig.service.clientReconnectSameBoot();
    // At-least-once resend: the acked overlap is dropped, the tail lands once.
    await rig.service.clientResendFrom(executionId, 0, "abc");
    await rig.service.clientResendFrom(executionId, 3, "def");

    const ops = (await journal(rig)).filter(
      (op) => "executionId" in op && op.executionId === executionId,
    );
    expect(ops.filter((op) => op.op === "output")).toEqual([
      { op: "output", executionId, offset: 0, bytes: 3 },
      { op: "output", executionId, offset: 3, bytes: 3 },
    ]);
    expect(ops.filter((op) => op.op === "output_dup_dropped")).toEqual([
      { op: "output_dup_dropped", executionId, offset: 0 },
    ]);

    // Lost bytes are never silent: an explicit gap marker covers the range.
    await rig.service.clientReportGap(executionId, 6, 9);
    const gaps = (await journal(rig)).filter(
      (op) => op.op === "output_gap" && op.executionId === executionId,
    );
    expect(gaps).toEqual([{ op: "output_gap", executionId, from: 6, to: 9 }]);

    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: "abcdef" });
    await rig.waitTurnComplete(sent.turnId);
  });

  test("I21: tombstone only after ack; duplicates re-ack; result stays unique", async () => {
    const rig = await createRig({ turns: TOOL_TURN });
    await rig.service.setFailNextAcks(1);
    const { executionId } = await completeToolTurn(rig, "in-21");

    const events = await rig.events();
    expect(
      events.filter(
        (event) => event.type === "tool.result" && event.data.executionId === executionId,
      ),
    ).toHaveLength(1);
    // The injected ack loss left the result claimable, not tombstoned.
    expect(await rig.service.tombstoned(executionId)).toBe(false);
    const unacked = await rig.service.queryUnacked(rig.threadId);
    expect(unacked.map((entry) => entry.executionId)).toContain(executionId);

    const duplicate = await rig.stub.onExecutionUpdate({
      kind: "exited",
      executionId,
      result: { status: "ok", exitCode: 0, output: "out" },
    });
    expect(duplicate).toEqual({ duplicate: true, acked: true });
    expect(await rig.service.tombstoned(executionId)).toBe(true);
    expect(
      (await rig.events()).filter(
        (event) => event.type === "tool.result" && event.data.executionId === executionId,
      ),
    ).toHaveLength(1);
  });

  test("I22: kills verify pid+pidStartedAt; unlisted processes untouched", async () => {
    // Positive: an honest restart verifies and kills exactly the listed entry.
    const honest = await createRig({ turns: TOOL_TURN });
    const honestSent = await honest.stub.sendMessage({
      clientRequestId: "in-22a",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    const honestExecution = await pendingExecutionId(honest);
    await honest.service.clientDisconnect();
    await honest.service.clientRestartNewBoot();
    const honestKills = await honest.service.clientKills();
    expect(honestKills).toHaveLength(1);
    expect(honestKills[0]).toMatchObject({ executionId: honestExecution, verified: true });
    await honest.waitTurnComplete(honestSent.turnId);

    // Negative: pid reuse + a foreign marker process stay untouched.
    const trap = await createRig({ turns: TOOL_TURN });
    const trapSent = await trap.stub.sendMessage({
      clientRequestId: "in-22b",
      content: [{ type: "text", text: TEXT }],
      mode: "auto",
    });
    const trapExecution = await pendingExecutionId(trap);
    const spawnAck = (await journal(trap)).find(
      (op): op is Extract<FakeJournalOp, { op: "spawn_ack" }> =>
        op.op === "spawn_ack" && op.executionId === trapExecution,
    );
    if (spawnAck === undefined) throw new Error("spawn_ack missing from journal");
    // Same pid number, different start time — the reuse trap.
    await trap.service.clientReusePid(spawnAck.pid);
    await trap.service.clientAddForeignProcess();
    await trap.service.clientDisconnect();
    await trap.service.clientRestartNewBoot();

    const trapKills = await trap.service.clientKills();
    expect(trapKills).toHaveLength(1);
    expect(trapKills[0]).toMatchObject({
      executionId: trapExecution,
      pid: spawnAck.pid,
      pidStartedAt: spawnAck.pidStartedAt,
      verified: false, // start-time mismatch → SIGKILL withheld
    });
    expect(
      trapKills.some(
        (kill) => kill.executionId === "__foreign__" || kill.executionId === "__reused__",
      ),
    ).toBe(false);
    await trap.waitTurnComplete(trapSent.turnId);
  });
});
