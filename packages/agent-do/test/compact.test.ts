import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { threadEventDataSchemas } from "@cap/protocol";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { parseAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  estimateTurnTokens,
  lastUsageTotal,
  planCompactCut,
  turnSlices,
} from "../src/compaction.js";
import { replayEvents } from "../src/turn-state.js";
import type { MockTurn } from "../src/testing/mock-provider.js";
import { projectToUxEvents } from "../src/ux-projection.js";
import type { ModelRequest } from "../src/provider.js";
import { modelRequestFromEvents } from "../src/translate.js";
import { createRig, resetRuntime, type Rig } from "./helpers.js";

/**
 * #309 — manual compact: journal checkpoint-style compaction. Campaign face:
 * one sustained thread (8 KB-scale turns → compact → post-cut turn → a second
 * growth phase → a superseding compact) asserting the checkpoint row, the
 * post-cut projection, #116 replay determinism, previousSummary chaining, and
 * supersedence. Unit faces: the cut planner (keepRecent crossing, fits-budget
 * → undefined, tool-pair preservation — the pi #9740 regression shape), the
 * RPC gates (idle-only, nothing-to-compact), and the empty-summary seal path.
 */

// ---------------------------------------------------------------------------
// Scripted campaign
// ---------------------------------------------------------------------------

function payload(tag: string, kb: number): string {
  const line = `${tag}:${"x".repeat(96)}`;
  const lines = Math.ceil((kb * 1024) / (line.length + 1));
  return Array.from({ length: lines }, () => line).join("\n");
}

const GROWTH_TURNS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"] as const;
const SUMMARY_1 = "SUMMARY-1: the user hunted a leak; the drain path is fixed.";
const SUMMARY_2 = "SUMMARY-2: the second phase converged on the injector.";
const TAIL_TURNS = ["p1", "p2", "p3", "p4"] as const;
/** ~6K tokens per turn: crossing lands inside the growth phase, not at t1. */
const GROWTH_KB = 24;

const USAGE_6 = {
  inputTokens: 90_000,
  outputTokens: 100,
  cacheReadInputTokens: 1_000,
  cacheCreationInputTokens: 500,
  contextWindow: 200_000,
  estimated: false,
} as const;

function campaignScript(): MockTurn[] {
  const growth = GROWTH_TURNS.map((label): MockTurn => ({
    deltas: [payload(`delta-${label}`, GROWTH_KB)],
    ...(label === "t6" ? { usage: USAGE_6 } : {}),
  }));
  return [
    ...growth,
    // compact-1: the summarization call (tool-free surface; text-only answer).
    { deltas: [SUMMARY_1], usage: { ...USAGE_6, inputTokens: 4_000 } },
    { deltas: ["post compact answer"] },
    // second growth phase, then compact-2 (supersedence + chaining).
    ...TAIL_TURNS.map((label): MockTurn => ({ deltas: [payload(`delta-${label}`, GROWTH_KB)] })),
    { deltas: [SUMMARY_2] },
  ];
}

const EXPECTED_CALLS = campaignScript().length;

// ---------------------------------------------------------------------------
// Campaign driver
// ---------------------------------------------------------------------------

interface Campaign {
  rig: Rig;
  turnIds: { compact1: string; compact2: string; post: string };
  events: AnyAgentEvent[];
  captured: ModelRequest[];
}

let campaign: Campaign;

