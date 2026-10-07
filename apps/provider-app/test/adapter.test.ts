import { afterEach, expect, test } from "vitest";
import { abortAllDurableObjects } from "cloudflare:test";
import type {
  AdapterCommand,
  AdapterCommandOutcome,
} from "../../daemon-worker/src/provider-adapter.js";
import type { AvailableModel } from "../../daemon-worker/src/provider-types.js";
import { EdgeAgentProviderAdapter, type ManagerFacade } from "../src/adapter.js";
import { resolveHarness } from "../src/harness.js";
import {
  adapterFor,
  afterAbort,
  assertFailure,
  eventsOf,
  executionContext,
  expectOk,
  freshManagerName,
  managerFacadeByName,
  mockSelection,
  registerMock,
  resetRuntime,
  stringField,
  waitTurnComplete,
} from "./helpers.js";

/**
 * ProviderAdapter delegation (ticket #28): the full chain
 * thread/start → turn/start → event stream → thread/resume, steer semantics,
 * the timeout envelope, error mapping, and registry-only command answers.
 */

afterEach(() => {
  resetRuntime();
});

test("A4: the adapter's image-input capability mirrors the harness verdict", () => {
  // The declaration lives on the harness relay (MODEL_RELAY_IMAGE_INPUT);
  // the bb-facing capabilities bit can never disagree with the wire dispatch.
  const declared = new EdgeAgentProviderAdapter(
    { handleAdapterCommand: () => Promise.resolve({ ok: true, result: null }) },
    resolveHarness({ MODEL_RELAY_IMAGE_INPUT: "1" }),
  );
  expect(declared.capabilities.supportsImageInput).toBe(true);
  const undeclared = new EdgeAgentProviderAdapter(
    { handleAdapterCommand: () => Promise.resolve({ ok: true, result: null }) },
    resolveHarness({}),
  );
  expect(undeclared.capabilities.supportsImageInput).toBe(false);
});

function startCommand(threadId: string): Extract<AdapterCommand, { type: "thread/start" }> {
  return {
    type: "thread/start",
    threadId,
    cwd: "/workspace",
    options: executionContext(),
    instructionMode: "append",
    execution: mockSelection(),
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

async function handle(
  adapter: EdgeAgentProviderAdapter,
  command: AdapterCommand,
  timeoutMs = 10_000,
): Promise<AdapterCommandOutcome> {
  return adapter.handleCommand(command, { timeoutMs });
}

test("full chain: thread/start → turn/start → event stream → relay parity", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  const mock = registerMock(threadId, [{ deltas: ["hello ", "world"] }]);
  // #496: the model/list face advertises the channel the adapter's harness
  // names — this chain names glm-5.3 (zero-env adapters advertise nothing).
  const adapter = adapterFor(managerFacadeByName(managerName), {
    MODEL_RELAY_MODEL: "glm-5.3",
  });

  const init = await handle(adapter, { type: "initialize" });
  expect(expectOk(init)).toMatchObject({ protocolVersion: 1, provider: "edge-agent" });

  const started = expectOk(await handle(adapter, startCommand(threadId)));
  const providerThreadId = started.providerThreadId as string;

  const list = await handle(adapter, { type: "model/list" });
  const listResult = expectOk(list) as unknown as { models: AvailableModel[] };
  expect(listResult.models[0]?.model).toBe("glm-5.3");

  const sent = expectOk(
    await handle(
      adapter,
      turnCommand(threadId, providerThreadId, `creq-${crypto.randomUUID().slice(0, 8)}`),
    ),
  );
  expect(sent.agentInvoked).toBe(true);

  const turnId = stringField(sent, "turnId");
  const events = await waitTurnComplete(threadId, turnId);
  expect(events.map((event) => event.type)).toContain("turn.input");
  expect(events.map((event) => event.type)).toContain("model.call_started");
  expect(events.map((event) => event.type)).toContain("turn.completed");

  // Billing parity (I11): one mock call per billable model.call_started.
  const startedCalls = events.filter((event) => event.type === "model.call_started").length;
  expect(mock.callCount()).toBe(startedCalls);

  const resumed = expectOk(
    await handle(adapter, {
      type: "thread/resume",
      threadId,
      cwd: "/workspace",
      providerThreadId,
      options: executionContext(),
      instructionMode: "append",
    }),
  );
  expect(resumed.ompRecovery).toEqual({
    sessionId: providerThreadId,
    sessionFile: `agent-do://${providerThreadId}/events.jsonl`,
  });
});

test("full chain survives manager + agent DO eviction through the adapter", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  registerMock(threadId, [{ deltas: ["post-eviction"] }]);
  const adapter = adapterFor(managerFacadeByName(managerName));

  const started = expectOk(await handle(adapter, startCommand(threadId)));
  const providerThreadId = started.providerThreadId as string;
  const firstTurn = expectOk(
    await handle(
      adapter,
      turnCommand(threadId, providerThreadId, `creq-${crypto.randomUUID().slice(0, 8)}`),
    ),
  );
  await waitTurnComplete(threadId, stringField(firstTurn, "turnId"));

  await abortAllDurableObjects();

  const freshAdapter = adapterFor(managerFacadeByName(managerName));
  const resumed = expectOk(
    await afterAbort(() =>
      handle(freshAdapter, {
        type: "thread/resume",
        threadId,
        cwd: "/workspace",
        providerThreadId,
        options: executionContext(),
        instructionMode: "append",
      }),
    ),
  );
  expect(resumed.providerThreadId).toBe(providerThreadId);

  const secondTurn = expectOk(
    await afterAbort(() =>
      handle(
        freshAdapter,
        turnCommand(threadId, providerThreadId, `creq-${crypto.randomUUID().slice(0, 8)}`),
      ),
    ),
  );
  const events = await afterAbort(() =>
    waitTurnComplete(threadId, stringField(secondTurn, "turnId")),
  );
  expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
});

