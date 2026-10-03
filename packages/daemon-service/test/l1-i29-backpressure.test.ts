import { describe, expect, test } from "vitest";
import { SimulatedClient, uniqueHostId, journalOf, opsOfKind, dispatchViaSeam, executionViewOf } from "./helpers.js";

/**
 * I29 — backpressure honesty (§8.3): a windowed client pauses its uplink at
 * the high-water mark (no partial frames ever), resumes only as the service
 * acks, and the resulting journal offset story satisfies I26.
 */

const WINDOW_BYTES = 10;

describe("L1 I29 backpressure honesty", () => {
  test("a windowed client never emits partial frames and converges contiguously", async () => {
    const hostId = uniqueHostId("i29");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeSpawnFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "seq 1 100" }),
    );

    // Drive the uplink through a 10-byte window: send ≤WINDOW unacked bytes,
    // block until the service acks, then continue.
    const chunks = ["abcdefghij", "klmnopqrst", "uvwxyz"];
    let offset = 0;
    for (const chunk of chunks) {
      const ackedBefore = lastAcked(client, executionId);
      const inFlight = offset - ackedBefore;
      expect(inFlight).toBeLessThanOrEqual(WINDOW_BYTES);
      client.sendOutput(executionId, offset, chunk);
      offset += chunk.length;
      await client.waitForOutput(executionId, ackedBefore);
    }

    // Journal story: contiguous, no holes, whole frames only.
    const ops = await journalOf(hostId, executionId);
    const outputs = opsOfKind(ops, "output");
    let expected = 0;
    for (const output of outputs) {
      expect(output.offset).toBe(expected);
      expected += output.text.length;
    }
    expect(expected).toBe(offset);
    expect(opsOfKind(ops, "output_gap")).toHaveLength(0);

    const view = await executionViewOf(hostId, executionId);
    expect(view.lastOffset).toBe(offset);
    expect(view.ackedOffset).toBe(offset);
    await client.close();
  });
});

/** The client's ack watermark for its own windowing (simulated TCP state). */
function lastAcked(client: SimulatedClient, executionId: string): number {
  const acks = client
    .framesOfType("exec.output_ack")
    .filter((frame) => frame.executionId === executionId)
    .map((frame) => frame.ackedOffset);
  return acks.length === 0 ? 0 : Math.max(...acks);
}