beforeAll(async () => {
  const rig = await createRig({ turns: campaignScript() });
  // Journal polling with a real 100ms interval is the compaction-stress
  // harness shape (beforeAll has no expect.poll context; the completion
  // signal is only observable through journal reads).
  const awaitTurnTerminal = async (label: string, turnId: string): Promise<void> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const snapshot = await rig.events();
      const terminal = snapshot.find(
        (event) =>
          (event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.cancelled") &&
          event.data.turnId === turnId,
      );
      if (terminal !== undefined) {
        expect(terminal.type, `${label} must complete`).toBe("turn.completed");
        return;
      }
      if (Date.now() > deadline) throw new Error(`turn ${turnId} (${label}) never terminalized`);
      const { promise, resolve } = Promise.withResolvers<undefined>();
      setTimeout(resolve, 100);
      await promise;
    }
  };
  const send = async (label: string, input: string): Promise<string> => {
    const sent = await rig.stub.sendMessage({
      clientRequestId: `compact-spec-${label}`,
      content: [{ type: "text", text: input }],
      mode: "start",
    });
    expect(sent.steer, label).toBe(false);
    expect(sent.duplicated, label).toBe(false);
    await awaitTurnTerminal(label, sent.turnId);
    return sent.turnId;
  };

  for (const label of GROWTH_TURNS) {
    await send(label, `growth ${label}\n${payload(`input-${label}`, 1)}`);
  }
  const compact1 = await rig.stub.compactThread({ clientRequestId: "compact-spec-compact-1" });
  expect(compact1.duplicated).toBe(false);
  await awaitTurnTerminal("compact-1", compact1.turnId);
  const post = await send("post", "post-compact follow-up");
  for (const label of TAIL_TURNS) {
    await send(label, `tail ${label}\n${payload(`input-${label}`, 1)}`);
  }
  const compact2 = await rig.stub.compactThread({ clientRequestId: "compact-spec-compact-2" });
  await awaitTurnTerminal("compact-2", compact2.turnId);

  const events = await rig.events();
  const captured = rig.mock().calls;
  expect(captured, "mock script drift — every entry consumed exactly once").toHaveLength(
    EXPECTED_CALLS,
  );
  campaign = {
    rig,
    turnIds: { compact1: compact1.turnId, compact2: compact2.turnId, post },
    events,
    captured,
  };
}, 180_000);

afterEach(() => {
  resetRuntime();
});

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

const callSeqOf = (turnId: string, events: readonly AnyAgentEvent[]): number =>
  events.find((event) => event.type === "model.call_started" && event.data.turnId === turnId)
    ?.seq ?? -1;

const compactedRows = (events: readonly AnyAgentEvent[]) =>
  events.filter(
    (event): event is Extract<AnyAgentEvent, { type: "thread/compacted" }> =>
      event.type === "thread/compacted",
  );

const inputSeqOf = (events: readonly AnyAgentEvent[], turnId: string): number => {
  const input = events.find((event) => event.type === "turn.input" && event.data.turnId === turnId);
  if (input === undefined) throw new Error(`no turn.input for ${turnId}`);
  return input.seq;
};

const textBodyOf = (request: ModelRequest): string => {
  const priorText = (request.priorTurns ?? [])
    .map((turn) => [turn.input, ...turn.calls.map((call) => call.text)].join("\n"))
    .join("\n");
  return `${priorText}\n${request.input}`;
};

// ---------------------------------------------------------------------------
// Campaign faces
// ---------------------------------------------------------------------------