test("steer rides the active turn; mismatched expected turn is refused", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  registerMock(threadId, [{ hang: true }]);
  const adapter = adapterFor(managerFacadeByName(managerName));

  const started = expectOk(await handle(adapter, startCommand(threadId)));
  const providerThreadId = started.providerThreadId as string;
  const sent = expectOk(
    await handle(
      adapter,
      turnCommand(threadId, providerThreadId, `creq-${crypto.randomUUID().slice(0, 8)}`),
    ),
  );
  const turnId = stringField(sent, "turnId");

  assertFailure(
    await handle(adapter, {
      type: "turn/steer",
      threadId,
      providerThreadId,
      expectedTurnId: "turn_does_not_exist",
      input: [{ type: "text", text: "wrong", mentions: [] }],
      clientRequestId: `creq-${crypto.randomUUID().slice(0, 8)}`,
      options: executionContext(),
    }),
    "steer_no_active_turn",
  );

  const steerId = `creq-${crypto.randomUUID().slice(0, 8)}`;
  const steered = expectOk(
    await handle(adapter, {
      type: "turn/steer",
      threadId,
      providerThreadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: "focus on the tests", mentions: [] }],
      clientRequestId: steerId,
      options: executionContext(),
    }),
  );
  expect(steered).toMatchObject({ steered: true, turnId });

  const events = await eventsOf(threadId);
  const steerEvent = events.find((event) => event.type === "turn.steer");
  expect(steerEvent?.data).toMatchObject({ turnId, inputId: steerId });

  // Cleanup: the interrupted stop poisons and cancels the hung turn.
  expectOk(
    await handle(adapter, {
      type: "thread/stop",
      threadId,
      providerThreadId,
      activeTurnId: turnId,
    }),
  );
  const after = await waitTurnComplete(threadId, turnId);
  expect(after.some((event) => event.type === "turn.cancelled")).toBe(true);
});

test("second turn/start while a turn is active maps the agent conflict", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  registerMock(threadId, [{ hang: true }]);
  const adapter = adapterFor(managerFacadeByName(managerName));

  const started = expectOk(await handle(adapter, startCommand(threadId)));
  const providerThreadId = started.providerThreadId as string;
  expectOk(
    await handle(
      adapter,
      turnCommand(threadId, providerThreadId, `creq-${crypto.randomUUID().slice(0, 8)}`),
    ),
  );

  const outcome = await handle(
    adapter,
    turnCommand(threadId, providerThreadId, `creq-${crypto.randomUUID().slice(0, 8)}`),
  );
  assertFailure(outcome, "turn_already_active");

  await handle(adapter, {
    type: "thread/stop",
    threadId,
    providerThreadId,
    activeTurnId: null,
  });
});

test("handleCommand settles inside the budget with deadline_exceeded", async () => {
  // A manager facade that never settles — the adapter's own budget must fire.
  const hanging: ManagerFacade = {
    handleAdapterCommand: (): Promise<AdapterCommandOutcome> =>
      new Promise<AdapterCommandOutcome>(() => undefined),
  };
  const hungAdapter = new EdgeAgentProviderAdapter(hanging, resolveHarness({}));
  const outcome = await hungAdapter.handleCommand(
    { type: "thread/discard", threadId: "t", providerThreadId: "p" },
    { timeoutMs: 50 },
  );
  assertFailure(outcome, "deadline_exceeded");
  if (!outcome.ok) expect(outcome.retryable).toBe(true);
});

test("unsupported and registry-only commands answer deterministically", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  registerMock(threadId, [{ deltas: ["ok"] }]);
  const adapter = adapterFor(managerFacadeByName(managerName));

  const started = expectOk(await handle(adapter, startCommand(threadId)));
  const providerThreadId = started.providerThreadId as string;

  assertFailure(
    await handle(adapter, {
      type: "thread/fork",
      threadId: `thr-fork-${crypto.randomUUID().slice(0, 8)}`,
      cwd: "/workspace",
      sourceProviderThreadId: providerThreadId,
      options: executionContext(),
      instructionMode: "append",
    }),
    "unsupported",
  );

  const renamed = expectOk(
    await handle(adapter, {
      type: "thread/name/set",
      threadId,
      providerThreadId,
      title: "renamed",
    }),
  );
  expect(renamed).toEqual({ title: "renamed" });

  const archived = expectOk(
    await handle(adapter, { type: "thread/archive", threadId, providerThreadId }),
  );
  expect(archived).toEqual({ archived: true });

  const cleared = expectOk(
    await handle(adapter, { type: "thread/goal/clear", threadId, providerThreadId }),
  );
  expect(cleared).toEqual({ cleared: true });

  const configured = expectOk(await handle(adapter, { type: "skills/configure", skillRoots: [] }));
  expect(configured).toEqual({ configuredRoots: 0 });
});

test("turn/start on an unknown provider thread is thread_not_found", async () => {
  const managerName = freshManagerName();
  const threadId = `thr-${crypto.randomUUID()}`;
  registerMock(threadId, [{ deltas: ["ok"] }]);
  const adapter = adapterFor(managerFacadeByName(managerName));

  assertFailure(
    await handle(
      adapter,
      turnCommand(threadId, `pthr_${threadId}`, `creq-${crypto.randomUUID().slice(0, 8)}`),
    ),
    "thread_not_found",
  );
});
