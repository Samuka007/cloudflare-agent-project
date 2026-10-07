import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { abortAllDurableObjects } from "cloudflare:test";
import { DEFAULT_EXPERIMENTAL_TOOL_CONFIG } from "../src/config.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import type { ModelRequest } from "../src/provider.js";
import { anthropicRequestBody, type WireCallOptions } from "../src/relay/wire.js";
import { rolloverRequestedInTurn } from "../src/tools/edge.js";
import { activeBranchAfterRewind, checkpointRewindState } from "../src/tools/session-tree.js";
import { modelRequestFromEvents } from "../src/translate.js";
import type { MockTurn } from "../src/testing/mock-provider.js";
import { createRig, resetRuntime, type Rig } from "./helpers.js";

/**
 * #313 — AgentDO × compaction context stress: the API-driven vacuum filler.
 *
 * Existing coverage is per-mechanism over short journals: replay identity
 * (#116/T26), the event surface (#257), single-pair checkpoint/rewind folds
 * (session-tree/translate units). Nothing drives the WHOLE chain over one
 * sustained API campaign: context growth across turns → a compaction
 * checkpoint crossing mid-session → turn continuity past the cut → journal
 * invariants → DO-eviction rehydration. This harness is that chain, run
 * locally against the real AgentDO under workerd (deterministic mock relay,
 * #257 rig family), and it lives in the default suite so CI owns the
 * regression (`pnpm test` → packages/agent-do `vitest run`).
 *
 * Campaign shape (12 turns, 20 model calls, one thread):
 *   t1..t6   — KB-scale warm-up turns; session context grows monotonically
 *              (#228 priorTurns ride every later request).
 *   cutA     — checkpoint → 2 KB-scale explorations → rewind → close. The
 *              rewind cut arms at turn end (#147): the summary replaces the
 *              hidden exploration span on every later request.
 *   postA1/2 — post-cut continuity: branch summary armed, span sealed.
 *   ── DO eviction drill (abortAllDurableObjects) mid-campaign ──
 *   cutB     — a second checkpoint/rewind pair re-arms over the post-A turns.
 *   sig      — new_context rollover signal mid-session (T1 signal surface
 *              only: journaled, replay-derivable, context-neutral).
 *   postB1   — continuity under the superseding cut.
 */

// ---------------------------------------------------------------------------
// Scripted campaign — deterministic payloads, every line tagged so wire/journal
// containment checks key on it (any leak of a hidden span names its row).
// ---------------------------------------------------------------------------

/** Single fields stay under the 100 KB r2BypassBytes default: the stress
 * journal is inline SQLite, not the blob detour (that path has its own tests). */
function payload(tag: string, kb: number): string {
  const line = `${tag}:${"x".repeat(96)}`;
  const lines = Math.ceil((kb * 1024) / (line.length + 1));
  return Array.from({ length: lines }, () => line).join("\n");
}

const WARM_UPS = ["t1", "t2", "t3", "t4", "t5", "t6"] as const;
type TurnLabel =
  (typeof WARM_UPS)[number] | "cutA" | "postA1" | "postA2" | "cutB" | "sig" | "postB1";
const TURN_ORDER: TurnLabel[] = [...WARM_UPS, "cutA", "postA1", "postA2", "cutB", "sig", "postB1"];

const REPORT_A = "cut A report: the leak is isolated to the drain path";
const REPORT_B = "cut B report: the second pass converged on the injector";
const CLOSING_A = "cut A settled; continuing with the retained report.";
const CLOSING_B = "cut B settled; the superseding report is authoritative.";

function inputOf(label: TurnLabel): string {
  return `stress turn ${label}\n${payload(`input-${label}`, 1)}`;
}

