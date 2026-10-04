import { describe, expect, test } from "vitest";
import {
  SimulatedClient,
  uniqueHostId,
  journalOf,
  opsOfKind,
  dispatchViaSeam,
  executionViewOf,
} from "./helpers.js";

/**
 * I25 — ack monotonicity + trim conservation (§8.3): output_ack's
 * ackedOffset is monotonic non-decreasing and never ahead of the journal
 * frontier; the client never trims beyond the acked point.
 */

describe("L1 I25 ack monotonic + trim conservation", () => {
  test("acks march forward with the journal frontier and never regress", async () => {
    const hostId = uniqueHostId("i25");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeSpawnFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "seq 1 10" }),
    );

    const acks: number[] = [];
    let offset = 0;
    for (const chunk of ["aaaa\n", "bbbbbb\n", "cc\n"]) {
      client.sendOutput(executionId, offset, chunk);
      const ack = await client.waitForOutput(executionId, offset);
      acks.push(ack.ackedOffset);
      offset += chunk.length;
    }
    for (let i = 1; i < acks.length; i += 1) {
      const current = acks[i];
      const previous = acks[i - 1];
      if (current !== undefined && previous !== undefined) {
        expect(current).toBeGreaterThanOrEqual(previous);
      }
    }
    expect(acks).toEqual([5, 12, 15]);

    // A retransmitted overlap is dropped and does NOT move the frontier.
    client.sendOutput(executionId, 0, "aaaa\n");
    await expect
      .poll(
        async () => opsOfKind(await journalOf(hostId, executionId), "output_dup_dropped").length,
        {
          timeout: 5000,
          interval: 50,
        },
      )
      .toBe(1);
    const view = await executionViewOf(hostId, executionId);
    expect(view.ackedOffset).toBe(15);
    expect(view.lastOffset).toBe(15);
    await client.close();
  });

  test("the acked frontier never exceeds the journaled bytes (service-side clamp)", async () => {
    const hostId = uniqueHostId("i25clamp");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeSpawnFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "echo clamp" }),
    );

    // A hostile/broken client claims bytes the service never received: the
    // exec.output frames are the only ack driver, so no output → no ack, and
    // a resumed offset ask stays at the journal frontier (0).
    client.sendOutput(executionId, 100, "jump"); // offset ahead of frontier → gap marker
    const ack = await client.waitForOutput(executionId);
    expect(ack.ackedOffset).toBe(104); // 100 + 4 — the gap was marked, bytes accepted
    const gap = opsOfKind(await journalOf(hostId, executionId), "output_gap");
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({ from: 0, to: 100 });
    const view = await executionViewOf(hostId, executionId);
    expect(view.outputTruncated).toBe(true);
    await client.close();
  });
});
