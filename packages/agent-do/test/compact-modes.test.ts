import { afterEach, describe, expect, test } from "vitest";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import {
  DEFAULT_COMPACTION_METHOD_ORDER,
  isCompactMode,
  planCompactCut,
  resolveCompactMode,
  resolveCompactionMethodOrder,
  turnSlices,
} from "../src/compaction.js";

import type { MockTurn } from "../src/testing/mock-provider.js";
import { createRig, resetRuntime, type Rig } from "./helpers.js";

/**
 * #547 — the omp compact-mode taxonomy on the DO faces: `snap` (the no-model-
 * call snapshot cut — checkpoint hides everything up to and including the
 * snap turn's own directive, the journal stays the archive per #116), `remote`
 * (the summarization call pins the route-validated selection through the #351
 * execution mechanism), and the methodOrder preference resolution (omp
 * DEFAULT_COMPACTION_METHOD_ORDER / resolveCompactionMethodOrder semantics).
 * The soft face is the #309 campaign in compact.test.ts; here the two new
 * drivers, their gates, and the cut-planner interactions are the surface.
 */

const USAGE = {
  inputTokens: 2_000,
  outputTokens: 100,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  contextWindow: 200_000,
  estimated: false,
} as const;

const PRE_SNAP_PAYLOAD = "x".repeat(4 * 1024);

function snapScript(): MockTurn[] {
  return [
    { deltas: ["pre-snap one"], usage: { ...USAGE } },
    { deltas: [`pre-snap two ${PRE_SNAP_PAYLOAD}`] },
    // The post-snap turn — the mock script has NO summarization entry: snap
    // consumes zero model calls by construction.
    { deltas: ["post-snap answer"] },
  ];
}

async function sendTurn(rig: Rig, label: string, input: string): Promise<string> {
  const sent = await rig.stub.sendMessage({
    clientRequestId: `compact-modes-${label}`,
    content: [{ type: "text", text: input }],
    mode: "start",
  });
  expect(sent.steer, label).toBe(false);
  // The rig's journal-poll primitive (expect.poll): the awaited condition is
  // the turn.completed row itself, never a guessed duration; a failed/cancelled
  // turn never satisfies the predicate and the poll timeout names the turn.
  await rig.waitFor((all) =>
    all.some((event) => event.type === "turn.completed" && event.data.turnId === sent.turnId),
  );
  return sent.turnId;
}

async function awaitSnapTerminal(rig: Rig, turnId: string): Promise<AnyAgentEvent[]> {
  return rig.waitFor((all) =>
    all.some((event) => event.type === "turn.completed" && event.data.turnId === turnId),
  );
}

const compactedRows = (events: readonly AnyAgentEvent[]) =>
  events.filter(
    (event): event is Extract<AnyAgentEvent, { type: "thread/compacted" }> =>
      event.type === "thread/compacted",
  );

const inputOf = (events: readonly AnyAgentEvent[], turnId: string) => {
  const input = events.find((event) => event.type === "turn.input" && event.data.turnId === turnId);
  if (input?.type !== "turn.input") throw new Error(`no turn.input for ${turnId}`);
  return input;
};

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

afterEach(() => {
  resetRuntime();
});

// ---------------------------------------------------------------------------
// snap — the no-model-call snapshot cut
// ---------------------------------------------------------------------------

