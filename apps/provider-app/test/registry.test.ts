import { afterEach, expect, test } from "vitest";
import { abortAllDurableObjects } from "cloudflare:test";
import type {
  AdapterCommand,
  AdapterCommandOutcome,
} from "../../daemon-worker/src/provider-adapter.js";
import {
  afterAbort,
  assertFailure,
  eventsOf,
  executionContext,
  expectOk,
  freshManagerName,
  managerFacadeByName,
  registerMock,
  resetRuntime,
  stringField,
  waitTurnComplete,
} from "./helpers.js";

/**
 * Session registry semantics (ticket #28 acceptance): durable across manager
 * DO eviction, one agent DO per thread (spawn/reuse), descriptor round-trip,
 * poisoning on interrupted stops, and consistency with the agent DO state.
 */

afterEach(() => {
  resetRuntime();
});

function startCommand(threadId: string): Extract<AdapterCommand, { type: "thread/start" }> {
  return {
    type: "thread/start",
    threadId,
    cwd: "/workspace",
    options: executionContext(),
    instructionMode: "append",
  };
}

function resumeCommand(
  threadId: string,
  providerThreadId: string,
): Extract<AdapterCommand, { type: "thread/resume" }> {
  return {
    type: "thread/resume",
    threadId,
    cwd: "/workspace",
    providerThreadId,
    options: executionContext(),
    instructionMode: "append",
  };
}

function turnCommand(
  threadId: string,
  providerThreadId: string,
  clientRequestId: string,
): Extract<AdapterCommand, { type: "turn/start" }> {
  return {
    type: "turn/start",
    threadId,
    providerThreadId,
    input: [{ type: "text", text: "hello", mentions: [] }],
    clientRequestId,
    options: executionContext(),
  };
}

async function call(managerName: string, command: AdapterCommand): Promise<AdapterCommandOutcome> {
  return managerFacadeByName(managerName).handleAdapterCommand(command);
}

/**
 * Lockstep with ManagerDo's descriptor formula — the test recomputes it so a
 * silent formula change on either side fails the round-trip assertions.
 */
function descriptorOf(providerThreadId: string): {
  sessionId: string;
  sessionFile: string;
} {
  return {
    sessionId: providerThreadId,
    sessionFile: `agent-do://${providerThreadId}/events.jsonl`,
  };
}

test("thread/start spawns one agent DO per thread and reuses it on restart", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  registerMock(threadId, [{ deltas: ["ok"] }]);

  const first = expectOk(await call(managerName, startCommand(threadId)));
  const second = expectOk(await call(managerName, startCommand(threadId)));
  expect(second.providerThreadId).toBe(first.providerThreadId);

  const other = expectOk(
    await call(managerName, startCommand(`thr-other-${crypto.randomUUID()}`)),
  );
  expect(other.providerThreadId).not.toBe(first.providerThreadId);

  // The agent DO holds exactly one thread.created — reuse did not double-spawn.
  const events = await eventsOf(first.threadId as string);
  expect(events.filter((event) => event.type === "thread.created")).toHaveLength(1);
});

test("registry survives manager DO eviction and stays consistent with the agent DO", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  registerMock(threadId, [{ deltas: ["after-restart"] }]);

  const started = expectOk(await call(managerName, startCommand(threadId)));
  const providerThreadId = started.providerThreadId as string;

  const descriptorBefore = expectOk(
    await call(managerName, resumeCommand(threadId, providerThreadId)),
  );

  await abortAllDurableObjects();

  // Fresh incarnation, same instance name: rows come back from SQLite.
  const descriptorAfter = expectOk(
    await afterAbort(() => call(managerName, resumeCommand(threadId, providerThreadId))),
  );
  expect(descriptorAfter.ompRecovery).toEqual(descriptorBefore.ompRecovery);
  expect(descriptorAfter.providerThreadId).toBe(providerThreadId);

  // Agent DO consistency: same DO name still owns the same thread and log.
  const events = await afterAbort(() => eventsOf(threadId));
  expect(events[0]?.type).toBe("thread.created");
  expect(events[0]?.data).toMatchObject({ machineId: "local" });

  // And the recovered thread still runs turns end-to-end.
  const sent = expectOk(
    await afterAbort(() =>
      call(managerName, turnCommand(threadId, providerThreadId, `creq-${crypto.randomUUID().slice(0, 8)}`)),
    ),
  );
  await afterAbort(() => waitTurnComplete(threadId, stringField(sent, "turnId")));
  const finalEvents = await eventsOf(threadId);
  expect(finalEvents.some((event) => event.type === "turn.completed")).toBe(true);
});

test("interrupted stop poisons the row; resume refuses without the descriptor", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  // A hanging mock keeps the turn active so the stop genuinely interrupts.
  registerMock(threadId, [{ hang: true }]);

  const started = expectOk(await call(managerName, startCommand(threadId)));
  const providerThreadId = started.providerThreadId as string;
  const sent = expectOk(
    await call(managerName, turnCommand(threadId, providerThreadId, `creq-${crypto.randomUUID().slice(0, 8)}`)),
  );

  const stopped = expectOk(
    await call(managerName, {
      type: "thread/stop",
      threadId,
      providerThreadId,
      activeTurnId: stringField(sent, "turnId"),
    }),
  );
  expect(stopped).toMatchObject({ interrupted: true });

  assertFailure(
    await call(managerName, resumeCommand(threadId, providerThreadId)),
    "session_recovery_required",
  );

  const recovered = expectOk(
    await call(managerName, {
      ...resumeCommand(threadId, providerThreadId),
      ompRecovery: descriptorOf(providerThreadId),
    }),
  );
  expect(recovered.ompRecovery).toEqual(descriptorOf(providerThreadId));
});

test("a lost registry can reattach from the daemon-held descriptor", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  registerMock(threadId, [{ deltas: ["ok"] }]);

  const started = expectOk(await call(managerName, startCommand(threadId)));
  const providerThreadId = started.providerThreadId as string;

  // Simulate total registry loss (fresh manager instance name).
  const fresh = expectOk(
    await call(freshManagerName(), {
      ...resumeCommand(threadId, providerThreadId),
      ompRecovery: descriptorOf(providerThreadId),
    }),
  );
  expect(fresh.providerThreadId).toBe(providerThreadId);
  // The intact agent DO still owned the thread — restorable.
  expect(fresh.sessionRestorable).toBe(true);
});

test("discard removes the row; later resume is thread_not_found", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  registerMock(threadId, [{ deltas: ["ok"] }]);

  const started = expectOk(await call(managerName, startCommand(threadId)));
  const providerThreadId = started.providerThreadId as string;

  expectOk(
    await call(managerName, { type: "thread/discard", threadId, providerThreadId }),
  );
  assertFailure(
    await call(managerName, resumeCommand(threadId, providerThreadId)),
    "thread_not_found",
  );
});
