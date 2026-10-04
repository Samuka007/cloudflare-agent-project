import { env } from "cloudflare:workers";
import { afterEach, describe, expect, test } from "vitest";
import { createRig, resetRuntime, type Rig } from "./helpers.js";
import type { RecordedHubCall } from "../src/testing/recording-hub.js";
import { replayEvents } from "../src/turn-state.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";

/**
 * #197 L2 end-to-end: journal append → hub push RPC → frames, plus the D3
 * phase vocabulary and the D4 cursor/fold semantics the frames must carry.
 *
 * The rig binds HUB to the RecordingHubDO fixture: every journal row lands
 * there as exactly one recorded call (delta frame / phase-changed frame /
 * events-appended pointer), so the assertions read the frames the agent DO
 * actually produced — the same surface a subscribed SPA would receive.
 */

type PhaseRow = Extract<AnyAgentEvent, { type: "turn.phase" }>;
type DeltaRow = Extract<AnyAgentEvent, { type: "model.delta" }>;

const hubNamespace = (env as { HUB: DurableObjectNamespace }).HUB;
const hubStub = () => hubNamespace.get(hubNamespace.idFromName("hub"));

function hubRpc(): {
  takeCalls(): Promise<RecordedHubCall[]>;
  peekCalls(): Promise<RecordedHubCall[]>;
} {
  return hubStub() as unknown as {
    takeCalls(): Promise<RecordedHubCall[]>;
    peekCalls(): Promise<RecordedHubCall[]>;
  };
}

function takeCalls(): Promise<RecordedHubCall[]> {
  return hubRpc().takeCalls();
}

function peekCalls(): Promise<RecordedHubCall[]> {
  return hubRpc().peekCalls();
}

function phaseRowsOf(events: readonly AnyAgentEvent[], turnId?: string): PhaseRow[] {
  return events.filter(
    (event): event is PhaseRow =>
      event.type === "turn.phase" && (turnId === undefined || event.data.turnId === turnId),
  );
}

function deltaRowsOf(events: readonly AnyAgentEvent[], turnId: string): DeltaRow[] {
  return events.filter(
    (event): event is DeltaRow => event.type === "model.delta" && event.data.turnId === turnId,
  );
}

/** Journal fold of one turn's assistant text (spec §12: journal is authority). */
function journalText(events: readonly AnyAgentEvent[], turnId: string): string {
  return deltaRowsOf(events, turnId)
    .map((row) => (typeof row.data.text === "string" ? row.data.text : ""))
    .join("");
}

/** Calls this test's thread produced (cross-test drain + threadId filter). */
/** Must run BEFORE the turn is initiated: a post-hoc drain would swallow
 * frames that were already delivered while the test was awaiting the journal. */
async function drainHub(): Promise<void> {
  await takeCalls();
}

async function callsFor(threadId: string): Promise<RecordedHubCall[]> {
  // Poll the NON-destructive view: frames accumulate monotonically since the
  // pre-turn drain, so a late delivery is still seen. Reset once at the end.
  let calls: RecordedHubCall[] = [];
  await expect
    .poll(
      async () => {
        calls = (await peekCalls()).filter(
          (call) =>
            (call.kind === "delta" && call.frame?.id === threadId) ||
            (call.kind === "changed" && call.threadId === threadId),
        );
        return calls.some(
          (call) =>
            call.kind === "changed" &&
            call.changes?.includes("phase-changed") &&
            (call.metadata?.phase as { phase?: string } | undefined)?.phase === "settled",
        )
          ? "yes"
          : "no";
      },
      { timeout: 20_000, interval: 100 },
    )
    .toBe("yes");
  await takeCalls();
  return calls;
}

/** waitTurnComplete does not cover the trailing settled phase row. */
async function waitTurnSettled(rig: Rig, turnId: string): Promise<AnyAgentEvent[]> {
  return rig.waitFor((all) => phaseRowsOf(all, turnId).some((row) => row.data.phase === "settled"));
}