describe("#547 snap compact", () => {
  test("the checkpoint hides everything including the directive; no model call runs", async () => {
    const rig = await createRig({ turns: snapScript() });
    await sendTurn(rig, "pre1", `one\n${PRE_SNAP_PAYLOAD}`);
    await sendTurn(rig, "pre2", "two");

    const mockCallsBefore = rig.mock().callCount();
    const snap = await rig.stub.compactThread({ mode: "snap" });
    expect(snap.duplicated).toBe(false);
    const events = await awaitSnapTerminal(rig, snap.turnId);

    // Zero model calls consumed (I11: calls.length === model.call_started).
    expect(rig.mock().callCount()).toBe(mockCallsBefore);
    expect(
      events.some(
        (event) => event.type === "model.call_started" && event.data.turnId === snap.turnId,
      ),
    ).toBe(false);

    // The slice is exactly input → checkpoint → completed.
    const input = inputOf(events, snap.turnId);
    const terminal = events.find(
      (event) => event.type === "turn.completed" && event.data.turnId === snap.turnId,
    );
    if (terminal === undefined) throw new Error("unreachable");
    const slice = events.filter((event) => event.seq >= input.seq && event.seq <= terminal.seq);
    expect(slice.map((event) => event.type)).toEqual([
      "turn.input",
      "thread/compacted",
      "turn.completed",
    ]);
    expect(input.data.compactMode).toBe("snap");

    const marker = compactedRows(events).at(-1);
    if (marker === undefined) throw new Error("unreachable");
    expect(marker.data.mode).toBe("snap");
    expect(marker.data.method).toBe("manual");
    expect(marker.data.turnId).toBe(snap.turnId);
    // The directive row hides WITH the cut: the fresh context is truly empty.
    expect(marker.data.hideThroughSeq).toBe(input.seq);
    expect(marker.data.tokensAfter).toBe(0);
    expect(marker.data.tokensBefore).toBe(USAGE.inputTokens + USAGE.outputTokens);
    expect(marker.data.contextWindow).toBe(USAGE.contextWindow);

    // The archive stays replayable: the hidden rows are all still in the log.
    expect(events.filter((event) => event.seq <= marker.data.hideThroughSeq)).toHaveLength(
      marker.data.hideThroughSeq,
    );
  }, 120_000);

  test("the post-snap request rebuild is a fresh context (no pre-snap history, no directive)", async () => {
    const rig = await createRig({ turns: snapScript() });
    await sendTurn(rig, "pre1", `one\n${PRE_SNAP_PAYLOAD}`);
    await sendTurn(rig, "pre2", "two");
    const snap = await rig.stub.compactThread({ mode: "snap" });
    await awaitSnapTerminal(rig, snap.turnId);

    const post = await sendTurn(rig, "post", "post-snap follow-up");
    const events = await rig.events();
    const postCallSeq = events.find(
      (event) => event.type === "model.call_started" && event.data.turnId === post,
    )?.seq;
    const request = rig.mock().calls.find((call) => call.modelCallId === postCallSeq);
    if (request === undefined) throw new Error("post-snap request not captured");
    // Fresh context: every pre-snap payload and the snap directive are
    // cut-folded; the request carries only the new input.
    expect(request.priorTurns).toBeUndefined();
    expect(request.input).toBe("post-snap follow-up");
  }, 120_000);

  test("a later soft cut never keeps the snap slice (the planner skips snapshot bookkeeping)", async () => {
    const rig = await createRig({ turns: snapScript() });
    await sendTurn(rig, "pre1", `one\n${PRE_SNAP_PAYLOAD}`);
    const snap = await rig.stub.compactThread({ mode: "snap" });
    await awaitSnapTerminal(rig, snap.turnId);
    await sendTurn(rig, "post", "post-snap follow-up");

    const events = await rig.events();
    const slices = turnSlices(events);
    // The snap turn's slice is invisible to the planner…
    expect(slices.some((slice) => slice.inputSeq === inputOf(events, snap.turnId).seq)).toBe(false);
    // …and a soft cut plans only over real turns: the kept tail starts at the
    // post-snap turn (the only slice left).
    const plan = planCompactCut(events, 1);
    if (plan === undefined) throw new Error("planner refused a multi-slice journal");
    const post = events.find(
      (event) => event.type === "turn.input" && event.data.inputId === "compact-modes-post",
    );
    if (post?.type !== "turn.input") throw new Error("unreachable");
    expect(plan.firstKeptTurnInputSeq).toBe(post.seq);
  }, 120_000);

  test("the no-model-activity gate stays; the retention-budget gate does not apply", async () => {
    const rig = await createRig({ turns: [{ deltas: ["ok"] }] });
    // Fresh thread: no model call ever completed — snap refuses like soft.
    expect(await rejectionOf(rig.stub.compactThread({ mode: "snap" }))).toMatch(
      /no completed model call/,
    );
    // A tiny journal snaps anyway (the snapshot is a deliberate reset, not a
    // summarization economy — omp snapcompact runs whenever triggered).
    await sendTurn(rig, "tiny", "small opener");
    const snap = await rig.stub.compactThread({ mode: "snap" });
    await awaitSnapTerminal(rig, snap.turnId);
    const marker = compactedRows(await rig.events()).at(-1);
    expect(marker?.data.mode).toBe("snap");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// remote — the delegated summarization selection
// ---------------------------------------------------------------------------

describe("#547 remote compact", () => {
  test("the summarization turn pins the remote selection; the marker names the mode", async () => {
    const rig = await createRig({
      turns: [
        { deltas: ["pre-remote one"], usage: { ...USAGE } },
        { deltas: ["REMOTE-SUMMARY: the delegated model wrote this."] },
      ],
    });
    await sendTurn(rig, "pre1", `one\n${PRE_SNAP_PAYLOAD}`);
    await sendTurn(rig, "pre2", "two");

    const remote = await rig.stub.compactThread({
      mode: "remote",
      remote: { providerId: "omp", model: "mock-model" },
      // The retention budget is a soft-face gate; the knob (kept at 1) keeps
      // the small fixture journal past it so the remote driver is the surface.
      keepRecentTokens: 1,
    });
    const events = await awaitSnapTerminal(rig, remote.turnId);

    const input = inputOf(events, remote.turnId);
    expect(input.data.compactMode).toBe("remote");
    // #351 mechanism: the remote selection rides the turn pin — the dispatch
    // (and any replay) resolves through the same fail-closed registry path.
    expect(input.data.execution).toEqual({ providerId: "omp", model: "mock-model" });
    const marker = compactedRows(events).at(-1);
    if (marker === undefined) throw new Error("unreachable");
    expect(marker.data.mode).toBe("remote");
    expect(marker.data.method).toBe("manual");
    // The summarization call ran exactly once and its text is the checkpoint's
    // visible carrier (the summary rides the request as the compact turn's
    // own history — the #309 shape, now under a delegated model).
    // pre1 + pre2 + the delegated summarization call.
    expect(rig.mock().callCount()).toBe(3);
    expect(marker.data.tokensAfter).toBeGreaterThan(0);
  }, 120_000);

  test("the remote/remote-only field pairing fails closed", async () => {
    const rig = await createRig({ turns: [{ deltas: ["ok"] }] });
    await sendTurn(rig, "pre1", "one");
    expect(await rejectionOf(rig.stub.compactThread({ mode: "remote" }))).toMatch(
      /remote compact requires the route-validated remote selection/,
    );
    expect(
      await rejectionOf(
        rig.stub.compactThread({
          mode: "soft",
          remote: { providerId: "omp", model: "mock-model" },
        }),
      ),
    ).toMatch(/remote-mode-only field/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Taxonomy units — the omp methodOrder resolution
// ---------------------------------------------------------------------------

describe("#547 methodOrder resolution (omp semantics)", () => {
  test("DEFAULT_COMPACTION_METHOD_ORDER is the omp order reduced to the ported three", () => {
    expect(DEFAULT_COMPACTION_METHOD_ORDER).toEqual(["remote", "snap", "soft"]);
  });

  test("resolveCompactionMethodOrder filters malformed entries and dedupes, first occurrence wins", () => {
    expect(
      resolveCompactionMethodOrder(["snap", "bogus", "remote", "snap", "soft", 42, null]),
    ).toEqual(["snap", "remote", "soft"]);
    expect(resolveCompactionMethodOrder("not-an-array")).toEqual([]);
    expect(resolveCompactionMethodOrder([])).toEqual([]);
    expect(resolveCompactionMethodOrder(["soft", "soft"])).toEqual(["soft"]);
  });

  test("isCompactMode is a narrowing guard over exactly the three modes", () => {
    expect(isCompactMode("soft")).toBe(true);
    expect(isCompactMode("remote")).toBe(true);
    expect(isCompactMode("snap")).toBe(true);
    expect(isCompactMode("snapcompact")).toBe(false);
    expect(isCompactMode(undefined)).toBe(false);
  });

  test("resolveCompactMode: explicit wins, the order walks eligibility, soft is the floor", () => {
    const eligible = (mode: "soft" | "remote" | "snap"): boolean => mode !== "remote";
    expect(resolveCompactMode(DEFAULT_COMPACTION_METHOD_ORDER, "snap", eligible)).toBe("snap");
    // remote ineligible → the order falls to snap.
    expect(resolveCompactMode(DEFAULT_COMPACTION_METHOD_ORDER, undefined, eligible)).toBe("snap");
    // All-ineligible order → the soft floor.
    expect(resolveCompactMode(["remote"], undefined, () => false)).toBe("soft");
    // Empty order → the soft floor.
    expect(resolveCompactMode([], undefined, () => true)).toBe("soft");
    // Explicit mode ignores eligibility (validated upstream — route 409s an
    // unconfigured remote before the DO ever sees it).
    expect(resolveCompactMode([], "remote", () => false)).toBe("remote");
  });
});
