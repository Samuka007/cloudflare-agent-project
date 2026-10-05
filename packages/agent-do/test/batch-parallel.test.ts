import { afterEach, expect, test } from "vitest";
import { abortAllDurableObjects } from "cloudflare:test";
import { createRig, resetRuntime, type Rig } from "./helpers.js";
import { executionIdFor } from "../src/ids.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import type { FakeJournalOp } from "../src/testing/fake-daemon.js";
import type { ToolResultPayload } from "../src/daemon.js";

/**
 * #328 C3 L1 — conflict-aware batch scheduling end-to-end against the agent
 * DO + the reference fake daemon-service: a read-only batch dispatches as
 * one wave and settles clearly faster than a serial schedule would allow
 * (the ticket's timing assertion), same-file write/write and read/write
 * conflicts serialize (the later dispatch is journaled only after the
 * earlier result), and a cancel mid-batch seals the waves that never
 * dispatched so the turn converges.
 *
 * Wall-clock numbers are deliberately loose (CI jitter) — the structural
 * seq-ordering assertions carry the exactness, the timing assertion only
 * has to separate ~one-fake-latency parallel from ≥N×-fake-latency serial.
 */

afterEach(() => {
  resetRuntime();
});

/**
 * Fake tool latency for every driven exit.
 *
 * REAL platform clock by contract: the L1 rig drives workerd's own timers
 * (docs/research/testing-strategy-cloudflare-do.md — there is no injectable
 * clock at this seam to fake, helpers.ts eviction drills run on the same
 * basis), and the ticket's acceptance IS a wall-clock comparison of
 * parallel vs serial batch settlement. Every other wait in this file is
 * event-driven (`rig.waitFor`); the only fixed delay is the simulated tool
 * runtime itself.
 */
const FAKE_TOOL_MS = 100;

const OK: ToolResultPayload = { status: "ok", exitCode: null, output: "payload" };

const FINAL = { deltas: ["done"] };

/** The DO RPC returns unknown[]; the journal is this package's own type. */
function journal(rig: Rig): Promise<FakeJournalOp[]> {
  return rig.service.journal() as Promise<FakeJournalOp[]>;
}

function toolCallsOf(
  events: readonly AnyAgentEvent[],
): Extract<AnyAgentEvent, { type: "tool.call" }>[] {
  return events.filter(
    (event): event is Extract<AnyAgentEvent, { type: "tool.call" }> => event.type === "tool.call",
  );
}

function resultSeqsOf(events: readonly AnyAgentEvent[], executionIds: string[]): number[] {
  return events
    .filter(
      (event): event is Extract<AnyAgentEvent, { type: "tool.result" }> =>
        event.type === "tool.result" && executionIds.includes(event.data.executionId),
    )
    .map((event) => event.seq);
}

function dispatchSeqsOf(events: readonly AnyAgentEvent[], executionIds: string[]): number[] {
  return events
    .filter(
      (event): event is Extract<AnyAgentEvent, { type: "tool.dispatch" }> =>
        event.type === "tool.dispatch" && executionIds.includes(event.data.executionId),
    )
    .map((event) => event.seq);
}

interface ExitPolicy {
  /** Result for a dispatched execution; null = leave it running. */
  resultFor: (executionId: string) => ToolResultPayload | null;
}

/**
 * Exit every execution in `executionIds` after the fake tool latency.
 *
 * REAL platform clock by necessity: the L1 rig has no injectable clock at
 * this seam (workerd timers, docs/research/testing-strategy-cloudflare-do.md)
 * and the ticket's acceptance IS a wall-clock comparison — the fake tool
 * latency is the measured instrument, not a race-masking sleep. All other
 * waits in this file are event-driven.
 */
function fireDelayedExits(rig: Rig, executionIds: string[], result: ToolResultPayload): void {
  for (const executionId of executionIds) {
    setTimeout(() => {
      void rig.service.clientExit(executionId, result);
    }, FAKE_TOOL_MS);
  }
}

/**
 * Drive the fake daemon client the way a real one behaves: every dispatch is
 * observed from the service journal and exits after FAKE_TOOL_MS (parallel
 * exits — the timers fire independently, never staggered by the poll loop).
 * Returns when the turn reaches a terminal event.
 */
