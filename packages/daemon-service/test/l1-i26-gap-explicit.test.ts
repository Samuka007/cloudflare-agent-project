import { describe, expect, test } from "vitest";
import { SimulatedClient, uniqueHostId, journalOf, opsOfKind, dispatchViaSeam, executionViewOf } from "./helpers.js";

/**
 * I26 — gaps are explicit (§8.3): after a resume with an evicted ring tail,
 * the journal's offset story is contiguous, or every hole carries exactly
 * one output_truncated marker. No silent holes.
 */

describe("L1 I26 explicit gaps on resume", () => {
  test("same-boot resume with an evicted tail marks the hole, then continues contiguously", async () => {
    const hostId = uniqueHostId("i26");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeSpawnFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "head -c 1000 /dev/zero" }),
    );

    // Client produced 0..10, service journaled it.
    client.sendOutput(executionId, 0, "0123456789");
    await client.waitForOutput(executionId);
    await client.close();

    // Client "lost" bytes 10..20 (ring eviction) while disconnected, still
    // holds 20..30. Same boot reconnect.
    const client2 = new SimulatedClient(hostId);
    await client2.dial({
      bootId: client.bootId,
      observed: [
        {
          executionId,
          threadId,
          pid: 1,
          pidStartedAt: 1,
          state: "running",
          bufferedFromOffset: 20,
        },
      ],
    });
    const resume = await client2.waitForResume(executionId);
    expect(resume.ackedOffset).toBe(10);

    // §8.3: the client declares the hole FIRST, then resumes at 20.
    client2.sendGap(executionId, 10, 20);
    client2.sendOutput(executionId, 20, "0123456789");
    const ack = await client2.waitForOutput(executionId);
    expect(ack.ackedOffset).toBe(30);

    // I26: the journal's byte story is contiguous-or-marked. Reconstruct:
    // outputs cover [0,10) and [20,30); the single gap marker covers [10,20).
    const ops = await journalOf(hostId, executionId);
    const outputs = opsOfKind(ops, "output");
    const gaps = opsOfKind(ops, "output_gap");
    expect(outputs.map((op) => [op.offset, op.offset + op.text.length])).toEqual([
      [0, 10],
      [20, 30],
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from: 10, to: 20 });

    const view = await executionViewOf(hostId, executionId);
    expect(view.outputTruncated).toBe(true);
    expect(view.lastOffset).toBe(30);
    await client2.close();
  });

  test("an exit ahead of the byte frontier is marked, never silent", async () => {
    const hostId = uniqueHostId("i26exit");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeSpawnFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "echo exit-gap" }),
    );

    // Exit claims finalOffset 50 but only 4 bytes ever landed.
    client.sendOutput(executionId, 0, "abcd");
    await client.waitForOutput(executionId);
    client.sendExited(executionId, 0, 50);

    const ops = await journalOf(hostId, executionId);
    const gaps = opsOfKind(ops, "output_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from: 4, to: 50 });
    const view = await executionViewOf(hostId, executionId);
    expect(view.state).toBe("COMPLETED");
    expect(view.outputTruncated).toBe(true);
    await client.close();
  });
});
