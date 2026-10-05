import { afterEach, describe, expect, test } from "vitest";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { parseAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import {
  DEFAULT_COMPACTION_TRIGGER_SETTINGS,
  isContextOverflowFailure,
  planRetryCut,
  projectedContextTokens,
  shouldCompact,
} from "../src/compaction.js";
import { threadCompactedCut } from "../src/tools/session-tree.js";
import { modelRequestFromEvents } from "../src/translate.js";
import { replayEvents } from "../src/turn-state.js";
import { projectToUxEvents } from "../src/ux-projection.js";
import type { ModelRequest } from "../src/provider.js";
import { createRig, resetRuntime, type Rig } from "./helpers.js";

/**
 * #326 — overflow compact-and-retry (matrix §4 C1, depends on #309): a
 * context that overflows the window must recover by compacting and retrying,
 * never raw-fail while a valid cut exists. Two faces over one data plane:
 *
 * - Reactive: a pre-first-byte provider rejection whose message names the
 *   context window fails the turn `context_overflow`, then the auto compact
 *   turn (the #309 manual compact machinery, method "auto") lands its
 *   checkpoint and the failed input re-drives as a fresh turn.
 * - Proactive: the post-turn shouldCompact gate (pi compaction.ts:264-270,
 *   usage anchor + tail estimate vs window − reserve) compacts between turns
 *   so the next input never sees the overflow.
 *
 * The L1 pairing assertion rides everything: the cut boundary is a turn
 * start, and tool.call/tool.result pairs live strictly inside their turn, so
 * no marker can split a pair — asserted structurally on the planner and
 * end-to-end by the fact that the post-cut request rebuild (which THROWS on
 * dangling pairs) succeeds.
 */

// ---------------------------------------------------------------------------
// Pure faces — trigger policy, overflow verdict, retry ladder
// ---------------------------------------------------------------------------

describe("#326 shouldCompact (pi compaction.ts:264-270 port)", () => {
  const settings = DEFAULT_COMPACTION_TRIGGER_SETTINGS;

  test("crossing window − reserve triggers; riding below does not", () => {
    // 200_000 − 16_384 = 183_616: strictly above triggers, exactly on is safe.
    expect(shouldCompact(183_617, 200_000, settings)).toBe(true);
    expect(shouldCompact(183_616, 200_000, settings)).toBe(false);
    expect(shouldCompact(50_000, 200_000, settings)).toBe(false);
  });

  test("disabled settings and an unknown window never trigger", () => {
    expect(shouldCompact(199_999, 200_000, { ...settings, enabled: false })).toBe(false);
    // #308 honest-absence posture: no window denominator, no fabricated threshold.
    expect(shouldCompact(199_999, null, settings)).toBe(false);
  });
});

describe("#326 projectedContextTokens (usage anchor + tail estimate)", () => {
  const receipt = {
    turnId: "t1",
    modelCallId: 2,
    usage: {
      inputTokens: 180_000,
      outputTokens: 900,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 200_000,
      estimated: false,
    },
  };
  const anchored: AnyAgentEvent[] = [
    parseAgentEvent({
      id: "e1",
      threadId: "thr_proj",
      seq: 1,
      type: "turn.input",
      data: { turnId: "t1", inputId: "in1", content: [{ type: "text", text: "question" }] },
      createdAt: 1,
    }),
    parseAgentEvent({
      id: "e2",
      threadId: "thr_proj",
      seq: 2,
      type: "model.usage_receipt",
      data: receipt,
      createdAt: 2,
    }),
    parseAgentEvent({
      id: "e3",
      threadId: "thr_proj",
      seq: 3,
      type: "tool.result",
      data: {
        turnId: "t1",
        executionId: "exec_x",
        status: "ok",
        exitCode: 0,
        output: "x".repeat(4_000),
      },
      createdAt: 3,
    }),
  ];

  test("the receipt anchors the count; only post-receipt rows are estimated", () => {
    const projected = projectedContextTokens(anchored);
    // 4_000 bytes of tool result text → ceil(4000/4) = 1_000 tokens on top of
    // the provider's own 180_900.
    expect(projected.tokens).toBe(180_900 + 1_000);
    expect(projected.contextWindow).toBe(200_000);
  });

  test("no receipt → whole-journal estimate, window null", () => {
    const projected = projectedContextTokens(anchored.slice(0, 1));
    expect(projected.tokens).toBeGreaterThan(0);
    expect(projected.contextWindow).toBeNull();
  });

  test("a newer checkpoint anchors the estimate (the stale pre-cut receipt never re-triggers)", () => {
    const postCut = [
      ...anchored,
      parseAgentEvent({
        id: "e4",
        threadId: "thr_proj",
        seq: 4,
        type: "thread/compacted",
        data: {
          turnId: "turn_compact",
          hideThroughSeq: 3,
          tokensBefore: 180_900,
          tokensAfter: 2_000,
          contextWindow: 200_000,
          method: "auto",
        },
        createdAt: 4,
      }),
    ];
    const projected = projectedContextTokens(postCut);
    // The marker's own tail estimate anchors (2_000); the pre-cut receipt
    // (180_900) is ghost weight the cut already removed.
    expect(projected.tokens).toBe(2_000);
    expect(projected.contextWindow).toBe(200_000);
  });
});

describe("#326 isContextOverflowFailure (anchored provider shapes)", () => {
  test("Anthropic and OpenAI overflow shapes match", () => {
    expect(
      isContextOverflowFailure(
        'relay http 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 190000 tokens > 200000 maximum"}}',
      ),
    ).toBe(true);
    expect(
      isContextOverflowFailure(
        "relay http 400: This model's maximum context length is 16385 tokens. However, your messages resulted in 20000 tokens.",
      ),
    ).toBe(true);
    expect(
      isContextOverflowFailure("relay stream error: invalid_request_error context_length_exceeded"),
    ).toBe(true);
  });

  test("unrelated failures stay raw (no compaction hijack)", () => {
    expect(isContextOverflowFailure("relay http 400: invalid api key")).toBe(false);
    expect(isContextOverflowFailure("relay http 429: rate limited")).toBe(false);
    expect(isContextOverflowFailure("relay stream broke: connection reset")).toBe(false);
    expect(isContextOverflowFailure("relay stop_reason=max_tokens (length truncation)")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The L1 pairing assertion — turn-boundary cuts cannot split a tool pair
// ---------------------------------------------------------------------------

const THREAD = "thr_overflow_unit";
let unitSeq = 0;

function rawEvent(type: string, data: unknown): AnyAgentEvent {
  unitSeq += 1;
  return parseAgentEvent({
    id: `evt_ov_${unitSeq}`,
    threadId: THREAD,
    seq: unitSeq,
    type,
    data,
    createdAt: 1_700_000_000_000 + unitSeq,
  });
}

function kb(k: number): string {
  return "y".repeat(k * 1024);
}

/** One completed turn with a full tool pair (call + result). */
function toolPairTurn(turnId: string): AnyAgentEvent[] {
  const rows: AnyAgentEvent[] = [
    rawEvent("turn.input", {
      turnId,
      inputId: `in_${turnId}`,
      content: [{ type: "text", text: `${kb(6)}:${turnId}` }],
    }),
  ];
  const started = rawEvent("model.call_started", { turnId, consumedSteerSeqs: [] });
  rows.push(started);
  rows.push(
    rawEvent("model.call_completed", {
      turnId,
      modelCallId: started.seq,
      text: "",
      toolCalls: [{ name: "bash", arguments: { command: "ls" } }],
    }),
  );
  const call = rawEvent("tool.call", {
    turnId,
    modelCallId: started.seq,
    tool: "bash",
    arguments: { command: "ls" },
    timeoutMs: 30_000,
  });
  rows.push(call);
  rows.push(
    rawEvent("tool.result", {
      turnId,
      executionId: executionIdFor(THREAD, call.seq),
      status: "ok",
      exitCode: 0,
      output: kb(8),
    }),
  );
  rows.push(rawEvent("turn.completed", { turnId }));
  return rows;
}

/** Every tool pair sits wholly on one side of the boundary. */
function assertPairsUncut(events: readonly AnyAgentEvent[], hideThroughSeq: number): void {
  const callSeqByExecution = new Map<string, number>();
  for (const event of events) {
    if (event.type === "tool.call") {
      callSeqByExecution.set(executionIdFor(event.threadId, event.seq), event.seq);
    }
  }
  for (const event of events) {
    if (event.type !== "tool.result") continue;
    const callSeq = callSeqByExecution.get(event.data.executionId);
    if (callSeq === undefined) continue;
    expect(
      callSeq <= hideThroughSeq,
      `pair ${event.data.executionId} split at ${hideThroughSeq} (call ${callSeq}, result ${event.seq})`,
    ).toBe(event.seq <= hideThroughSeq);
  }
}

describe("#326 planRetryCut ladder + L1 pairing invariant", () => {
  afterEach(() => {
    unitSeq = 0;
  });

  test("the ladder keeps the newest turn when the estimator underestimated", () => {
    const events = [
      ...toolPairTurn("t1"),
      ...toolPairTurn("t2"),
      ...toolPairTurn("t3"),
      rawEvent("turn.input", {
        turnId: "t_overflow",
        inputId: "in_overflow",
        content: [{ type: "text", text: "the question that overflowed" }],
      }),
    ];
    const plan = planRetryCut(events, 20_000);
    expect(plan).toBeDefined();
    if (plan === undefined) throw new Error("unreachable");
    // Everything fits any sane budget by bytes/4, so the ladder falls to the
    // minimal rung: only the newest (failed) turn is retained.
    expect(plan.keptTurns).toHaveLength(1);
    expect(plan.firstKeptTurnInputSeq).toBe(
      events.find((event) => event.type === "turn.input" && event.data.turnId === "t_overflow")
        ?.seq,
    );
    assertPairsUncut(events, plan.hideThroughSeq);
  });

  test("a normal keepRecent crossing cuts at a turn boundary with pairs intact", () => {
    const events = [...toolPairTurn("t1"), ...toolPairTurn("t2"), ...toolPairTurn("t3")];
    const plan = planRetryCut(events, 1_000);
    expect(plan).toBeDefined();
    if (plan === undefined) throw new Error("unreachable");
    // 1K budget crosses inside t1's own walk: kept = [t1] is refused
    // (kept-still-fits → undefined at that rung)... the ladder's next rungs
    // keep [t2, t3] or [t3] — either way the boundary is a turn start.
    const firstKeptSeq = plan.firstKeptTurnInputSeq;
    expect(events.some((event) => event.type === "turn.input" && event.seq === firstKeptSeq)).toBe(
      true,
    );
    assertPairsUncut(events, plan.hideThroughSeq);
  });

  test("a single-turn journal has no recovery cut (raw failure stands)", () => {
    const events = [...toolPairTurn("t1")];
    expect(planRetryCut(events, 20_000)).toBeUndefined();
  });

  test("L1: the post-cut request rebuild succeeds over a marker journal (projection is the proof)", () => {
    const t1Rows = toolPairTurn("t1");
    const t2Rows = toolPairTurn("t2");
    const t3Rows = toolPairTurn("t3");
    const t3InputSeq = t3Rows.find((event) => event.type === "turn.input")?.seq;
    // The auto compact turn's checkpoint (the #326 shape), then the retry
    // turn — seqs strictly ascending, the marker between turns.
    const marker = rawEvent("thread/compacted", {
      turnId: "turn_compact",
      hideThroughSeq: (t3InputSeq ?? 0) - 1,
      tokensBefore: 90_000,
      tokensAfter: 4_000,
      contextWindow: 200_000,
      method: "auto",
    });
    const retryInput = rawEvent("turn.input", {
      turnId: "turn_retry",
      inputId: "in_t_overflow#compact-retry",
      content: [{ type: "text", text: "the question that overflowed" }],
    });
    const retryCall = rawEvent("model.call_started", {
      turnId: "turn_retry",
      consumedSteerSeqs: [],
    });
    const events = [
      rawEvent("thread.created", { title: "t", machineId: "m" }),
      ...t1Rows,
      ...t2Rows,
      ...t3Rows,
      marker,
      retryInput,
      retryCall,
    ];

    // The cut arms for the retry turn and hides exactly the pre-boundary span.
    const cut = threadCompactedCut(events, "turn_retry");
    expect(cut).toBeDefined();
    if (marker.type !== "thread/compacted") throw new Error("unreachable");
    expect(cut?.hideThroughSeq).toBe(marker.data.hideThroughSeq);
    assertPairsUncut(events, cut?.hideThroughSeq ?? -1);

    // The rebuild THROWS on a dangling tool pair (translate's invariant), so
    // success here is the end-to-end pairing proof. Kept turns = t3 only (the
    // marker journal carries no compact turn rows); hidden t1/t2 vanish.
    const request = modelRequestFromEvents(events, "turn_retry", retryCall.seq);
    expect(request.priorTurns?.map((turn) => turn.input)).toEqual([`${kb(6)}:t3`]);
    const body = [...(request.priorTurns ?? []).map((turn) => turn.input), request.input].join(
      "\n",
    );
    expect(body).not.toContain(":t1");
    expect(body).not.toContain(":t2");
    expect(body).toContain("the question that overflowed");
    expect(request.toolSurface).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Campaign faces — the real DO over the mock relay
// ---------------------------------------------------------------------------

const OVERFLOW_MESSAGE =
  'relay http 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 190000 tokens > 200000 maximum"}}';
const SUMMARY = "AUTO-SUMMARY: the leak hunt narrowed to the drain path.";
const T1_ANSWER = "first turn answer";
const RETRY_ANSWER = "recovered answer after compaction";

/** Deterministic KB-scale filler text (the compact.test campaign shape). */
function payload(tag: string, kbSize: number): string {
  const line = `${tag}:${"x".repeat(96)}`;
  const lines = Math.ceil((kbSize * 1024) / (line.length + 1));
  return Array.from({ length: lines }, () => line).join("\n");
}

const REACTIVE_USAGE = {
  inputTokens: 150_000,
  outputTokens: 100,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  contextWindow: 200_000,
  estimated: false,
} as const;

async function awaitRetryTurn(rig: Rig): Promise<{ retryTurnId: string; events: AnyAgentEvent[] }> {
  const events = await rig.waitFor((all) => {
    const retryInput = all.find(
      (event) => event.type === "turn.input" && event.data.inputId.endsWith("#compact-retry"),
    );
    if (retryInput === undefined) return false;
    if (retryInput.type !== "turn.input") return false;
    return all.some(
      (event) =>
        (event.type === "turn.completed" || event.type === "turn.failed") &&
        event.data.turnId === retryInput.data.turnId,
    );
  });
  const retryInput = events.find(
    (event) => event.type === "turn.input" && event.data.inputId.endsWith("#compact-retry"),
  );
  if (retryInput?.type !== "turn.input") throw new Error("retry turn.input vanished");
  const terminal = events.find(
    (event) =>
      (event.type === "turn.completed" || event.type === "turn.failed") &&
      event.data.turnId === retryInput.data.turnId,
  );
  expect(terminal?.type, "the retry turn must complete").toBe("turn.completed");
  return { retryTurnId: retryInput.data.turnId, events };
}

describe("#326 reactive overflow compact-and-retry (sustained rig)", () => {
  let rig: Rig;
  let captured: ModelRequest[];

  afterEach(() => {
    resetRuntime();
  });

  test("the overflowed turn recovers: fail context_overflow → auto compact → retry completes", async () => {
    rig = await createRig({
      turns: [
        { deltas: [T1_ANSWER], usage: REACTIVE_USAGE },
        // The overflow rejection: pre-first-byte, non-retryable.
        { failBeforeFirstByte: { message: OVERFLOW_MESSAGE, retryable: false } },
        // The auto compact turn's summarizer, then the retry turn's answer.
        { deltas: [SUMMARY] },
        { deltas: [RETRY_ANSWER] },
      ],
    });
    const first = await rig.stub.sendMessage({
      clientRequestId: "ov-1",
      content: [{ type: "text", text: "hunt the leak" }],
      mode: "start",
    });
    await rig.waitTurnComplete(first.turnId);
    const failed = await rig.stub.sendMessage({
      clientRequestId: "ov-2",
      content: [{ type: "text", text: "the question that overflowed" }],
      mode: "start",
    });
    const { retryTurnId, events } = await awaitRetryTurn(rig);

    // The failed turn is honest: reason context_overflow, no bare model_error.
    const failedRow = events.find(
      (event) => event.type === "turn.failed" && event.data.turnId === failed.turnId,
    );
    expect(failedRow?.type).toBe("turn.failed");
    if (failedRow?.type !== "turn.failed") throw new Error("unreachable");
    expect(failedRow.data.reason).toBe("context_overflow");

    // Exactly one auto marker; the boundary is the #309 checkpoint shape.
    const markers = events.filter(
      (event): event is Extract<AnyAgentEvent, { type: "thread/compacted" }> =>
        event.type === "thread/compacted",
    );
    expect(markers).toHaveLength(1);
    const marker = markers[0];
    if (marker === undefined) throw new Error("unreachable");
    expect(marker.data.method).toBe("auto");
    expect(marker.data.tokensBefore).toBe(150_100);
    expect(marker.data.contextWindow).toBe(200_000);
    // The retry turn's input seq is strictly past the marker (between-turns
    // arm rule) and past the boundary.
    const retryInputSeq = events.find(
      (event) => event.type === "turn.input" && event.data.turnId === retryTurnId,
    )?.seq;
    expect(marker.seq).toBeLessThan(retryInputSeq ?? Number.MAX_SAFE_INTEGER);
    expect(marker.data.hideThroughSeq).toBeLessThan(retryInputSeq ?? Number.MAX_SAFE_INTEGER);

    // The retry turn consumed the recovered answer from the mock script.
    captured = rig.mock().calls;
    const retryCallSeq = events.find(
      (event) => event.type === "model.call_started" && event.data.turnId === retryTurnId,
    )?.seq;
    const retryRequest = captured.find((request) => request.modelCallId === retryCallSeq);
    expect(retryRequest).toBeDefined();
    if (retryRequest === undefined) throw new Error("retry request not captured");
    expect(retryRequest.input).toBe("the question that overflowed");
    // The compact turn rides as the summary carrier; t1 (hidden) is gone.
    const body = [
      ...(retryRequest.priorTurns ?? []).map((turn) =>
        [turn.input, ...turn.calls.map((call) => call.text)].join("\n"),
      ),
      retryRequest.input,
    ].join("\n");
    expect(body).toContain("[context-compact]");
    expect(body).toContain(SUMMARY);
    expect(body).not.toContain("hunt the leak");

    // Billing conservation (I11): one mock entry consumed per started call.
    const startedCalls = events.filter((event) => event.type === "model.call_started");
    expect(rig.mock().callCount()).toBe(startedCalls.length);

    // The journal replays clean and the ux face parses (protocol union).
    expect(() => replayEvents(events)).not.toThrow();
    const ux = projectToUxEvents(events);
    expect(ux.some((event) => event.type === "thread/compacted")).toBe(true);
  });

  test("the summarizer request rides the tool-free compaction surface", () => {
    const compactRequests = captured.filter((request) => request.toolSurface === "compaction");
    expect(compactRequests).toHaveLength(1);
    const summarizer = compactRequests[0];
    if (summarizer === undefined) throw new Error("unreachable");
    expect(summarizer.input.startsWith("[context-compact]")).toBe(true);
    // The summarizer read the full pre-cut span (its own turn projects uncut).
    expect(summarizer.priorTurns?.some((turn) => turn.input === "hunt the leak")).toBe(true);
  });
});

describe("#326 proactive post-turn shouldCompact gate", () => {
  afterEach(() => {
    resetRuntime();
  });

  test("crossing the reserve compacts between turns; the next turn rides the cut", async () => {
    const rig = await createRig({
      turns: [
        // 48 KB inputs (≈12K tokens each by the bytes/4 estimator) so the cut
        // planner has a span worth summarizing: the walk crosses keepRecent
        // at t1, keeping [t1, t2] and hiding t0.
        { deltas: [`seed answer\n${payload("seed", 48)}`] },
        // This receipt crosses 200_000 − 16_384 → the gate fires post-turn.
        {
          deltas: [`second answer\n${payload("second-a", 48)}`],
          usage: { ...REACTIVE_USAGE, inputTokens: 190_000 },
        },
        { deltas: [SUMMARY] },
        { deltas: ["third turn answer"] },
      ],
    });
    const first = await rig.stub.sendMessage({
      clientRequestId: "pro-1",
      content: [{ type: "text", text: `seed question\n${payload("question", 48)}` }],
      mode: "start",
    });
    await rig.waitTurnComplete(first.turnId);
    const second = await rig.stub.sendMessage({
      clientRequestId: "pro-2",
      content: [{ type: "text", text: `second question\n${payload("second-q", 48)}` }],
      mode: "start",
    });
    await rig.waitTurnComplete(second.turnId);
    // The gate is fire-and-forget: wait for the marker AND its turn's
    // completion before feeding the next input (no FSM races).
    await rig.waitFor((all) => {
      const marker = all.find((event) => event.type === "thread/compacted");
      if (marker === undefined) return false;
      return all.some(
        (event) => event.type === "turn.completed" && event.data.turnId === marker.data.turnId,
      );
    });
    const third = await rig.stub.sendMessage({
      clientRequestId: "pro-3",
      content: [{ type: "text", text: "third question" }],
      mode: "start",
    });
    await rig.waitTurnComplete(third.turnId);

    const events = await rig.events();
    const markers = events.filter(
      (event): event is Extract<AnyAgentEvent, { type: "thread/compacted" }> =>
        event.type === "thread/compacted",
    );
    expect(markers).toHaveLength(1);
    const marker = markers[0];
    if (marker === undefined) throw new Error("unreachable");
    expect(marker.data.method).toBe("auto");
    // The cut sits between turns: the seed turn hidden, the crossing turn kept.
    const secondInputSeq = events.find(
      (event) => event.type === "turn.input" && event.data.turnId === second.turnId,
    )?.seq;
    expect(marker.data.hideThroughSeq).toBeLessThan(secondInputSeq ?? 0);
    assertPairsUncut(events, marker.data.hideThroughSeq);

    // The third turn's request projects the cut (seed question gone).
    const thirdCallSeq = events.find(
      (event) => event.type === "model.call_started" && event.data.turnId === third.turnId,
    )?.seq;
    const thirdRequest = rig.mock().calls.find((request) => request.modelCallId === thirdCallSeq);
    expect(thirdRequest).toBeDefined();
    if (thirdRequest === undefined) throw new Error("third request not captured");
    const body = [
      ...(thirdRequest.priorTurns ?? []).map((turn) =>
        [turn.input, ...turn.calls.map((call) => call.text)].join("\n"),
      ),
      thirdRequest.input,
    ].join("\n");
    expect(body).toContain(SUMMARY);
    expect(body).toContain("second question");
    expect(body).not.toContain("seed question");

    // No further compaction fires once below the threshold (marker count stays 1).
    expect(() => replayEvents(events)).not.toThrow();
  });

  test("below the threshold the gate never fires", async () => {
    const rig = await createRig({
      turns: [
        { deltas: ["small one"], usage: { ...REACTIVE_USAGE, inputTokens: 1_000 } },
        { deltas: ["small two"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "pro-low-1",
      content: [{ type: "text", text: "tiny question" }],
      mode: "start",
    });
    await rig.waitTurnComplete(sent.turnId);
    // Give the fire-and-forget gate a beat to (not) fire.
    await rig.waitFor((all) => all.some((event) => event.type === "turn.completed"));
    const events = await rig.events();
    expect(events.some((event) => event.type === "thread/compacted")).toBe(false);
  });
});

describe("#326 gates — the raw failure is preserved outside the auto faces", () => {
  afterEach(() => {
    resetRuntime();
  });

  test("autoCompactionEnabled=false keeps today's raw model_error", async () => {
    const rig = await createRig({
      watchdog: { autoCompactionEnabled: false },
      turns: [
        { deltas: ["answer"], usage: REACTIVE_USAGE },
        { failBeforeFirstByte: { message: OVERFLOW_MESSAGE, retryable: false } },
      ],
    });
    const first = await rig.stub.sendMessage({
      clientRequestId: "gate-off-1",
      content: [{ type: "text", text: "question" }],
      mode: "start",
    });
    await rig.waitTurnComplete(first.turnId);
    const failed = await rig.stub.sendMessage({
      clientRequestId: "gate-off-2",
      content: [{ type: "text", text: "overflowing question" }],
      mode: "start",
    });
    await rig.waitTurnComplete(failed.turnId);
    const events = await rig.events();
    const failedRow = events.find(
      (event) => event.type === "turn.failed" && event.data.turnId === failed.turnId,
    );
    expect(failedRow?.type).toBe("turn.failed");
    if (failedRow?.type !== "turn.failed") throw new Error("unreachable");
    expect(failedRow.data.reason).toBe("model_error");
    expect(events.some((event) => event.type === "thread/compacted")).toBe(false);
    expect(
      events.some(
        (event) => event.type === "turn.input" && event.data.inputId.endsWith("#compact-retry"),
      ),
    ).toBe(false);
  });

  test("a non-overflow rejection stays a bare model_error (no compaction hijack)", async () => {
    const rig = await createRig({
      turns: [
        { deltas: ["answer"], usage: REACTIVE_USAGE },
        { failBeforeFirstByte: { message: "relay http 400: invalid api key", retryable: false } },
      ],
    });
    const first = await rig.stub.sendMessage({
      clientRequestId: "gate-418-1",
      content: [{ type: "text", text: "question" }],
      mode: "start",
    });
    await rig.waitTurnComplete(first.turnId);
    const failed = await rig.stub.sendMessage({
      clientRequestId: "gate-418-2",
      content: [{ type: "text", text: "another question" }],
      mode: "start",
    });
    await rig.waitTurnComplete(failed.turnId);
    const events = await rig.events();
    const failedRow = events.find(
      (event) => event.type === "turn.failed" && event.data.turnId === failed.turnId,
    );
    expect(failedRow?.type).toBe("turn.failed");
    if (failedRow?.type !== "turn.failed") throw new Error("unreachable");
    expect(failedRow.data.reason).toBe("model_error");
    expect(events.some((event) => event.type === "thread/compacted")).toBe(false);
  });
});