/** Structural fingerprint of one expected hub call (latestSeq ignored). */
function expectedFingerprint(events: readonly AnyAgentEvent[], threadId: string): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.type === "model.delta") {
      const { turnId, modelCallId, text } = event.data;
      out.push(
        JSON.stringify({
          kind: "delta",
          type: "delta",
          entity: "thread",
          id: threadId,
          turnId,
          itemId: `itm-am-${turnId}:${modelCallId}`,
          seq: event.seq,
          ...(typeof text === "string" ? { text } : {}),
        }),
      );
      // #148 bridge: the delta row ALSO emits the Tier-B refetch pointer so
      // the pinned (pre-S4) SPA refetches and the conversation row grows
      // mid-turn. Retire this entry with the bridge (agent-do.ts notifyHub).
      out.push(
        JSON.stringify({
          kind: "changed",
          changes: ["events-appended"],
          eventTypes: ["model.delta"],
        }),
      );
      continue;
    }
    if (event.type === "turn.phase") {
      out.push(
        JSON.stringify({
          kind: "changed",
          changes: ["phase-changed"],
          phase: {
            turnId: event.data.turnId,
            phase: event.data.phase,
            ...(event.data.modelCallId !== undefined
              ? { modelCallId: event.data.modelCallId }
              : {}),
            ...(event.data.reason !== undefined ? { reason: event.data.reason } : {}),
          },
        }),
      );
      continue;
    }
    out.push(
      JSON.stringify({
        kind: "changed",
        changes: ["events-appended"],
        eventTypes: [event.type],
      }),
    );
  }
  return out;
}

function recordedFingerprint(call: RecordedHubCall): string {
  if (call.kind === "delta") {
    const frame = call.frame as Record<string, unknown>;
    expect(typeof frame.latestSeq).toBe("number");
    const { latestSeq: _latestSeq, ...rest } = frame;
    return JSON.stringify({ kind: "delta", ...rest });
  }
  const metadata = call.metadata ?? {};
  expect(typeof metadata.latestSeq).toBe("number");
  const { latestSeq: _latestSeq, ...rest } = metadata;
  return JSON.stringify({ kind: "changed", changes: call.changes, ...rest });
}

afterEach(() => {
  resetRuntime();
});

