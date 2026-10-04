import { describe, expect, test } from "vitest";
import {
  SimulatedClient,
  uniqueHostId,
  serviceStub,
  journalOf,
  dispatchViaSeam,
  sinkStub,
} from "./helpers.js";

/**
 * I27 — forget closure (§8.4): the client drops a buffer only on
 * exec.forget; a lost forget is healed by the ended re-report on the next
 * announce (service re-sends forget, zero journal delta).
 */

describe("L1 I27 forget closure", () => {
  test("a lost forget is re-sent after the ended re-report, with zero journal delta", async () => {
    const hostId = uniqueHostId("i27");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeToolExecFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "echo i27" }),
    );
    client.sendOutput(executionId, 0, "i27-done\n");
    client.sendExited(executionId, 0, 9);
    // Round 1 never acks, so no forget is owed yet — the buffer holds.
    await expect
      .poll(
        async () => (await sinkStub(threadId).updates()).some((update) => update.kind === "exited"),
        {
          timeout: 5000,
          interval: 50,
        },
      )
      .toBe(true);

    // Simulate "forget lost": the socket dies BEFORE the agent's ack lands —
    // the tombstone + forget fire into a dead socket. The client's simulated
    // buffer still holds the result (no forget received).
    await client.close();
    const stubOps = await journalOf(hostId, executionId);

    // Ack after the disconnect (the agent DO acks whenever it finishes —
    // connectivity to the client is irrelevant to the claim/ack closure).
    await serviceStub(hostId).ackExecution(executionId, 42);
    const opsAfterAck = await journalOf(hostId, executionId);
    expect(opsAfterAck.map((op) => op.kind)).toEqual([
      ...stubOps.map((op) => op.kind),
      "ack",
      "tombstone",
    ]);

    // Client reconnects (same boot) and re-reports the buffer as ended — the
    // §8.2 disconnect-window backfill channel. The service must re-send the
    // forget WITHOUT any new journal ops for the execution.
    const client2 = new SimulatedClient(hostId);
    await client2.dial({
      bootId: client.bootId,
      observed: [
        {
          executionId,
          threadId,
          pid: 0,
          pidStartedAt: 0,
          state: "ended",
          bufferedFromOffset: 0,
          finalOffset: 9,
          exitCode: 0,
        },
      ],
    });
    await client2.waitFor((frame) => frame.type === "exec.forget");
    const opsAfterReReport = await journalOf(hostId, executionId);
    expect(opsAfterReReport.map((op) => op.kind)).toEqual(opsAfterAck.map((op) => op.kind));

    // Exactly one result reached the agent (no double delivery from the
    // re-report path).
    const exitedCount = (await sinkStub(threadId).updates()).filter(
      (update) => update.kind === "exited" && update.executionId === executionId,
    ).length;
    expect(exitedCount).toBe(1);
    await client2.close();
  });
});