function campaignScript(): MockTurn[] {
  return [
    // t1..t6: one call each, KB-scale deltas inflate the session context.
    ...WARM_UPS.map((label) => ({ deltas: [payload(`delta-${label}`, 6)] })),
    // cutA: checkpoint → 2 KB-scale explorations → rewind → closing text.
    { toolCalls: [{ name: "checkpoint", arguments: { goal: "stress: find the leak" } }] },
    { toolCalls: [{ name: "think", arguments: { thoughts: payload("exploration-a1", 16) } }] },
    { toolCalls: [{ name: "think", arguments: { thoughts: payload("exploration-a2", 16) } }] },
    { toolCalls: [{ name: "rewind", arguments: { report: `  ${REPORT_A}  ` } }] },
    { deltas: [CLOSING_A] },
    { deltas: [payload("delta-postA1", 6)] },
    { deltas: [payload("delta-postA2", 6)] },
    // cutB: the second pair re-arms over the post-A turns.
    { toolCalls: [{ name: "checkpoint", arguments: { goal: "stress: second pass" } }] },
    { toolCalls: [{ name: "think", arguments: { thoughts: payload("exploration-b1", 16) } }] },
    { toolCalls: [{ name: "rewind", arguments: { report: `  ${REPORT_B}  ` } }] },
    { deltas: [CLOSING_B] },
    // sig: the new_context rollover signal, then the turn closes normally.
    { toolCalls: [{ name: "new_context", arguments: {} }] },
    { deltas: [payload("delta-sig", 2)] },
    { deltas: [payload("delta-postB1", 6)] },
  ];
}

const EXPECTED_CALLS = campaignScript().length;

// ---------------------------------------------------------------------------
// Campaign driver — one sustained API campaign in beforeAll; every test below
// asserts a different face of the same journal/captures (the campaign IS the
// fixture: mid-campaign eviction is part of the stress, not a per-test setup).
// ---------------------------------------------------------------------------

interface Campaign {
  rig: Rig;
  threadId: string;
  turnIds: Record<TurnLabel, string>;
  /** Journal read at the eviction point (postA2 terminal). */
  eventsPreEvict: AnyAgentEvent[];
  /** Final journal (campaign complete, post-eviction). */
  events: AnyAgentEvent[];
  /** Mock captures in campaign order (buildModelRequest outputs). */
  captured: ModelRequest[];
}

let campaign: Campaign;

beforeAll(async () => {
  const rig = await createRig({ turns: campaignScript() });
  const turnIds = {} as Record<TurnLabel, string>;
  // rig.waitTurnComplete is expect.poll-based, which needs a test context —
  // the campaign runs in beforeAll, so the driver polls the journal directly.
  // Real-interval polling is the deliberate shape here: the turn's completion
  // signal is only observable through journal reads (the same face the SPA
  // polls), and expect.poll cannot run outside a test.
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
  const send = async (label: TurnLabel): Promise<void> => {
    const sent = await rig.stub.sendMessage({
      clientRequestId: `compaction-stress-${label}`,
      content: [{ type: "text", text: inputOf(label) }],
      mode: "start",
    });
    expect(sent.steer, label).toBe(false);
    expect(sent.duplicated, label).toBe(false);
    await awaitTurnTerminal(label, sent.turnId);
    turnIds[label] = sent.turnId;
  };

  for (const label of WARM_UPS) await send(label);
  await send("cutA");
  await send("postA1");
  await send("postA2");

  const eventsPreEvict = await rig.events();
  await abortAllDurableObjects();

  // Post-eviction continuation: the revived DO rebuilds from the journal and
  // the campaign proceeds without a break. The idempotency guard is relaxed
  // here by design: an abort-poisoned first attempt may have persisted the
  // input row before the retry landed — the SAME turnId comes back either way.
  const cutB = await rig.afterAbort(() =>
    rig.stub.sendMessage({
      clientRequestId: "compaction-stress-cutB",
      content: [{ type: "text", text: inputOf("cutB") }],
      mode: "start",
    }),
  );
  await awaitTurnTerminal("cutB", cutB.turnId);
  turnIds.cutB = cutB.turnId;
  await send("sig");
  await send("postB1");

  const events = await rig.events();
  const captured = rig.mock().calls;
  expect(captured, "mock script drift — every entry must be consumed exactly once").toHaveLength(
    EXPECTED_CALLS,
  );
  campaign = { rig, threadId: rig.threadId, turnIds, eventsPreEvict, events, captured };
}, 120_000);

