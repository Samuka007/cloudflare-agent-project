import { afterEach, describe, expect, test } from "vitest";
import { abortAllDurableObjects } from "cloudflare:test";
import { parseThreadEvent } from "@cap/protocol";
import { createRig, resetRuntime, typeList } from "./helpers.js";
import { projectToUxEvents } from "../src/ux-projection.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";

/**
 * #257 CoT surface end-to-end (agent-DO half): provider thinking chunks →
 * `model.thinking` journal rows → `item/reasoning/textDelta` ux events. The
 * timeline `activeThinking` fold lives in apps/server-worker
 * (test/compat/active-thinking.test.ts) — the seam where the SPA consumes it.
 */

afterEach(() => {
  resetRuntime();
});

describe("#257 — thinking journal rows", () => {
  test("thinking deltas journal under the call guard; answer text stays separate", async () => {
    const rig = await createRig({
      turns: [{ thinkingDeltas: ["ponder ", "more"], deltas: ["Answer text"] }],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "cot-1",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    const events = await rig.waitTurnComplete(sent.turnId);

    // The two scripted thinking deltas coalesce under the flush discipline —
    // the call ends (answer chunk) before either flush threshold trips, so
    // the boundary flush lands ONE row carrying the full reasoning prefix.
    const thinkingRows = events.filter((event) => event.type === "model.thinking");
    expect(thinkingRows).toHaveLength(1);
    const thinkingRow = thinkingRows[0];
    expect(thinkingRow?.data).toMatchObject({
      turnId: sent.turnId,
      text: "ponder more",
      modelCallId: expect.any(Number),
    });
    for (const row of thinkingRows) {
      expect(row.data).toMatchObject({ turnId: sent.turnId, modelCallId: expect.any(Number) });
    }

    // Answer accounting untouched: call_completed.text carries ONLY answer text.
    const completed = events.filter((event) => event.type === "model.call_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data).toMatchObject({ text: "Answer text" });

    // Phase semantics: stream_started fired (thinking is a stream byte);
    // first_token stays answer-bound — exactly one, before the answer delta.
    const streamStarts = events.filter(
      (event) => event.type === "turn.phase" && event.data.phase === "stream_started",
    );
    const firstTokens = events.filter(
      (event) => event.type === "turn.phase" && event.data.phase === "first_token",
    );
    expect(streamStarts).toHaveLength(1);
    expect(firstTokens).toHaveLength(1);
    const answerDeltaSeq = events.find((event) => event.type === "model.delta")?.seq;
    expect(firstTokens[0]?.seq).toBeLessThan(answerDeltaSeq ?? Infinity);
  });

  test("oversize reasoning offloads to R2 under the same blob field as model.delta", async () => {
    const bigChunk = "x".repeat(4096);
    const rig = await createRig({
      turns: [{ thinkingDeltas: [bigChunk, bigChunk], deltas: ["ok"] }],
      // Flush at the chunk boundary (4096 bytes: chunk 1 crosses the
      // threshold mid-stream) with the R2 bypass BELOW the flushed prefix —
      // the second chunk's 4096 bytes land past 4096 accumulated, so at
      // least one row carries an oversize payload. Probe-verified shape:
      // row(5)=4096-byte string, row(6)=4096-byte string, both before the
      // terminal; a bypass at 2048 makes any ≥2049-byte row blob-offload.
      watchdog: { deltaFlushBytes: 4096, deltaFlushMs: 1, r2BypassBytes: 2048 },
    });
    // constructor env is absent in the rig: set the flush thresholds directly.
    await rig.stub.configureWatchdog({ deltaFlushBytes: 4096, deltaFlushMs: 1, r2BypassBytes: 2048 });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "cot-blob",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    // With a 1ms flush timer the 150KB row lands mid-call just like the
    // stream-hub R2 delta test.
    const rows = events.filter((event) => event.type === "model.thinking");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const withBlob = rows.find(
      (event) => event.type === "model.thinking" && typeof event.data.text !== "string",
    );
    expect(withBlob).toBeDefined();
    if (
      withBlob !== undefined &&
      withBlob.type === "model.thinking" &&
      typeof withBlob.data.text !== "string"
    ) {
      expect(withBlob.data.text.__blob__.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("#257 — ux projection: item/reasoning/textDelta", () => {
  test("model.thinking projects 1:1 into reasoning deltas with the itm-rs item id", async () => {
    const rig = await createRig({
      turns: [{ thinkingDeltas: ["think a", "think b"], deltas: ["answer"] }],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "cot-ux",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    const events: AnyAgentEvent[] = await rig.waitTurnComplete(sent.turnId);
    const thinkingRows = events.filter((event) => event.type === "model.thinking");
    // Blob-offloaded rows contribute nothing to the ux face (raw-only).
    const inlineRows = thinkingRows.filter(
      (event) => event.type === "model.thinking" && typeof event.data.text === "string",
    );
    const projected = projectToUxEvents(events).map(parseThreadEvent);
    const reasoning = projected.filter(
      (event) => event.type === "item/reasoning/textDelta",
    );
    expect(reasoning.map((event) => event.seq)).toEqual(
      inlineRows.map((event) => event.seq),
    );
    for (const event of reasoning) {
      if (event.type !== "item/reasoning/textDelta") continue;
      expect(event.data).toMatchObject({
        turnId: sent.turnId,
        itemId: expect.stringMatching(/^itm-rs-.*:\d+$/),
      });
    }
    // The ux view never invents seqs the raw log cannot replay (I3).
    const journalSeqs = new Set(events.map((event) => event.seq));
    for (const event of reasoning) {
      expect(journalSeqs.has(event.seq)).toBe(true);
    }
    // The fold is replay-stable: projecting twice gives identical rows.
    expect(projectToUxEvents(events)).toEqual(projected.map(parseThreadEvent));
  });

  test("typeList shows the canonical journal shape with thinking rows", async () => {
    const rig = await createRig({ turns: [{ thinkingDeltas: ["hmm"], deltas: ["done"] }] });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "cot-shape",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    expect(typeList(events)).toEqual([
      "thread.created",
      "turn.input",
      "model.call_started",
      "turn.phase",
      "model.thinking",
      "turn.phase",
      "model.delta",
      "model.call_completed",
      "turn.completed",
      "turn.phase",
      "turn.phase",
    ]);
  });
});