async function driveExitsUntilTurnComplete(
  rig: Rig,
  turnId: string,
  policy: ExitPolicy,
): Promise<void> {
  const scheduled = new Set<string>();
  for (;;) {
    const events = await rig.events();
    if (
      events.some(
        (event) =>
          (event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.cancelled") &&
          event.data.turnId === turnId,
      )
    ) {
      return;
    }
    for (const op of await journal(rig)) {
      if (op.op !== "dispatch" || scheduled.has(op.executionId)) continue;
      scheduled.add(op.executionId);
      const result = policy.resultFor(op.executionId);
      if (result === null) continue;
      fireDelayedExits(rig, [op.executionId], result);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function sendMessage(rig: Rig, clientRequestId: string): Promise<{ turnId: string }> {
  const sent = await rig.stub.sendMessage({
    clientRequestId,
    content: [{ type: "text", text: "run the batch" }],
    mode: "start",
  });
  return { turnId: sent.turnId };
}

test("a read-only batch dispatches as one wave and beats the serial schedule", async () => {
  const paths = ["a.md", "b.md", "c.md", "d.md"];
  const rig = await createRig({
    turns: [{ toolCalls: paths.map((path) => ({ name: "read", arguments: { path } })) }, FINAL],
  });
  const { turnId } = await sendMessage(rig, "in-reads");
  // Fire all four exits from ONE observation: the driver waits until the
  // whole wave is dispatched, then exits everything simultaneously — so
  // result-arrival spread measures the scheduler, never the driver.
  await rig.waitFor((all) => {
    const ids = toolCallsOf(all).map((call) => executionIdFor(rig.threadId, call.seq));
    return dispatchSeqsOf(all, ids).length === ids.length && ids.length === 4;
  });
  const ops = await journal(rig);
  fireDelayedExits(
    rig,
    ops.filter((op) => op.op === "dispatch").map((op) => op.executionId),
    OK,
  );
  await rig.waitTurnComplete(turnId);
  const events = await rig.events();

  const executionIds = toolCallsOf(events).map((call) => executionIdFor(rig.threadId, call.seq));
  expect(executionIds).toHaveLength(4);

  // Structural: the whole wave dispatched before any result existed.
  const dispatchSeqs = dispatchSeqsOf(events, executionIds);
  const resultSeqs = resultSeqsOf(events, executionIds);
  expect(dispatchSeqs).toHaveLength(4);
  expect(resultSeqs).toHaveLength(4);
  expect(Math.max(...dispatchSeqs)).toBeLessThan(Math.min(...resultSeqs));

  // Timing (the ticket's L1 assertion): a serial schedule pays
  // (k−1) × FAKE_TOOL_MS of pure dispatch stall — the wave's dispatch AND
  // settlement each spread across ≥ 300 ms — while the parallel wave pays
  // the fake latency once and both spreads collapse into one tick. The
  // bound is one fake latency; cross-DO ingestion overhead cancels out of
  // a spread, so the margin is ~3× either way.
  const createdAts = (type: "tool.dispatch" | "tool.result"): number[] =>
    events
      .filter(
        (event): event is Extract<AnyAgentEvent, { type: typeof type }> =>
          event.type === type && executionIds.includes(event.data.executionId),
      )
      .map((event) => event.createdAt);
  const dispatchCreated = createdAts("tool.dispatch");
  const resultCreated = createdAts("tool.result");
  expect(Math.max(...dispatchCreated) - Math.min(...dispatchCreated)).toBeLessThan(FAKE_TOOL_MS);
  expect(Math.max(...resultCreated) - Math.min(...resultCreated)).toBeLessThan(FAKE_TOOL_MS);
});

test("same-file writes serialize: the second dispatch is journaled after the first result", async () => {
  const rig = await createRig({
    turns: [
      {
        toolCalls: [
          { name: "write", arguments: { path: "a.txt", content: "one" } },
          { name: "write", arguments: { path: "a.txt", content: "two" } },
        ],
      },
      FINAL,
    ],
  });
  const { turnId } = await sendMessage(rig, "in-writes");
  await driveExitsUntilTurnComplete(rig, turnId, { resultFor: () => OK });
  const events = await rig.events();

  const [firstId, secondId] = toolCallsOf(events).map((call) =>
    executionIdFor(rig.threadId, call.seq),
  );
  if (firstId === undefined || secondId === undefined) throw new Error("calls missing");
  const [firstResult] = resultSeqsOf(events, [firstId]);
  const [secondDispatch] = dispatchSeqsOf(events, [secondId]);
  expect(firstResult).toBeDefined();
  expect(secondDispatch).toBeDefined();
  expect(secondDispatch).toBeGreaterThan(firstResult ?? Number.MAX_SAFE_INTEGER);
});

test("different-file writes stay parallel: one wave, both dispatched before any result", async () => {
  const rig = await createRig({
    turns: [
      {
        toolCalls: [
          { name: "write", arguments: { path: "a.txt", content: "one" } },
          { name: "write", arguments: { path: "b.txt", content: "two" } },
        ],
      },
      FINAL,
    ],
  });
  const { turnId } = await sendMessage(rig, "in-writes-distinct");
  await driveExitsUntilTurnComplete(rig, turnId, { resultFor: () => OK });
  const events = await rig.events();
  const executionIds = toolCallsOf(events).map((call) => executionIdFor(rig.threadId, call.seq));
  const dispatchSeqs = dispatchSeqsOf(events, executionIds);
  const resultSeqs = resultSeqsOf(events, executionIds);
  expect(Math.max(...dispatchSeqs)).toBeLessThan(Math.min(...resultSeqs));
});

test("read/write on one file serialize; the write waits for the read result", async () => {
  const rig = await createRig({
    turns: [
      {
        toolCalls: [
          { name: "read", arguments: { path: "a.txt" } },
          { name: "write", arguments: { path: "a.txt", content: "next" } },
        ],
      },
      FINAL,
    ],
  });
  const { turnId } = await sendMessage(rig, "in-read-write");
  await driveExitsUntilTurnComplete(rig, turnId, { resultFor: () => OK });
  const events = await rig.events();
  const [readId, writeId] = toolCallsOf(events).map((call) =>
    executionIdFor(rig.threadId, call.seq),
  );
  if (readId === undefined || writeId === undefined) throw new Error("calls missing");
  const [readResult] = resultSeqsOf(events, [readId]);
  const [writeDispatch] = dispatchSeqsOf(events, [writeId]);
  expect(writeDispatch).toBeGreaterThan(readResult ?? Number.MAX_SAFE_INTEGER);
});

test("cancel mid-batch seals the undispatched wave so the turn converges", async () => {
  const rig = await createRig({
    turns: [
      {
        toolCalls: [
          { name: "bash", arguments: { command: "sleep 600" } },
          { name: "write", arguments: { path: "a.txt", content: "later" } },
        ],
      },
      FINAL,
    ],
  });
  const { turnId } = await sendMessage(rig, "in-cancel");
  // bash is the unkeyed barrier: the write must still be undispatched while
  // bash runs. Cancel now — the write is sealed cancelled, never dispatched.
  const events = await rig.waitFor((all) =>
    all.some((event) => event.type === "tool.exec_started"),
  );
  const writeCall = toolCallsOf(events).find((call) => call.data.tool === "write");
  if (writeCall === undefined) throw new Error("write call missing");
  const writeId = executionIdFor(rig.threadId, writeCall.seq);
  expect(dispatchSeqsOf(events, [writeId])).toEqual([]);

  expect(await rig.stub.cancelTurn({ turnId })).toEqual({ accepted: true });
  const final = await rig.waitTurnComplete(turnId);

  expect(final.some((event) => event.type === "turn.cancelled")).toBe(true);
  const sealed = final.find(
    (event): event is Extract<AnyAgentEvent, { type: "tool.result" }> =>
      event.type === "tool.result" && event.data.executionId === writeId,
  );
  expect(sealed?.data.status).toBe("cancelled");
  // The sealed row never rode the daemon: no dispatch, no spawn, no ack.
  expect(dispatchSeqsOf(final, [writeId])).toEqual([]);
  const ops = await journal(rig);
  expect(ops.some((op) => op.op === "dispatch" && op.executionId === writeId)).toBe(false);
});

test("eviction mid-batch: recovery re-asks in wave order — no double spawn, no concurrent conflict", async () => {
  const rig = await createRig({
    turns: [
      {
        toolCalls: [
          { name: "write", arguments: { path: "a.txt", content: "one" } },
          { name: "write", arguments: { path: "a.txt", content: "two" } },
        ],
      },
      FINAL,
    ],
  });
  const { turnId } = await sendMessage(rig, "in-evict");
  const dispatched = await rig.waitFor((all) =>
    all.some((event) => event.type === "tool.dispatch"),
  );
  const [firstId, secondId] = toolCallsOf(dispatched).map((call) =>
    executionIdFor(rig.threadId, call.seq),
  );
  if (firstId === undefined || secondId === undefined) throw new Error("calls missing");
  expect(dispatchSeqsOf(dispatched, [secondId])).toEqual([]);

  // Hard-kill both DOs mid-batch; the revived agent re-runs recovery verbs.
  await abortAllDurableObjects();
  const revived = await rig.afterAbort(() => rig.events());

  // Recovery re-asked the live first write through the service journal —
  // dedup re-attached, never a second spawn (I16).
  expect(await rig.service.spawnAckCount(firstId)).toBe(1);
  expect(dispatchSeqsOf(revived, [secondId])).toEqual([]);

  // The second write still cannot dispatch while the first is non-terminal:
  // the recovery wave driver settles wave 0 before dispatching wave 1
  // (bounded negative observation — recovery had ample time to violate).
  await expect
    .poll(async () => dispatchSeqsOf(await rig.events(), [secondId]).length, {
      timeout: 500,
      interval: 50,
    })
    .toBe(0);

  // Settle the first write; only then does the conflict wave dispatch.
  await rig.service.clientExit(firstId, OK);
  const afterFirst = await rig.waitFor((all) => {
    const [firstResult] = resultSeqsOf(all, [firstId]);
    const [secondDispatchSeq] = dispatchSeqsOf(all, [secondId]);
    return (
      firstResult !== undefined &&
      secondDispatchSeq !== undefined &&
      secondDispatchSeq > firstResult
    );
  });
  const [firstResult] = resultSeqsOf(afterFirst, [firstId]);
  const [secondDispatch] = dispatchSeqsOf(afterFirst, [secondId]);
  expect(secondDispatch).toBeGreaterThan(firstResult ?? Number.MAX_SAFE_INTEGER);

  await rig.service.clientExit(secondId, OK);
  await rig.waitTurnComplete(turnId);
});
