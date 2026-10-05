import { afterEach, describe, expect, test } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { parseThreadEvent } from "@cap/protocol";
import { createRig, resetRuntime, typeList } from "./helpers.js";
import { projectToUxEvents } from "../src/ux-projection.js";
import { blobRefSchema, type AnyAgentEvent } from "../src/fsm-events.js";

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
    });

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
    // One 150KB thinking delta exceeds the constructor-time r2BypassBytes
    // (default 100KB — configureWatchdog cannot retune the EventLog), so the
    // stored row carries a BlobRef in the SAME `text` field model.delta uses.
    // The fetch view resolves it transparently (§8.2: journal is authority).
    const rig = await createRig({
      turns: [{ thinkingDeltas: ["x".repeat(150 * 1024)], deltas: ["ok"] }],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "cot-blob",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    const events = await rig.waitTurnComplete(sent.turnId);

    // deltaFlushBytes (2KB) trips mid-stream: exactly one flushed row, and
    // the read-back carries the full 150KB reasoning prefix.
    const thinkingRows = events.filter((event) => event.type === "model.thinking");
    expect(thinkingRows).toHaveLength(1);
    const fetched = thinkingRows[0]?.data.text;
    if (typeof fetched !== "string") {
      expect.unreachable("fetch view must resolve the blob back to a string");
    }
    expect(fetched).toHaveLength(150 * 1024);

    // Stored face: the raw journal row keeps the BlobRef (64-hex sha256,
    // full payload size) — pattern from invariants.test.ts liveState.
    const raw = await runInDurableObject(rig.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ data: string }>(
          "SELECT data FROM events WHERE thread_id = ? AND type = 'model.thinking'",
          rig.threadId,
        )
        .toArray(),
    );
    expect(raw).toHaveLength(1);
    const parsedRow: unknown = JSON.parse(raw[0]?.data ?? "{}");
    const storedText =
      parsedRow !== null && typeof parsedRow === "object" && "text" in parsedRow
        ? parsedRow.text
        : undefined;
    const blobRef = blobRefSchema.parse(storedText);
    expect(blobRef.__blob__.size).toBe(150 * 1024);
    expect(blobRef.__blob__.sha256).toMatch(/^[0-9a-f]{64}$/);
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
    const inlineRows = thinkingRows.filter((event) => typeof event.data.text === "string");
    const projected = projectToUxEvents(events).map(parseThreadEvent);
    const reasoning = projected.filter(
      (event) => event.type === "item/reasoning/textDelta",
    );
    expect(reasoning.map((event) => event.seq)).toEqual(
      inlineRows.map((event) => event.seq),
    );
    for (const event of reasoning) {
      expect(event.data.turnId).toBe(sent.turnId);
      expect(event.data.itemId).toMatch(/^itm-rs-.*:\d+$/);
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
    // Flush discipline: the scripted "hmm" (3B) trips neither threshold, so
    // the thinking row flushes at the call boundary — after the answer delta
    // (first_token stays answer-bound), before call_completed.
    expect(typeList(events)).toEqual([
      "thread.created",
      "turn.input",
      "model.call_started",
      "turn.phase",
      "turn.phase",
      "model.delta",
      "model.thinking",
      "model.call_completed",
      "turn.completed",
      "turn.phase",
      "turn.phase",
    ]);
  });
});