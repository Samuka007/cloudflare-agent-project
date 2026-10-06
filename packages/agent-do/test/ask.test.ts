import { afterEach, describe, expect, test } from "vitest";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import {
  userQuestionPendingInteractionPayloadSchema,
  userQuestionPendingInteractionResolutionSchema,
  realtimeThreadChangedSchema,
  type RealtimeThreadChanged,
} from "@cap/protocol";
import { createRig, resetRuntime, type Rig } from "./helpers.js";
import { executionIdFor } from "../src/ids.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { activeTurnIdFromEvents } from "../src/turn-state.js";
import {
  askOptionValue,
  buildAskPayload,
  formatQuestionResult,
  formatSingleQuestionResponse,
  interactionForExecution,
  renderAskOutput,
  runAskTool,
  timeoutAutoSelect,
  validateAskResolution,
  type AskQuestion,
  type AskToolContext,
} from "../src/tools/ask.js";

afterEach(() => {
  resetRuntime();
});

// ---------------------------------------------------------------------------
// Pure layer: omp verbatim semantics over hand-built projections — reserved
// labels, uniqueness guards, value scheme, resolution validation, rendering.
// ---------------------------------------------------------------------------

const SINGLE: AskQuestion[] = [
  {
    id: "storage",
    question: "Database?",
    options: [{ label: "SQLite" }, { label: "Postgres" }],
    recommended: 0,
  },
];
const SINGLE_PAYLOAD = buildAskPayload("exec-1", SINGLE);

function event<TType extends AnyAgentEvent["type"]>(
  type: TType,
  data: Extract<AnyAgentEvent, { type: TType }>["data"],
  seq: number,
): AnyAgentEvent {
  return {
    id: `e${seq}`,
    threadId: "thr_pure",
    seq,
    type,
    data,
    createdAt: seq * 10,
  } as AnyAgentEvent;
}

