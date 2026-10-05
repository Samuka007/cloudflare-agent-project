import { expect, test } from "vitest";
import { createRig, resetRuntime } from "./helpers.js";

/**
 * Minimal probe (workerd, no imports from src/): journal shape of a
 * thinking-scripted turn with a flushed prefix. Answers two questions:
 * (a) does a mid-stream thinking flush land before the terminal,
 * (b) does the oversize path blob-offload model.thinking rows.
 */
test("probe: thinking flush ordering + blob shape", { timeout: 30_000 }, async () => {
  const bigPrefix = ["a".repeat(4096), "b".repeat(4096)];
  const rig = await createRig({
    turns: [{ thinkingDeltas: bigPrefix, deltas: ["ok"] }],
    watchdog: { deltaFlushBytes: 4096, deltaFlushMs: 1, r2BypassBytes: 2048 },
  });
  const sent = await rig.stub.sendMessage({
    clientRequestId: "probe-1",
    content: [{ type: "text", text: "hi" }],
    mode: "auto",
  });
  const events = await rig.waitTurnComplete(sent.turnId);
  const dump = events.map((event) => {
    if (event.type !== "model.thinking") return { seq: event.seq, type: event.type };
    const text = (event.data as { text: unknown }).text;
    return {
      seq: event.seq,
      type: event.type,
      textK: typeof text,
      len: typeof text === "string" ? text.length : (text as { __blob__: { size: number } }).__blob__.size,
    };
  });
  console.log("PROBE-DUMP", JSON.stringify(dump));
  await rig.stub.configureWatchdog({ deltaFlushBytes: 4096 });
  resetRuntime();
  expect(true).toBe(true);
});