describe("#309 manual compact (sustained campaign)", () => {
  test("the checkpoint row is the content-bearing seq boundary", () => {
    const [marker1, marker2] = compactedRows(campaign.events);
    expect(marker1).toBeDefined();
    expect(marker2).toBeDefined();
    if (marker1 === undefined || marker2 === undefined) throw new Error("missing markers");
    expect(marker1.data.method).toBe("manual");
    expect(marker1.data.turnId).toBe(campaign.turnIds.compact1);
    expect(marker1.data.tokensBefore).toBe(
      USAGE_6.inputTokens +
        USAGE_6.outputTokens +
        USAGE_6.cacheReadInputTokens +
        USAGE_6.cacheCreationInputTokens,
    );
    expect(marker1.data.contextWindow).toBe(200_000);
    expect(marker1.data.tokensAfter).toBeGreaterThan(0);
    // The boundary is a seq, not a deletion: the hidden rows are all still in
    // the journal (#116 — replay derives the cut, the log never truncates).
    const hidden = campaign.events.filter((event) => event.seq <= marker1.data.hideThroughSeq);
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.some((event) => event.type === "turn.input")).toBe(true);
    // First kept turn: the planner crossed inside the growth phase (t1 is
    // hidden; the newest growth turn is kept).
    const firstKeptSeq = marker1.data.hideThroughSeq + 1;
    expect(
      campaign.events.some((event) => event.type === "turn.input" && event.seq === firstKeptSeq),
    ).toBe(true);
  });

  test("the compact turn is a real journaled turn ending in the checkpoint", () => {
    const from = inputSeqOf(campaign.events, campaign.turnIds.compact1);
    const terminal = campaign.events.find(
      (event) => event.type === "turn.completed" && event.data.turnId === campaign.turnIds.compact1,
    );
    if (terminal === undefined) throw new Error("compact turn never completed");
    const slice = campaign.events.filter((event) => event.seq >= from && event.seq <= terminal.seq);
    expect(slice.map((event) => event.type)).toEqual([
      "turn.input",
      "model.call_started",
      "turn.phase",
      "turn.phase",
      "model.delta",
      "model.call_completed",
      "model.usage_receipt",
      "thread/compacted",
      "turn.completed",
    ]);
    const input = slice[0];
    if (input?.type !== "turn.input") throw new Error("unreachable");
    expect(input.data.content).toHaveLength(1);
    const part = input.data.content[0];
    if (part?.type !== "text") throw new Error("compact prompt part is not text");
    expect(part.text).toContain("context-compact");
    const completed = slice.find((event) => event.type === "model.call_completed");
    if (completed?.type !== "model.call_completed") throw new Error("unreachable");
    expect(completed.data.text).toBe(SUMMARY_1);
    expect(completed.data.toolCalls).toEqual([]);
  });

  test("the post-compact request projects the cut (hidden span gone, summary and tail kept)", () => {
    const postCallSeq = callSeqOf(campaign.turnIds.post, campaign.events);
    const postRequest = campaign.captured.find((request) => request.modelCallId === postCallSeq);
    if (postRequest === undefined) throw new Error("post-compact request not captured");
    const body = textBodyOf(postRequest);
    // Hidden growth turns never re-enter.
    for (const label of ["t1", "t2", "t3", "t4"]) {
      expect(body).not.toContain(`delta-${label}`);
      expect(body).not.toContain(`input-${label}`);
    }
    // Kept tail rides, the compact turn is the visible summary carrier.
    for (const label of ["t5", "t6", "t7", "t8"]) {
      expect(body).toContain(`delta-${label}`);
    }
    expect(body).toContain("context-compact");
    expect(body).toContain(SUMMARY_1);
    const compactPrior = (postRequest.priorTurns ?? []).find((turn) =>
      turn.input.startsWith("[context-compact]"),
    );
    expect(compactPrior).toBeDefined();
    expect(compactPrior?.calls.map((call) => call.text)).toEqual([SUMMARY_1]);
    // No branchCut overlay: the summary rides as the compact turn's own
    // history, not a synthetic prefix.
    expect(postRequest.branchCut).toBeUndefined();
  });

  test("replay determinism (#116): the final log re-projects every captured request", () => {
    for (const request of campaign.captured) {
      const { experimentalGates: _gates, ...projected } = request;
      const rebuilt = modelRequestFromEvents(campaign.events, request.turnId, request.modelCallId);
      const { experimentalGates: _rebuiltGates, ...rebuiltPlain } = rebuilt;
      expect(rebuiltPlain, `call ${request.modelCallId}`).toEqual(projected);
    }
  });

  test("the second compact supersedes and chains (previousSummary)", () => {
    const [marker1, marker2] = compactedRows(campaign.events);
    if (marker1 === undefined || marker2 === undefined) throw new Error("missing markers");
    expect(marker2.seq).toBeGreaterThan(marker1.seq);
    expect(marker2.data.hideThroughSeq).toBeGreaterThan(marker1.data.hideThroughSeq);
    // The second summarizer (uncut for its own turn) read the first summary —
    // the chain is the request rebuild itself.
    const compact2CallSeq = callSeqOf(campaign.turnIds.compact2, campaign.events);
    const compact2Request = campaign.captured.find(
      (request) => request.modelCallId === compact2CallSeq,
    );
    expect(compact2Request).toBeDefined();
    if (compact2Request === undefined) throw new Error("compact-2 request not captured");
    expect(textBodyOf(compact2Request)).toContain(SUMMARY_1);
    // The fold arms exactly the newest marker (a hypothetical post-compact-2
    // turn would hide marker 1's span, SUMMARY-1 included).
    const armed = compactedRows(campaign.events).at(-1);
    expect(armed?.data.hideThroughSeq).toBe(marker2.data.hideThroughSeq);
  });

  test("ux projection: compaction row + estimated usage row drop the indicator", () => {
    const ux = projectToUxEvents(campaign.events);
    const compactedUx = ux.filter((event) => event.type === "thread/compacted");
    expect(compactedUx).toHaveLength(2);
    const estimated = ux.filter(
      (event) =>
        event.type === "thread/contextWindowUsage/updated" &&
        threadEventDataSchemas["thread/contextWindowUsage/updated"].safeParse(event.data).success,
    );
    expect(estimated.length).toBeGreaterThanOrEqual(2);
    // Replay stays deterministic on the ux face too.
    expect(() => replayEvents(campaign.events)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unit faces — the cut planner (pi kernel semantics, seq-keyed)
// ---------------------------------------------------------------------------

const THREAD = "thr_compact_unit";
let unitSeq = 0;

function rawEvent(type: string, data: unknown): AnyAgentEvent {
  unitSeq += 1;
  return parseAgentEvent({
    id: `evt_unit_${unitSeq}`,
    threadId: THREAD,
    seq: unitSeq,
    type,
    data,
    createdAt: 1_700_000_000_000 + unitSeq,
  });
}

function syntheticTurn(options: {
  turnId: string;
  inputKb: number;
  toolPair?: boolean;
}): AnyAgentEvent[] {
  const rows: AnyAgentEvent[] = [];
  rows.push(
    rawEvent("turn.input", {
      turnId: options.turnId,
      inputId: `in_${options.turnId}`,
      content: [{ type: "text", text: payload(`input-${options.turnId}`, options.inputKb) }],
    }),
  );
  if (options.toolPair) {
    const started = rawEvent("model.call_started", {
      turnId: options.turnId,
      consumedSteerSeqs: [],
    });
    rows.push(started);
    rows.push(
      rawEvent("model.call_completed", {
        turnId: options.turnId,
        modelCallId: started.seq,
        text: "",
        toolCalls: [{ name: "bash", arguments: { command: "ls" } }],
      }),
    );
    const toolCall = rawEvent("tool.call", {
      turnId: options.turnId,
      modelCallId: started.seq,
      tool: "bash",
      arguments: { command: "ls" },
      timeoutMs: 30_000,
    });
    rows.push(toolCall);
    rows.push(
      rawEvent("tool.result", {
        turnId: options.turnId,
        executionId: executionIdFor(THREAD, toolCall.seq),
        status: "ok",
        exitCode: 0,
        output: payload(`result-${options.turnId}`, 8),
      }),
    );
  } else {
    const started = rawEvent("model.call_started", {
      turnId: options.turnId,
      consumedSteerSeqs: [],
    });
    rows.push(started);
    rows.push(
      rawEvent("model.call_completed", {
        turnId: options.turnId,
        modelCallId: started.seq,
        text: payload(`delta-${options.turnId}`, options.inputKb),
        toolCalls: [],
      }),
    );
  }
  rows.push(rawEvent("turn.completed", { turnId: options.turnId }));
  return rows;
}

describe("#309 compact cut planner (pi kernel, seq-keyed)", () => {
  afterEach(() => {
    unitSeq = 0;
  });

  test("keepRecent crossing keeps the newest tail and hides the older span", () => {
    const events = [
      rawEvent("thread.created", { title: "unit", machineId: THREAD }),
      ...syntheticTurn({ turnId: "a", inputKb: 8 }),
      ...syntheticTurn({ turnId: "b", inputKb: 8 }),
      ...syntheticTurn({ turnId: "c", inputKb: 8 }),
      ...syntheticTurn({ turnId: "d", inputKb: 8 }),
    ];
    // Walk: d ≈4K, c ≈8K, b ≈12K (crossing), a ≈16K tokens.
    const plan = planCompactCut(events, 12_000);
    expect(plan).toBeDefined();
    const slices = turnSlices(events);
    const firstKept = slices.find((slice) => slice.inputSeq === plan?.firstKeptTurnInputSeq);
    expect(
      firstKept?.events.some((event) => event.type === "turn.input" && event.data.turnId === "b"),
    ).toBe(true);
    expect(plan?.hideThroughSeq).toBe((firstKept?.inputSeq ?? 0) - 1);
  });

  test("a journal that fits the retention budget has nothing to compact", () => {
    const events = [
      ...syntheticTurn({ turnId: "a", inputKb: 2 }),
      ...syntheticTurn({ turnId: "b", inputKb: 2 }),
    ];
    expect(planCompactCut(events, DEFAULT_KEEP_RECENT_TOKENS)).toBeUndefined();
    // Crossing AT the oldest turn is the same verdict: the kept tail would be
    // the whole journal (pi prepareCompaction kept-still-fits → undefined).
    const big = [
      ...syntheticTurn({ turnId: "a", inputKb: 12 }),
      ...syntheticTurn({ turnId: "b", inputKb: 8 }),
    ];
    expect(planCompactCut(big, 20_000)).toBeUndefined();
  });

  test("the cut never splits a tool pair — the boundary is a turn start (#9740)", () => {
    // The tool turn is the crossing turn: a naive intra-turn cut would land
    // between the tool.call and its result; the turn-granular planner keeps
    // the whole turn (pi findCutPoint never separates call from result).
    const events = [
      ...syntheticTurn({ turnId: "a", inputKb: 16 }),
      ...syntheticTurn({ turnId: "b", inputKb: 2, toolPair: true }),
      ...syntheticTurn({ turnId: "c", inputKb: 2 }),
    ];
    // Walk: c ≈1K, b ≈3.6K (crossing — the tool turn is the first KEPT turn),
    // a ≈12K. The naive entry-level cut would land inside a; the
    // turn-granular planner hides a whole and keeps b (pair included).
    const plan = planCompactCut(events, 3_000);
    expect(plan).toBeDefined();
    if (plan === undefined) throw new Error("no plan");
    const hide = plan.hideThroughSeq;
    const calls = events.filter((event) => event.type === "tool.call");
    const results = new Map(
      events
        .filter((event) => event.type === "tool.result")
        .map((event) => [event.data.executionId, event.seq]),
    );
    for (const call of calls) {
      // executionId derives from the call row (I4) — the synthetic result
      // carries the same derived id.
      const resultSeq = results.get(executionIdFor(THREAD, call.seq));
      expect(resultSeq).toBeDefined();
      const callHidden = call.seq <= hide;
      const resultHidden = (resultSeq ?? 0) <= hide;
      expect(callHidden, `pair ${executionIdFor(THREAD, call.seq)} split`).toBe(resultHidden);
    }
  });

  test("turn estimates count text, tool arguments, and blob-sized results", () => {
    const events = syntheticTurn({ turnId: "a", inputKb: 1, toolPair: true });
    const estimate = estimateTurnTokens(events);
    const encoder = new TextEncoder();
    const inputText = payload("input-a", 1);
    const resultText = payload("result-a", 8);
    const expected = Math.ceil(
      (encoder.encode(inputText).byteLength +
        encoder.encode(JSON.stringify({ command: "ls" })).byteLength +
        encoder.encode(resultText).byteLength) /
        4,
    );
    expect(estimate).toBeGreaterThanOrEqual(Math.ceil(encoder.encode(inputText).byteLength / 4));
    expect(estimate).toBe(expected);
  });

  test("lastUsageTotal folds the newest receipt (usedTokens + window)", () => {
    const events = [
      rawEvent("model.usage_receipt", {
        turnId: "a",
        modelCallId: 2,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: null,
          estimated: true,
        },
      }),
      rawEvent("model.usage_receipt", {
        turnId: "a",
        modelCallId: 3,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 7,
          cacheCreationInputTokens: 3,
          contextWindow: 200_000,
          estimated: false,
        },
      }),
    ];
    expect(lastUsageTotal(events)).toEqual({ usedTokens: 130, contextWindow: 200_000 });
  });
});

// ---------------------------------------------------------------------------
// RPC gates + failure semantics (small dedicated rigs)
// ---------------------------------------------------------------------------

describe("#309 compact RPC gates", () => {
  afterEach(() => {
    resetRuntime();
  });

  /** RPC rejections must be captured via an attached-handler race-free read —
   * an `expect(stub.call()).rejects` leaves a same-tick rejection unclaimed
   * on the workerd transport and vitest counts it as a run error. */
  async function rejectionOf(promise: Promise<unknown>): Promise<string> {
    const error = await promise.then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }

  test("an active turn conflicts; the idle retry succeeds", async () => {
    const rig = await createRig({
      turns: [
        { deltas: ["real answer"] },
        { hang: true },
        { deltas: ["after compact"] },
        { deltas: ["post-compact answer"] },
      ],
    });
    const setup = await rig.stub.sendMessage({
      clientRequestId: "gate-setup",
      content: [{ type: "text", text: "seed content" }],
      mode: "start",
    });
    await rig.waitTurnComplete(setup.turnId);
    const busy = await rig.stub.sendMessage({
      clientRequestId: "gate-busy",
      content: [{ type: "text", text: "keep the turn open" }],
      mode: "start",
    });
    await rig.waitFor((all) =>
      all.some((event) => event.type === "model.call_started" && event.data.turnId === busy.turnId),
    );
    expect(await rejectionOf(rig.stub.compactThread({ keepRecentTokens: 1 }))).toMatch(
      /active turn|idle/,
    );
    await rig.stub.cancelTurn({ turnId: busy.turnId });
    await rig.waitTurnComplete(busy.turnId);
    const compacted = await rig.stub.compactThread({ keepRecentTokens: 1 });
    await rig.waitTurnComplete(compacted.turnId);
    expect(compactedRows(await rig.events()).length).toBe(1);
  });

  test("a journal with no completed model call refuses to compact", async () => {
    const rig = await createRig({ turns: [{ deltas: ["unused"] }] });
    expect(await rejectionOf(rig.stub.compactThread({}))).toMatch(/no completed model call/);
  });

  test("a journal that fits the budget refuses to compact", async () => {
    const rig = await createRig({ turns: [{ deltas: ["hello"] }, { deltas: ["unused"] }] });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "fits-1",
      content: [{ type: "text", text: "tiny" }],
      mode: "start",
    });
    await rig.waitTurnComplete(sent.turnId);
    expect(await rejectionOf(rig.stub.compactThread({ keepRecentTokens: 1_000_000 }))).toMatch(
      /fits the retention budget/,
    );
    expect(compactedRows(await rig.events())).toHaveLength(0);
  });

  test("an empty summary seals instead of persisting; the thread stays usable", async () => {
    const rig = await createRig({
      turns: [
        { deltas: ["real answer one"] },
        { deltas: ["real answer two"] },
        { deltas: ["   "] },
        { deltas: ["post-failure answer"] },
      ],
    });
    for (const label of ["seal-1", "seal-2"]) {
      const setup = await rig.stub.sendMessage({
        clientRequestId: label,
        content: [{ type: "text", text: `seed ${label}` }],
        mode: "start",
      });
      await rig.waitTurnComplete(setup.turnId);
    }
    const failed = await rig.stub.compactThread({ keepRecentTokens: 1 });
    await rig.waitFor((all) =>
      all.some((event) => event.type === "turn.failed" && event.data.turnId === failed.turnId),
    );
    const events = await rig.events();
    expect(compactedRows(events)).toHaveLength(0);
    expect(events.some((event) => event.type === "model.call_sealed")).toBe(true);
    // The sealed slice must not poison later projections: the next turn
    // projects clean and the thread continues (#309 acceptance).
    const next = await rig.stub.sendMessage({
      clientRequestId: "seal-3",
      content: [{ type: "text", text: "still here" }],
      mode: "start",
    });
    await rig.waitTurnComplete(next.turnId);
    expect(next.duplicated).toBe(false);
    const finalEvents = await rig.events();
    expect(() => replayEvents(finalEvents)).not.toThrow();
  });
});