describe("M1.5 T4 — ask pure semantics (omp ask.ts port)", () => {
  test("omp→bb payload mapping: value scheme, shortLabel, multiSelect, free text", () => {
    const payload = buildAskPayload("exec-9", [
      {
        id: "deploy",
        question: "Deploy mode?",
        header: " Deploy ",
        options: [{ label: "Canary", description: " 5% traffic " }, { label: "Big bang" }],
        multi: true,
        recommended: 1,
      },
    ]);
    const parsed = userQuestionPendingInteractionPayloadSchema.parse(payload);
    expect(parsed).toEqual({
      kind: "user_question",
      questions: [
        {
          id: "deploy",
          prompt: "Deploy mode?",
          shortLabel: "Deploy",
          multiSelect: true,
          options: [
            { value: askOptionValue("exec-9", 0), label: "Canary", description: "5% traffic" },
            { value: askOptionValue("exec-9", 1), label: "Big bang" },
          ],
          allowFreeText: true,
          recommended: 1,
        },
      ],
    });
  });

  test("resolution validation: unknown value, missing answer, single-select exclusivity, unknown id", () => {
    const value0 = askOptionValue("exec-1", 0);
    const value1 = askOptionValue("exec-1", 1);
    expect(
      validateAskResolution(SINGLE_PAYLOAD, {
        kind: "user_answer",
        answers: { storage: { selected: [value0] } },
      }),
    ).toEqual({
      ok: true,
      answers: { storage: { selected: [value0] } },
    });
    expect(
      validateAskResolution(SINGLE_PAYLOAD, {
        kind: "user_answer",
        answers: { storage: { selected: ["nope"] } },
      }).ok,
    ).toBe(false);
    expect(validateAskResolution(SINGLE_PAYLOAD, { kind: "user_answer", answers: {} }).ok).toBe(
      false,
    );
    expect(
      validateAskResolution(SINGLE_PAYLOAD, {
        kind: "user_answer",
        answers: { storage: { selected: [value0, value1] } },
      }).ok,
    ).toBe(false);
    expect(
      validateAskResolution(SINGLE_PAYLOAD, {
        kind: "user_answer",
        answers: { storage: { selected: [value0] }, ghost: { selected: [] } },
      }).ok,
    ).toBe(false);
    // Free text alone is a valid single-select answer (the "Other" affordance).
    expect(
      validateAskResolution(SINGLE_PAYLOAD, {
        kind: "user_answer",
        answers: { storage: { selected: [], freeText: "DuckDB" } },
      }).ok,
    ).toBe(true);
  });

  test("omp-verbatim rendering: single select, free text, multi-question batch, timeout suffix", () => {
    const value1 = askOptionValue("exec-1", 1);
    expect(renderAskOutput(SINGLE_PAYLOAD, { storage: { selected: [value1] } })).toBe(
      "User selected: Postgres",
    );
    expect(
      formatSingleQuestionResponse({ selectedOptions: [], customInput: "DuckDB", multi: false }),
    ).toBe("User provided custom input: DuckDB");
    const batch = buildAskPayload("exec-1", [
      ...SINGLE,
      {
        id: "scope",
        question: "Scope?",
        options: [{ label: "Module A" }, { label: "Module B" }],
        multi: true,
      },
    ]);
    expect(
      renderAskOutput(batch, {
        storage: { selected: [value1] },
        scope: { selected: [askOptionValue("exec-1", 0), askOptionValue("exec-1", 1)] },
      }),
    ).toBe("User answers:\nstorage: Postgres\nscope: [Module A, Module B]");
    expect(
      formatSingleQuestionResponse({ selectedOptions: ["SQLite"], multi: false, timedOut: true }),
    ).toBe("User selected: SQLite (auto-selected after timeout)");
    const firstQuestion = SINGLE_PAYLOAD.questions[0];
    if (firstQuestion === undefined) throw new Error("payload lost its question");
    expect(
      formatQuestionResult(firstQuestion, {
        selectedOptions: ["SQLite"],
        multi: false,
        timedOut: true,
      }),
    ).toBe("storage: SQLite (auto-selected after timeout)");
  });

  test("timeout auto-select: recommended wins, invalid recommended falls to first, free-text-only stays empty", () => {
    const firstQuestion = SINGLE_PAYLOAD.questions[0];
    if (firstQuestion === undefined) throw new Error("payload lost its question");
    expect(timeoutAutoSelect(firstQuestion)).toEqual({ selected: [askOptionValue("exec-1", 0)] });
    expect(timeoutAutoSelect({ ...firstQuestion, recommended: 99 })).toEqual({
      selected: [askOptionValue("exec-1", 0)],
    });
    expect(
      timeoutAutoSelect({ id: "q", prompt: "p", multiSelect: false, allowFreeText: true }),
    ).toEqual({
      selected: [],
    });
  });

  test("journal projection: registered → resolved/interrupted folds, replay-derivable", () => {
    const registered = event(
      "interaction.registered",
      {
        interactionId: "pi_1",
        turnId: "turn_1",
        executionId: "exec-1",
        providerId: "omp",
        providerThreadId: "thr_pure",
        providerRequestId: "exec-1",
        expiresAt: null,
        payload: SINGLE_PAYLOAD,
      },
      7,
    );
    expect(interactionForExecution([registered], "exec-1")?.status).toBe("pending");
    const resolved = event(
      "interaction.resolved",
      {
        interactionId: "pi_1",
        resolution: {
          kind: "user_answer",
          answers: { storage: { selected: [askOptionValue("exec-1", 0)] } },
        },
      },
      9,
    );
    expect(interactionForExecution([registered, resolved], "exec-1")).toMatchObject({
      status: "resolved",
      interactionId: "pi_1",
    });
    const interrupted = event(
      "interaction.interrupted",
      { interactionId: "pi_1", statusReason: "turn cancelled" },
      8,
    );
    expect(interactionForExecution([registered, interrupted], "exec-1")?.status).toBe(
      "interrupted",
    );
    expect(interactionForExecution([registered], "exec-other")).toBeUndefined();
  });

  test("executor answers a resolved row from the journal alone (crash-window recovery)", async () => {
    const events = [
      event(
        "interaction.registered",
        {
          interactionId: "pi_1",
          turnId: "turn_1",
          executionId: "exec-1",
          providerId: "omp",
          providerThreadId: "thr_pure",
          providerRequestId: "exec-1",
          expiresAt: null,
          payload: SINGLE_PAYLOAD,
        },
        7,
      ),
      event(
        "interaction.resolved",
        {
          interactionId: "pi_1",
          resolution: {
            kind: "user_answer",
            answers: { storage: { selected: [askOptionValue("exec-1", 1)] } },
          },
        },
        8,
      ),
    ];
    const ctx: AskToolContext = {
      executionId: "exec-1",
      threadId: "thr_pure",
      turnId: "turn_1",
      owningTurnStatus: () => "tools_running",
      interactionForExecution: () => Promise.resolve(interactionForExecution(events, "exec-1")),
      registerInteraction: () => {
        throw new Error("a resolved row must never re-register");
      },
      interruptInteraction: () => {
        throw new Error("a resolved row must never interrupt");
      },
      wake: () => {
        throw new Error("a resolved row must never block");
      },
      askTimeoutMs: 0,
      now: () => 0,
    };
    const result = await runAskTool({ questions: SINGLE }, ctx);
    expect(result.status).toBe("ok");
    expect(result.output).toBe("User selected: Postgres");
  });

  test("executor rejects duplicate question ids and duplicate option labels omp-verbatim", async () => {
    const seen: string[] = [];
    const ctx: AskToolContext = {
      executionId: "exec-1",
      threadId: "thr_pure",
      turnId: "turn_1",
      owningTurnStatus: () => "tools_running",
      interactionForExecution: () => Promise.resolve(undefined),
      registerInteraction: (input) => {
        seen.push(input.interactionId);
        return Promise.resolve();
      },
      interruptInteraction: () => Promise.resolve(),
      wake: () => Promise.resolve({ kind: "cancelled" }),
      askTimeoutMs: 0,
      now: () => 0,
    };
    const duplicateIds = await runAskTool(
      { questions: [SINGLE[0], { id: "storage", question: "Again?", options: [{ label: "A" }] }] },
      ctx,
    );
    expect(duplicateIds.status).toBe("error");
    expect(duplicateIds.output).toBe("Error: question ids must be unique: storage");
    const duplicateLabels = await runAskTool(
      { questions: [{ id: "q", question: "Q?", options: [{ label: "A" }, { label: "A" }] }] },
      ctx,
    );
    expect(duplicateLabels.status).toBe("error");
    expect(duplicateLabels.output).toBe("Error: option labels must be unique within a question: A");
    expect(seen).toEqual([]);
  });

  test("stop-route fold: input/steer assert the active turn, only a terminal clears it", () => {
    expect(activeTurnIdFromEvents([])).toBeNull();
    const input = event(
      "turn.input",
      { turnId: "turn_a", inputId: "in-1", content: [{ type: "text", text: "go" }] },
      1,
    );
    expect(activeTurnIdFromEvents([input])).toBe("turn_a");
    const steer = event(
      "turn.steer",
      { turnId: "turn_a", inputId: "st-1", content: [{ type: "text", text: "left" }] },
      2,
    );
    expect(activeTurnIdFromEvents([input, steer])).toBe("turn_a");
    // cancel_requested is a non-terminal row: a second Stop must still find
    // the cancelling turn (cancelTurn is at-least-once by design).
    const requested = event("turn.cancel_requested", { turnId: "turn_a" }, 3);
    expect(activeTurnIdFromEvents([input, steer, requested])).toBe("turn_a");
    const cancelled = event("turn.cancelled", { turnId: "turn_a" }, 4);
    expect(activeTurnIdFromEvents([input, steer, requested, cancelled])).toBeNull();
    // A foreign terminal never clears the pointer; the next input wins.
    expect(activeTurnIdFromEvents([input, event("turn.completed", { turnId: "turn_z" }, 5)])).toBe(
      "turn_a",
    );
    const next = event(
      "turn.input",
      { turnId: "turn_b", inputId: "in-2", content: [{ type: "text", text: "again" }] },
      6,
    );
    expect(activeTurnIdFromEvents([input, cancelled, next])).toBe("turn_b");
  });
});