afterEach(() => {
  resetRuntime();
});

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Wire messages only — the tool surface is constant and excluded from bounds. */
const WIRE_OPTS: WireCallOptions = {
  model: "compaction-stress-model",
  maxTokens: 64,
  thinking: { type: "disabled" },
};
const wireOf = (request: ModelRequest): string =>
  JSON.stringify(anthropicRequestBody(request, WIRE_OPTS).messages);
const tokens = (text: string): number => Math.ceil(text.length / 4);

function callsOf(events: readonly AnyAgentEvent[], tool: string): AnyAgentEvent[] {
  return events.filter((event) => event.type === "tool.call" && event.data.tool === tool);
}

/** model.call_started seqs of one turn, oldest first. */
function callSeqsOf(events: readonly AnyAgentEvent[], turnId: string): number[] {
  return events
    .filter((event) => event.type === "model.call_started" && event.data.turnId === turnId)
    .map((event) => event.seq)
    .sort((a, b) => a - b);
}

function firstCallSeq(events: readonly AnyAgentEvent[], turnId: string): number {
  const first = callSeqsOf(events, turnId)[0];
  if (first === undefined) throw new Error(`no model.call_started for ${turnId}`);
  return first;
}

/** ok tool.result seq for the tool's index-th call (executionId pairing). */
function okResultSeq(
  events: readonly AnyAgentEvent[],
  threadId: string,
  tool: string,
  index: number,
): number {
  const call = callsOf(events, tool)[index];
  if (call?.type !== "tool.call") throw new Error(`no ${tool} call #${index}`);
  const executionId = executionIdFor(threadId, call.seq);
  const result = events.find(
    (event) =>
      event.type === "tool.result" &&
      event.data.executionId === executionId &&
      event.data.status === "ok",
  );
  if (result === undefined) throw new Error(`no ok ${tool} result #${index}`);
  return result.seq;
}

function capturedCall(turnId: string, modelCallId: number): ModelRequest {
  const found = campaign.captured.find(
    (request) => request.turnId === turnId && request.modelCallId === modelCallId,
  );
  if (found === undefined) throw new Error(`no captured request for ${turnId}#${modelCallId}`);
  return found;
}

/** The runtime request = journal projection + deployment gates (the exact
 * shape buildModelRequest hands the provider — agent-do.ts buildModelRequest). */
function projectedFrom(
  events: readonly AnyAgentEvent[],
  turnId: string,
  modelCallId: number,
): ModelRequest {
  return {
    ...modelRequestFromEvents(events, turnId, modelCallId),
    experimentalGates: { ...DEFAULT_EXPERIMENTAL_TOOL_CONFIG, generateImage: false },
  };
}

/** Point-in-time fold: the checkpoint/rewind state over the journal prefix. */
function stateAt(events: readonly AnyAgentEvent[], throughSeq: number) {
  return checkpointRewindState(
    events.filter((event) => event.seq <= throughSeq),
    campaign.threadId,
  );
}

// ---------------------------------------------------------------------------
// The stress faces
// ---------------------------------------------------------------------------