describe("#197 L2: journal append → hub frames", () => {
  test("every journal row lands as its frame; delta payloads carry the fold truth", async () => {
    const rig = await createRig({ turns: [{ deltas: ["Hello", " ", "stream"] }] });
    const before = (await rig.events()).length;
    await drainHub();
    const sent = await rig.stub.sendMessage({
      clientRequestId: "l2-1",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    const events = await waitTurnSettled(rig, sent.turnId);
    const turnRows = events.slice(before);
    const calls = await callsFor(rig.threadId);

    // 1:1 — one call per journal row, structurally exact.
    expect(calls.map(recordedFingerprint).sort()).toEqual(
      expectedFingerprint(turnRows, rig.threadId).sort(),
    );

    // Delta frames carry the journal seq + inline text (the D4 cursor unit).
    const deltaFrames = calls
      .filter((call) => call.kind === "delta")
      .map((call) => call.frame as { seq: number; text?: string; latestSeq: number });
    const deltaRows = deltaRowsOf(turnRows, sent.turnId);
    expect(deltaFrames.map((frame) => frame.seq)).toEqual(deltaRows.map((row) => row.seq));
    expect(deltaFrames.map((frame) => frame.text)).toEqual(deltaRows.map((row) => row.data.text));
    const latestSeq = events[events.length - 1]?.seq ?? 0;
    for (const frame of deltaFrames) {
      expect(frame.latestSeq).toBeLessThanOrEqual(latestSeq);
    }

    // Spec §4: the ux view projects turn.phase 1:1 (the catch-up authority).
    const ux = await rig.stub.getEvents({ project: "ux" });
    const uxRows = ux.events as unknown as { type: string; seq: number }[];
    expect(uxRows.filter((row) => row.type === "turn/phase").map((row) => row.seq)).toEqual(
      phaseRowsOf(turnRows, sent.turnId).map((row) => row.seq),
    );
  });

  test("fold invariant: rendered text ≡ fold(journal[≤cursor]) under dup + drop + catch-up", async () => {
    // 3KB chunks exceed deltaFlushBytes=2048 → one journal row per chunk,
    // deterministic multi-frame delivery with zero timer dependence.
    const rig = await createRig({
      turns: [{ deltas: ["a".repeat(3072), "b".repeat(3072), "c".repeat(3072), "d".repeat(3072)] }],
    });
    await drainHub();
    const sent = await rig.stub.sendMessage({
      clientRequestId: "l2-2",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    await waitTurnSettled(rig, sent.turnId);
    const frames = (await callsFor(rig.threadId))
      .filter((call) => call.kind === "delta")
      .map((call) => call.frame as { seq: number; text?: string });
    expect(frames.length).toBe(4);
    const sorted = [...frames].sort((x, y) => x.seq - y.seq);

    // Lossless fold over seq-sorted frames ≡ journal fold.
    const lossless = sorted.map((frame) => frame.text ?? "").join("");
    const events = await rig.events();
    expect(lossless).toBe(journalText(events, sent.turnId));

    // D4 §8.2 consumer: cursor = max applied seq; seq ≤ cursor → dedupe skip.
    // Deliver with one duplicate and one dropped mid-frame.
    const [frameA, frameB, frameC, frameD] = sorted;
    if (
      frameA === undefined ||
      frameB === undefined ||
      frameC === undefined ||
      frameD === undefined
    ) {
      throw new Error("expected four delta frames");
    }
    const delivered = [frameA, frameA, frameC, frameD];
    let cursor = 0;
    let rendered = "";
    for (const frame of delivered) {
      if (frame.seq <= cursor) continue;
      rendered += frame.text ?? "";
      cursor = frame.seq;
    }
    // The dropped row is missing from the stream buffer, and folding the
    // journal up to the SAME cursor proves the mismatch is real (弃帧检测).
    const foldAtCursor = deltaRowsOf(events, sent.turnId)
      .filter((row) => row.seq <= cursor)
      .map((row) => (typeof row.data.text === "string" ? row.data.text : ""))
      .join("");
    expect(rendered).not.toBe(foldAtCursor);
    // Catch-up fetch (events?afterSeq semantics) re-derives the identical
    // text from the journal: frames accelerate, the journal decides.
    expect(foldAtCursor).toBe(lossless);
  });

  test("host_lost fires once per turn after the first host_offline dispatch", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "bash", arguments: { command: "ls" } }] },
        { deltas: ["recovered"] },
      ],
    });
    await rig.service.setHostOnline(false);
    await drainHub();
    const sent = await rig.stub.sendMessage({
      clientRequestId: "l2-3",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    const events = await waitTurnSettled(rig, sent.turnId);
    const rows = phaseRowsOf(events, sent.turnId);
    expect(rows.map((row) => row.data.phase)).toEqual([
      "host_lost",
      "stream_started",
      "first_token",
      "terminal",
      "settled",
    ]);
    const secondStart = events.filter((event) => event.type === "model.call_started")[1];
    expect(rows[0]?.data).toEqual({
      turnId: sent.turnId,
      phase: "host_lost",
      reason: "host_offline",
    });
    expect(rows[1]?.data.modelCallId).toBe(secondStart?.seq);
    expect(rows[2]?.data.modelCallId).toBe(secondStart?.seq);
    expect(rows[3]?.data).toEqual({ turnId: sent.turnId, phase: "terminal", reason: "completed" });
    expect(rows[4]?.data).toEqual({ turnId: sent.turnId, phase: "settled" });
    // Replay-pure fold (P3): recovery folds the identical sequence.
    expect(replayEvents(events).turns.get(sent.turnId)?.phases).toEqual([
      "host_lost",
      "stream_started",
      "first_token",
      "terminal",
      "settled",
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "tool.dispatch" &&
          (event.data as { outcome?: string }).outcome === "host_offline",
      ),
    ).toBe(true);

    // #148 acceptance on the ux view (§9.3 row 2): the host_offline dispatch
    // renders NO preempting system row — the offline placeholder lives on the
    // tool card — and the pure-chat continuation still streamed ("recovered").
    const ux = await rig.stub.getEvents({ project: "ux" });
    const uxRows = ux.events as unknown as {
      type: string;
      data?: { item?: { type: string; status?: string; output?: string } };
    }[];
    expect(uxRows.some((row) => row.type === "system/error")).toBe(false);
    const toolItem = uxRows.find(
      (row) => row.type === "item/completed" && row.data?.item?.type === "toolCall",
    )?.data?.item;
    if (toolItem?.type !== "toolCall") {
      throw new Error("ux projection lost the host_offline toolCall item");
    }
    expect(toolItem.status).toBe("failed");
    expect(toolItem.output).toBe("host_offline");
    expect(journalText(events, sent.turnId)).toContain("recovered");
  });

  test("stream_started repeats per model call; first_token stays once per turn", async () => {
    const rig = await createRig({
      turns: [
        { deltas: ["part one"], toolCalls: [{ name: "bash", arguments: { command: "ls" } }] },
        { deltas: ["part two"] },
      ],
    });
    await drainHub();
    const sent = await rig.stub.sendMessage({
      clientRequestId: "l2-4",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    const completion = rig.waitTurnComplete(sent.turnId);
    const withToolCall = await rig.waitFor((all) =>
      all.some((event) => event.type === "tool.call"),
    );
    const toolCall = withToolCall.find((event) => event.type === "tool.call");
    const executionId = `${rig.threadId}:${toolCall?.seq ?? 0}`;
    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: "" });
    await completion;

    const journal = await rig.events();
    const callStarts = journal.filter((event) => event.type === "model.call_started");
    expect(callStarts.length).toBe(2);
    expect(
      phaseRowsOf(journal, sent.turnId)
        .filter((row) => row.data.phase === "stream_started")
        .map((row) => row.data.modelCallId),
    ).toEqual(callStarts.map((event) => event.seq));
    expect(
      phaseRowsOf(journal, sent.turnId).filter((row) => row.data.phase === "first_token"),
    ).toHaveLength(1);

    // The hub saw exactly the same repetition pattern.
    const calls = await callsFor(rig.threadId);
    const phaseFrames = calls
      .filter((call) => call.kind === "changed" && call.changes?.includes("phase-changed"))
      .map((call) => (call.metadata?.phase as { phase: string }).phase);
    expect(phaseFrames.filter((phase) => phase === "stream_started")).toHaveLength(2);
    expect(phaseFrames.filter((phase) => phase === "first_token")).toHaveLength(1);
  });

  test("R2-bypass delta rows frame as freshness signals (no inline text)", async () => {
    // One 150KB delta exceeds r2BypassBytes=100KB → the journal row stores a
    // BlobRef and the frame must omit `text` (spec §6.1: freshness signal).
    const rig = await createRig({ turns: [{ deltas: ["x".repeat(150 * 1024)] }] });
    await drainHub();
    const sent = await rig.stub.sendMessage({
      clientRequestId: "l2-6",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    await waitTurnSettled(rig, sent.turnId);
    const events = await rig.events();
    const bigRow = deltaRowsOf(events, sent.turnId)[0];
    // The frame was built from the at-append data (BlobRef after offload) —
    // it carries no inline text even though the read path resolves the blob.
    const calls = await callsFor(rig.threadId);
    const frame = calls.find((call) => call.kind === "delta")?.frame as
      { seq: number; text?: string } | undefined;
    expect(frame?.seq).toBe(bigRow?.seq);
    expect(frame?.text).toBeUndefined();
    // The journal stays the rendering authority: the fetch view has the full
    // text (R2 blob resolved on read) — the §8.2 catch-up recovers everything
    // the freshness-only frame did not carry.
    expect(journalText(events, sent.turnId)).toHaveLength(150 * 1024);
  });

  test("terminal carries the failure reason; a byte-less turn never streams phases", async () => {
    const rig = await createRig({
      turns: [{ failBeforeFirstByte: { message: "boom", retryable: false } }],
    });
    await drainHub();
    const sent = await rig.stub.sendMessage({
      clientRequestId: "l2-5",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    const events = await waitTurnSettled(rig, sent.turnId);
    expect(phaseRowsOf(events, sent.turnId).map((row) => row.data.phase)).toEqual([
      "terminal",
      "settled",
    ]);
    const terminal = phaseRowsOf(events, sent.turnId).find((row) => row.data.phase === "terminal");
    expect(terminal?.data.reason).toBe("model_error");
    expect(journalText(events, sent.turnId)).toBe("");
  });
});