// ---------------------------------------------------------------------------
// DO integration: register → SPA-visible (WS push + journal) → ruling backflow
// → journal replay consistency (proposal §3 T4 acceptance + §1 replay rule).
// ---------------------------------------------------------------------------

const ASK_QUESTION: AskQuestion = {
  id: "storage",
  question: "Database?",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
  recommended: 0,
};

async function startAskTurn(rig: Rig, clientRequestId: string): Promise<string> {
  const sent = await rig.stub.sendMessage({
    clientRequestId,
    content: [{ type: "text", text: "ask the user" }],
    mode: "start",
  });
  // Sync on the registered row: RPCs fired after this land against a blocked
  // ask executor (the registered row IS the blocking marker — the DO never
  // journalled tool.exec_started for ask; the interaction row is the state).
  await rig.waitFor((events) => events.some((event) => event.type === "interaction.registered"));
  return sent.turnId;
}

function askInteraction(events: readonly AnyAgentEvent[]) {
  return events.find((event) => event.type === "interaction.registered");
}

describe("M1.5 T4 — ask DO integration (DO↔SPA pending-interaction channel)", () => {
  test("register → SPA-visible → ruling backflow unlocks the turn with a verbatim answer", async () => {
    const rig = await createRig({
      // A journaled execution: the interaction row names the owning provider
      // derived from it (#434), never a constant.
      execution: { providerId: "rig-provider", model: "rig-model", reasoningLevel: "none" },
      turns: [
        { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
        { deltas: ["done"] },
      ],
    });
    const turnId = await startAskTurn(rig, "in-ask-1");

    // SPA-visible, contract form: the journal row validates against the bb
    // user_question payload schema (the SPA-side contract, verifiable
    // server-side; the L2 staging click rides this exact shape).
    const registered = askInteraction(await rig.events());
    if (registered?.type !== "interaction.registered") throw new Error("no registered row");
    expect(() =>
      userQuestionPendingInteractionPayloadSchema.parse(registered.data.payload),
    ).not.toThrow();
    expect(registered.data.providerId).toBe("rig-provider");
    expect(registered.data.providerRequestId).toBe(registered.data.executionId);
    expect(registered.data.expiresAt).toBeNull();

    // Ruling backflow (bb interactive.resolve shape) unlocks the turn.
    const backflow = {
      kind: "user_answer" as const,
      answers: { storage: { selected: [askOptionValue(registered.data.executionId, 1)] } },
    };
    expect(() => userQuestionPendingInteractionResolutionSchema.parse(backflow)).not.toThrow();
    await expect(
      rig.stub.resolveInteraction({
        interactionId: registered.data.interactionId,
        resolution: backflow,
      }),
    ).resolves.toEqual({
      accepted: true,
      duplicated: false,
    });
    await rig.waitTurnComplete(turnId);
    const events = await rig.events();

    const result = events.find((event) => event.type === "tool.result");
    if (result?.type !== "tool.result") throw new Error("no ask result");
    expect(result.data.status).toBe("ok");
    expect(result.data.output).toBe("User selected: Postgres");

    // Journal order: registered → resolved → result (persist, then wake).
    const kinds = events
      .filter((event) => event.type.startsWith("interaction.") || event.type === "tool.result")
      .map((event) => event.type);
    expect(kinds).toEqual(["interaction.registered", "interaction.resolved", "tool.result"]);

    // DO budget (proposal §1 edge row): the whole ask lifecycle consumed this
    // DO only — zero daemon dispatches, zero service journal rows.
    await expect(rig.service.journal()).resolves.toEqual([]);
    expect(events.some((event) => event.type === "tool.dispatch")).toBe(false);
  });

  test("the pending interaction is pushed over /ws as a pending-interaction change", async () => {
    const rig = await createRig({
      // No journaled execution (the pre-#351 journal shape): the interaction
      // row carries the honest "unknown" — never the retired "omp" sentinel.
      turns: [
        { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
        { deltas: ["ok"] },
      ],
    });
    const upgrade = await rig.stub.fetch(
      new Request("https://agent-do.test/ws", { headers: { Upgrade: "websocket" } }),
    );
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    if (socket === null) throw new Error("no client socket returned");
    socket.accept();
    // Socket frames are outside-controlled JSON: schema-parse each frame and
    // keep only valid `changed` broadcasts (subscribe acks drop out here).
    const frames: RealtimeThreadChanged[] = [];
    socket.addEventListener("message", (event) => {
      if (!("data" in event)) return;
      const parsed = realtimeThreadChangedSchema.safeParse(JSON.parse(String(event.data)));
      if (parsed.success) frames.push(parsed.data);
    });
    socket.send(
      JSON.stringify({
        type: "subscribe",
        target: { kind: "thread-detail", threadId: rig.threadId },
      }),
    );

    const turnId = await startAskTurn(rig, "in-ask-ws");
    const registered = askInteraction(await rig.events());
    if (registered?.type !== "interaction.registered") throw new Error("no registered row");
    const interactionId = registered.data.interactionId;
    await rig.waitFor(() =>
      frames.some((frame) => frame.metadata?.pendingInteraction?.interactionId === interactionId),
    );
    const pushed = frames.find((frame) => frame.changes.includes("pending-interaction"));
    // The pushed frame IS the SPA contract: schema-valid, patch-carried, no
    // question payload riding the socket.
    expect(pushed?.metadata?.pendingInteraction).toEqual({ interactionId, status: "pending" });
    expect(JSON.stringify(pushed)).not.toContain("Database?");

    await rig.stub.resolveInteraction({
      interactionId,
      resolution: {
        kind: "user_answer",
        answers: { storage: { selected: [askOptionValue(registered.data.executionId, 0)] } },
      },
    });
    await rig.waitTurnComplete(turnId);
    socket.close();
  });

  test("duplicate rulings are absorbed; invalid backflow never disturbs the pending row", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
        { deltas: ["ok"] },
      ],
    });
    const turnId = await startAskTurn(rig, "in-ask-dup");
    const registered = askInteraction(await rig.events());
    if (registered?.type !== "interaction.registered") throw new Error("no registered row");
    const interactionId = registered.data.interactionId;

    // Explicit try/catch (not .rejects): the pool surfaces DO RPC rejections
    // through a remote channel, and an unconsumed frame reads as unhandled.
    let rejected: unknown;
    try {
      await rig.stub.resolveInteraction({
        interactionId,
        resolution: { kind: "user_answer", answers: { storage: { selected: ["not-an-option"] } } },
      });
      expect.unreachable("invalid backflow must reject");
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    // Still pending: exactly one registered row, no resolution row.
    expect(await rig.of("interaction.registered")).toHaveLength(1);
    expect(await rig.of("interaction.resolved")).toHaveLength(0);

    const first = await rig.stub.resolveInteraction({
      interactionId,
      resolution: {
        kind: "user_answer",
        answers: { storage: { selected: [askOptionValue(registered.data.executionId, 0)] } },
      },
    });
    expect(first).toEqual({ accepted: true, duplicated: false });
    const second = await rig.stub.resolveInteraction({
      interactionId,
      resolution: {
        kind: "user_answer",
        answers: { storage: { selected: [askOptionValue(registered.data.executionId, 0)] } },
      },
    });
    expect(second).toEqual({ accepted: false, duplicated: true });
    await rig.waitTurnComplete(turnId);
    expect(await rig.of("interaction.resolved")).toHaveLength(1);
  });

  test("cancelling the turn interrupts the pending interaction before the cancelled result (abort state)", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
        { deltas: ["ok"] },
      ],
    });
    const turnId = await startAskTurn(rig, "in-ask-cancel");
    await rig.stub.cancelTurn({ turnId });
    const events = await rig.waitTurnComplete(turnId);
    const registered = askInteraction(events);
    if (registered?.type !== "interaction.registered") throw new Error("no registered row");
    const interruptedIdx = events.findIndex(
      (event) =>
        event.type === "interaction.interrupted" &&
        event.data.interactionId === registered.data.interactionId,
    );
    const resultIdx = events.findIndex(
      (event) =>
        event.type === "tool.result" &&
        event.data.executionId === registered.data.executionId &&
        event.data.status === "cancelled",
    );
    expect(interruptedIdx).toBeGreaterThan(registered.seq);
    expect(resultIdx).toBeGreaterThan(interruptedIdx);
    const interrupted = events[interruptedIdx];
    if (interrupted?.type !== "interaction.interrupted") throw new Error("no interrupted row");
    expect(interrupted.data.statusReason).toContain("cancel");
    const result = events[resultIdx];
    if (result?.type !== "tool.result") throw new Error("no cancelled result");
    expect(result.data.output).toBe("Ask tool was cancelled by the user");
    expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
  });

  test("ask pending is the cancellable active turn in the stop-route fold; the cancel clears it", async () => {
    // #226: the SPA Stop route derives its target from this fold — a turn
    // parked on an unbounded ask suspends the turn watchdog (the user IS the
    // deadline), so the fold must still report it active until the cancel
    // lands turn.cancelled.
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
        { deltas: ["ok"] },
      ],
    });
    const turnId = await startAskTurn(rig, "stop-fold-cancel");
    expect(activeTurnIdFromEvents(await rig.events())).toBe(turnId);
    expect(await rig.stub.cancelTurn({ turnId })).toEqual({ accepted: true });
    await rig.waitTurnComplete(turnId);
    expect(activeTurnIdFromEvents(await rig.events())).toBeNull();
  });

  test("replay consistency: ruling landing while evicted is the re-asked executor's journal answer", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
        { deltas: ["ok"] },
      ],
    });
    const turnId = await startAskTurn(rig, "in-ask-evict");
    const before = await rig.events();
    const registered = askInteraction(before);
    if (registered?.type !== "interaction.registered") throw new Error("no registered row");
    const callSeq = before.find(
      (event) => event.type === "tool.call" && event.data.tool === "ask",
    )?.seq;
    if (callSeq === undefined) throw new Error("no ask call");
    const executionId = executionIdFor(rig.threadId, callSeq);

    // Hard kill while the ask is blocked, then rule through the fresh
    // incarnation: no waiter exists, the resolution still journals.
    await abortAllDurableObjects();
    await rig.afterAbort(async () => {
      await rig.stub.resolveInteraction({
        interactionId: registered.data.interactionId,
        resolution: {
          kind: "user_answer",
          answers: { storage: { selected: [askOptionValue(executionId, 1)] } },
        },
      });
    });
    await rig.afterAbort(async () => {
      await runInDurableObject(rig.stub, async (instance) => {
        const seam = instance as unknown as {
          dispatchExecution: (turnId: string, executionId: string) => Promise<void>;
        };
        await seam.dispatchExecution(turnId, executionId);
      });
    });
    await rig.waitTurnComplete(turnId);
    const after = await rig.events();

    // Zero second registration, zero second execution: the re-asked
    // executionId answered from the journal (bb created|existing dedup).
    expect(after.filter((event) => event.type === "interaction.registered")).toHaveLength(1);
    expect(after.filter((event) => event.type === "tool.result")).toHaveLength(
      before.filter((event) => event.type === "tool.result").length + 1,
    );
    const result = after.find(
      (event) => event.type === "tool.result" && event.data.executionId === executionId,
    );
    if (result?.type !== "tool.result") throw new Error("no journal answer");
    expect(result.data.status).toBe("ok");
    expect(result.data.output).toBe("User selected: Postgres");
  });

  test("a pending unbounded ask suspends the turn watchdog until the ruling arrives", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
        { deltas: ["ok"] },
      ],
      watchdog: { turnWatchdogMs: 200 },
    });
    const turnId = await startAskTurn(rig, "in-ask-watchdog");
    // Far past the 200ms backstop the turn must still be blocked on the user.
    // A real delay is the point of this test: the DO alarm lives in the
    // workerd runtime, which fake timers cannot drive, and the assertion is
    // the ABSENCE of expiry — only genuinely elapsed wall time can show it.
    const { promise: elapsed, resolve: done } = Promise.withResolvers<undefined>();
    setTimeout(done, 600);
    await elapsed;
    const mid = await rig.events();
    expect(mid.some((event) => event.type === "turn.failed")).toBe(false);
    expect(mid.some((event) => event.type === "tool.result")).toBe(false);
    const registered = askInteraction(mid);
    if (registered?.type !== "interaction.registered") throw new Error("no registered row");
    await rig.stub.resolveInteraction({
      interactionId: registered.data.interactionId,
      resolution: {
        kind: "user_answer",
        answers: { storage: { selected: [askOptionValue(registered.data.executionId, 0)] } },
      },
    });
    const events = await rig.waitTurnComplete(turnId);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
  });

  test("the ask-timeout arm auto-selects the recommended option and lands ok with the timeout suffix", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
        { deltas: ["ok"] },
      ],
      watchdog: { askTimeoutMs: 300 },
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-ask-timeout",
      content: [{ type: "text", text: "ask with a cap" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    const registered = askInteraction(events);
    if (registered?.type !== "interaction.registered") throw new Error("no registered row");
    expect(registered.data.expiresAt).toBeGreaterThan(0);
    const result = events.find(
      (event) =>
        event.type === "tool.result" && event.data.executionId === registered.data.executionId,
    );
    if (result?.type !== "tool.result") throw new Error("no timeout answer");
    expect(result.data.status).toBe("ok");
    expect(result.data.output).toBe("User selected: SQLite (auto-selected after timeout)");
    // The ruling never arrived: no resolution row, the expiry alone terminalized.
    expect(events.some((event) => event.type === "interaction.resolved")).toBe(false);
    expect(events.some((event) => event.type === "interaction.interrupted")).toBe(false);
  });

  test("an interrupted row answers the recovery re-dispatch as cancelled without new rows", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
        { deltas: ["ok"] },
      ],
    });
    const turnId = await startAskTurn(rig, "in-ask-evict-cancel");
    const registered = askInteraction(await rig.events());
    if (registered?.type !== "interaction.registered") throw new Error("no registered row");
    const callSeq = (await rig.events()).find(
      (event) => event.type === "tool.call" && event.data.tool === "ask",
    )?.seq;
    if (callSeq === undefined) throw new Error("no ask call");
    const executionId = executionIdFor(rig.threadId, callSeq);
    await rig.stub.cancelTurn({ turnId });
    await rig.waitTurnComplete(turnId);
    const cancelled = await rig.events();
    expect(cancelled.filter((event) => event.type === "interaction.interrupted")).toHaveLength(1);

    // Re-asking the cancelled execution answers from the journal — zero rows.
    await abortAllDurableObjects();
    await rig.afterAbort(async () => {
      await runInDurableObject(rig.stub, async (instance) => {
        const seam = instance as unknown as {
          dispatchExecution: (turnId: string, executionId: string) => Promise<void>;
        };
        await seam.dispatchExecution(turnId, executionId);
      });
    });
    const after = await rig.events();
    expect(after.filter((event) => event.type === "interaction.registered")).toHaveLength(1);
    expect(after.filter((event) => event.type === "interaction.interrupted")).toHaveLength(1);
    expect(after.filter((event) => event.type === "tool.result")).toHaveLength(
      cancelled.filter((event) => event.type === "tool.result").length,
    );
  });
});