describe("#313 — AgentDO × compaction context stress (sustained API campaign)", () => {
  test("campaign integrity: 12/12 turns complete, journal gapless, sinceSeq resume exact", async () => {
    const { events } = campaign;
    const completed = events.flatMap((event) =>
      event.type === "turn.completed" ? [event.data.turnId] : [],
    );
    expect(completed.sort()).toEqual(TURN_ORDER.map((label) => campaign.turnIds[label]).sort());
    expect(
      events.some((event) => event.type === "turn.failed" || event.type === "turn.cancelled"),
    ).toBe(false);

    // 20 model calls, every one completed, zero sealed (no ruling-A stops).
    expect(events.filter((event) => event.type === "model.call_started")).toHaveLength(
      EXPECTED_CALLS,
    );
    expect(events.filter((event) => event.type === "model.call_completed")).toHaveLength(
      EXPECTED_CALLS,
    );
    expect(events.some((event) => event.type === "model.call_sealed")).toBe(false);

    // Append-only journal: gapless 1..latestSeq on the whole read.
    const whole = await campaign.rig.stub.getEvents({});
    expect(whole.latestSeq).toBe(whole.events.length);
    expect(whole.events.map((event) => event.seq)).toEqual(
      whole.events.map((_, index) => index + 1),
    );

    // The SPA resume path: a sinceSeq slice concatenated with the tail is the
    // whole journal — zero gaps, zero overlaps.
    const mid = Math.floor(whole.latestSeq / 2);
    const head = await campaign.rig.stub.getEvents({ sinceSeq: 0, limit: mid });
    const tail = await campaign.rig.stub.getEvents({
      sinceSeq: head.events[head.events.length - 1]?.seq ?? 0,
    });
    expect([...head.events, ...tail.events]).toEqual(whole.events);
  });

  test("journal checkpoint events: two ok pairs + the rollover signal, state machine over prefixes", () => {
    const { events, threadId, turnIds } = campaign;
    const cpA = okResultSeq(events, threadId, "checkpoint", 0);
    const rwA = okResultSeq(events, threadId, "rewind", 0);
    const cpB = okResultSeq(events, threadId, "checkpoint", 1);
    const rwB = okResultSeq(events, threadId, "rewind", 1);
    expect(cpA).toBeLessThan(rwA);
    expect(rwA).toBeLessThan(cpB);
    expect(cpB).toBeLessThan(rwB);

    // Rows ARE the state (omp docs/tools/checkpoint.md §Side Effects): the
    // fold walks the tool rows — no dedicated journal entry family exists.
    const cpACall = callsOf(events, "checkpoint")[0];
    expect(stateAt(events, (cpACall?.seq ?? 1) - 1)).toEqual({ phase: "idle" });
    expect(stateAt(events, cpA)).toEqual({ phase: "active", checkpointResultSeq: cpA });
    expect(stateAt(events, rwA)).toEqual({
      phase: "completed",
      checkpointResultSeq: cpA,
      rewindResultSeq: rwA,
      report: REPORT_A, // RewindTool trims the raw argument
    });
    expect(stateAt(events, cpB)).toEqual({ phase: "active", checkpointResultSeq: cpB });
    expect(stateAt(events, rwB)).toEqual({
      phase: "completed",
      checkpointResultSeq: cpB,
      rewindResultSeq: rwB,
      report: REPORT_B,
    });
    // Journal end = ONE active branch: the latest pair supersedes cut A.
    expect(checkpointRewindState(events, threadId)).toEqual({
      phase: "completed",
      checkpointResultSeq: cpB,
      rewindResultSeq: rwB,
      report: REPORT_B,
    });

    // new_context signal: acked ok, journaled, replay-derivable — true only
    // for the signaling turn (T1 surface; the boundary commit is the rollover
    // family, #79).
    const sigCall = callsOf(events, "new_context")[0];
    if (sigCall?.type !== "tool.call") throw new Error("no new_context");
    const sigAck = events.find(
      (event) =>
        event.type === "tool.result" &&
        event.data.executionId === executionIdFor(threadId, sigCall.seq),
    );
    if (sigAck?.type !== "tool.result") throw new Error("no new_context result");
    expect(sigAck.data.status).toBe("ok");
    expect(sigAck.data.output).toBe("New context window requested.");
    expect(rolloverRequestedInTurn(events, threadId, turnIds.sig)).toBe(true);
    for (const label of ["t1", "cutA", "postA2", "postB1"] as const) {
      expect(rolloverRequestedInTurn(events, threadId, turnIds[label]), label).toBe(false);
    }
  });

  test("cut A continuity: post-cut turns stay usable, summary armed, span sealed", () => {
    const { events, threadId, turnIds } = campaign;
    const expectedCut = {
      checkpointResultSeq: okResultSeq(events, threadId, "checkpoint", 0),
      rewindResultSeq: okResultSeq(events, threadId, "rewind", 0),
      summary: REPORT_A,
    };

    for (const label of ["postA1", "postA2"] as const) {
      const turnId = turnIds[label];
      const request = capturedCall(turnId, firstCallSeq(events, turnId));
      expect(request.branchCut, label).toEqual(expectedCut);
      // The summary opens the wire as the first user-side block (omp
      // session-context.ts:339-343 — entry = compaction, then the kept tail).
      const body = anthropicRequestBody(request, WIRE_OPTS);
      expect(body.messages[0]?.content[0], label).toEqual({
        type: "text",
        text: `[branch-summary] ${REPORT_A}`,
      });
    }

    // Sealing: no hidden-span byte reaches the post-cut wire.
    const sealed = wireOf(capturedCall(turnIds.postA1, firstCallSeq(events, turnIds.postA1)));
    for (const hidden of [
      "exploration-a1",
      "exploration-a2",
      CLOSING_A,
      "Rewind requested.",
      "input-cutA",
      ...WARM_UPS.map((label) => `delta-${label}`),
    ]) {
      expect(sealed, hidden).not.toContain(hidden);
    }

    // Pre-boundary turns stay replaced — priorTurns is absent, not stale.
    const postA1 = capturedCall(turnIds.postA1, firstCallSeq(events, turnIds.postA1));
    expect(postA1.priorTurns).toBeUndefined();
    // Post-cut turns chain normally: postA2 sees postA1 as its prior turn.
    const postA2 = capturedCall(turnIds.postA2, firstCallSeq(events, turnIds.postA2));
    expect(postA2.priorTurns).toHaveLength(1);
    expect(postA2.priorTurns?.[0]?.input).toBe(inputOf("postA1"));
    expect(wireOf(postA2)).toContain("delta-postA1");

    // omp cut-at-turn-end semantics under stress: the rewind turn's OWN calls
    // replayed uncut — each exploration rode the NEXT call's prior-call
    // slices (a call's own response never precedes its own request).
    for (const seq of callSeqsOf(events, turnIds.cutA)) {
      expect(capturedCall(turnIds.cutA, seq).branchCut, `cutA call ${seq}`).toBeUndefined();
    }
    const cutACallSeqs = callSeqsOf(events, turnIds.cutA);
    const secondThinkSeq = cutACallSeqs[2];
    const rewindCallSeq = cutACallSeqs[3];
    if (secondThinkSeq === undefined || rewindCallSeq === undefined) {
      throw new Error("cutA call chain shorter than scripted");
    }
    const secondThinkWire = wireOf(capturedCall(turnIds.cutA, secondThinkSeq));
    expect(secondThinkWire).toContain("exploration-a1");
    expect(secondThinkWire).not.toContain("exploration-a2");
    expect(wireOf(capturedCall(turnIds.cutA, rewindCallSeq))).toContain("exploration-a2");
  });

  test("cut B supersedes: the newest pair is the single active branch summary", () => {
    const { events, threadId, turnIds } = campaign;
    const expectedCut = {
      checkpointResultSeq: okResultSeq(events, threadId, "checkpoint", 1),
      rewindResultSeq: okResultSeq(events, threadId, "rewind", 1),
      summary: REPORT_B,
    };

    for (const label of ["sig", "postB1"] as const) {
      const request = capturedCall(turnIds[label], firstCallSeq(events, turnIds[label]));
      expect(request.branchCut, label).toEqual(expectedCut);
    }

    // Cut B replaces the whole pre-boundary span — including cut A's summary.
    const sig = capturedCall(turnIds.sig, firstCallSeq(events, turnIds.sig));
    const sigWire = wireOf(sig);
    expect(sigWire).toContain(`[branch-summary] ${REPORT_B}`);
    for (const gone of [REPORT_A, "exploration-b1", "delta-postA1", "delta-postA2"]) {
      expect(sigWire, gone).not.toContain(gone);
    }
    expect(sig.priorTurns).toBeUndefined();

    // Continuity under the superseding cut: postB1 chains off sig only.
    const postB1 = capturedCall(turnIds.postB1, firstCallSeq(events, turnIds.postB1));
    expect(postB1.priorTurns).toHaveLength(1);
    expect(postB1.priorTurns?.[0]?.input).toBe(inputOf("sig"));
    expect(postB1.priorTurns?.[0]?.calls).toHaveLength(2); // new_context + closing
    expect(wireOf(postB1)).toContain("delta-sig");
  });

  test("context growth is monotonic pre-cut; the cut bounds the post-cut wire", () => {
    const { events, turnIds } = campaign;
    const wires = WARM_UPS.map((label) =>
      wireOf(capturedCall(turnIds[label], firstCallSeq(events, turnIds[label]))),
    );
    for (let index = 1; index < wires.length; index++) {
      const current = wires[index];
      const previous = wires[index - 1];
      if (current === undefined || previous === undefined) continue;
      expect(current.length, `turn ${index + 1} grows over turn ${index}`).toBeGreaterThan(
        previous.length,
      );
    }
    // Growth is real session history: t6's request carries t1..t5 wholesale.
    const last = wires[wires.length - 1];
    if (last === undefined) throw new Error("no warm-up wires");
    for (const label of WARM_UPS.slice(0, -1)) {
      expect(last, label).toContain(`delta-${label}`);
    }

    // Effectiveness (#147 acceptance, token-count bound): the post-cut request
    // is bounded by overlay + input (+ JSON scaffolding slack) — the ~40 KB
    // hidden span cannot be inside.
    const postA1 = capturedCall(turnIds.postA1, firstCallSeq(events, turnIds.postA1));
    const postWire = wireOf(postA1);
    expect(tokens(postWire)).toBeLessThanOrEqual(
      tokens(`[branch-summary] ${REPORT_A}`) + tokens(inputOf("postA1")) + 40,
    );
    // Stress ratio: the KB-scale session collapsed to a small fraction.
    expect(postWire.length).toBeLessThan(Math.floor(last.length / 2));
  });

  test("replay consistency (#116): the final log re-projects every captured request", () => {
    const { events } = campaign;
    // Same log → same request, even though 12 turns and two cuts now follow:
    // the temporal folds (async boundaries, steer ledger, prior-turn slices,
    // and — since #325 — the as-of-call rewind cut) reconstruct every request
    // as it was THEN. 20/20, no shadow set.
    let checked = 0;
    for (const request of campaign.captured) {
      expect(
        projectedFrom(events, request.turnId, request.modelCallId),
        `${request.turnId}#${request.modelCallId}`,
      ).toEqual(request);
      checked += 1;
    }
    expect(checked).toBe(EXPECTED_CALLS);
  });

  test("multi-cut replay (#325): mid-campaign requests replay with the then-armed cut", () => {
    // The #325 fix: rewindContextCut selects the pair as of the replayed call
    // (checkpointRewindState bounded at modelCallId), so requests built under
    // cut A — postA1, postA2, and cutB's FIRST call — replay branchCut = cutA
    // instead of dropping it (the former pinned shadow: the latest-pair fold
    // saw pair B, whose rewind turn had not terminalized at those turns'
    // inputs, and the arming rule refused). cutB's later calls stay cutless in
    // both views — once pair B's checkpoint executes the fold goes active,
    // and its own turn replays uncut under the turn-end arming rule.
    const { events, threadId, turnIds } = campaign;
    const cutA = {
      checkpointResultSeq: okResultSeq(events, threadId, "checkpoint", 0),
      rewindResultSeq: okResultSeq(events, threadId, "rewind", 0),
      summary: REPORT_A,
    };
    const thenArmed: { label: "postA1" | "postA2" | "cutB"; callSeqs: number[] }[] = [
      { label: "postA1", callSeqs: [firstCallSeq(events, turnIds.postA1)] },
      { label: "postA2", callSeqs: [firstCallSeq(events, turnIds.postA2)] },
      { label: "cutB", callSeqs: [callSeqsOf(events, turnIds.cutB)[0] ?? -1] },
    ];
    for (const { label, callSeqs } of thenArmed) {
      for (const seq of callSeqs) {
        const live = capturedCall(turnIds[label], seq);
        expect(live.branchCut, `${label}#${seq} was armed with cut A at call time`).toEqual(cutA);
        const replayed = modelRequestFromEvents(events, turnIds[label], seq);
        expect(replayed.branchCut, `${label}#${seq} replays the then-armed cut`).toEqual(cutA);
      }
    }
  });

  test("DO eviction mid-campaign: journal truth rehydrates; memory state matches; campaign continues", async () => {
    const { eventsPreEvict, events, threadId, turnIds } = campaign;
    const fingerprint = (list: readonly AnyAgentEvent[]) =>
      list.map((event) => [event.seq, event.type, event.id]);

    // The final journal extends the pre-eviction journal exactly — the
    // revival appended forward, never rewrote (fingerprint identity on the
    // shared prefix; a fresh whole-read still matches the campaign capture).
    expect(fingerprint(events.slice(0, eventsPreEvict.length))).toEqual(
      fingerprint(eventsPreEvict),
    );
    expect(fingerprint(await campaign.rig.events())).toEqual(fingerprint(events));
    // Revival must not re-append lifecycle rows: exactly one thread.created.
    expect(events.filter((event) => event.type === "thread.created")).toHaveLength(1);

    // Memory-state projection is journal truth across the eviction: the SAME
    // journal prefix, read before the abort and projected from the revived
    // DO's storage, folds identically. (The state legitimately ADVANCES after
    // the eviction — pair B lands post-revival — so the comparison anchors on
    // the shared prefix, not the whole journal.)
    expect(checkpointRewindState(eventsPreEvict, threadId)).toEqual(
      checkpointRewindState(events.slice(0, eventsPreEvict.length), threadId),
    );

    // Active-branch partition identical across revival (evaluated at the cut A
    // rewind moment): kept ends at the checkpoint boundary, hidden covers the
    // rest of the prefix exactly, summary is the retained report.
    const rwA = okResultSeq(events, threadId, "rewind", 0);
    const before = activeBranchAfterRewind(
      eventsPreEvict.filter((event) => event.seq <= rwA),
      threadId,
    );
    const after = activeBranchAfterRewind(
      events.filter((event) => event.seq <= rwA),
      threadId,
    );
    expect(after).toBeDefined();
    expect(after?.summary).toBe(REPORT_A);
    expect(after?.kept.length).toBe(before?.kept.length);
    expect(after?.hidden).toEqual(before?.hidden);
    expect((after?.kept.length ?? 0) + (after?.hidden.length ?? 0)).toBe(rwA);
    expect(after?.kept.at(-1)?.seq).toBe(okResultSeq(events, threadId, "checkpoint", 0));

    // The pre-eviction live capture equals the revived journal's projection:
    // in-memory state === replay state (the DO-eviction expectation), anchored
    // on the eviction-moment journal (eventsPreEvict); the final-log projection
    // of the same request is the replay-consistency test above (the #325
    // multi-cut shadow lives there no more).
    const postA1Seq = firstCallSeq(events, turnIds.postA1);
    expect(projectedFrom(eventsPreEvict, turnIds.postA1, postA1Seq)).toEqual(
      capturedCall(turnIds.postA1, postA1Seq),
    );

    // Continuity across revival was exercised live: cutB terminalized after
    // the eviction with the then-armed cut A on its pre-rewind calls.
    const cutBFirstSeq = callSeqsOf(events, turnIds.cutB)[0];
    if (cutBFirstSeq === undefined) throw new Error("no cutB calls");
    expect(capturedCall(turnIds.cutB, cutBFirstSeq).branchCut?.summary).toBe(REPORT_A);
  });
});
