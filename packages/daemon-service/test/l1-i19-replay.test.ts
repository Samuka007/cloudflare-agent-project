import { describe, expect, test } from "vitest";
import { evictDurableObject } from "cloudflare:test";
import {
  SimulatedClient,
  uniqueHostId,
  serviceStub,
  journalOf,
  dispatchViaSeam,
  executionViewOf,
} from "./helpers.js";

/**
 * I19 (service-DO half) — replay determinism (§3.3/C, model two): after a
 * hard kill, the cold-start replay of the journal rebuilds the identical
 * RUNNING set and byte frontiers. This is the recovery backbone that makes
 * the service DO the claim authority.
 */

describe("L1 I19 journal replay determinism", () => {
  test("hard kill + cold start rebuilds RUNNING set, offsets, and boot ownership", async () => {
    const hostId = uniqueHostId("i19");
    const threadId = `thr_${hostId}`;
    const runningId = `${threadId}:1`;
    const doneId = `${threadId}:2`;
    const client = new SimulatedClient(hostId);
    await client.dial();

    const ack = await client.acknowledgeSpawnFor(
      runningId,
      dispatchViaSeam(hostId, {
        threadId,
        executionId: runningId,
        machineId: hostId,
        command: "sleep 60",
      }),
    );
    client.sendOutput(runningId, 0, "partial");
    await client.waitForOutput(runningId);

    const doneDispatch = dispatchViaSeam(hostId, {
      threadId,
      executionId: doneId,
      machineId: hostId,
      command: "echo done",
    });
    const doneSpawn = await client.waitForSpawn(doneId);
    client.send({
      type: "exec.started",
      requestId: doneSpawn.requestId,
      threadId,
      executionId: doneId,
      pid: 777,
      pidStartedAt: 7770,
    });
    await doneDispatch;
    client.sendExited(doneId, 0, 0);

    const beforeRunning = await executionViewOf(hostId, runningId);
    const beforeDone = await executionViewOf(hostId, doneId);
    const beforeOps = await journalOf(hostId);
    expect(beforeRunning.state).toBe("RUNNING");
    expect(beforeDone.state).toBe("COMPLETED");

    // Hard memory loss on THIS DO only: eviction clears the heap, keeps
    // SQLite (deterministic official eviction — abortAllDurableObjects
    // poisons the whole shared test worker and is not used here).
    await evictDurableObject(serviceStub(hostId), { webSockets: "close" });

    const afterRunning = await serviceStub(hostId).executionView(runningId);
    const afterDone = await serviceStub(hostId).executionView(doneId);
    const afterOps = await journalOf(hostId);
    expect(afterOps.map((op) => op.kind)).toEqual(beforeOps.map((op) => op.kind));
    expect(afterRunning).toMatchObject({
      state: "RUNNING",
      lastOffset: beforeRunning.lastOffset,
      ackedOffset: beforeRunning.ackedOffset,
      bootId: beforeRunning.bootId,
      pid: ack.pid,
    });
    expect(afterDone).toMatchObject({
      state: "COMPLETED",
      lastOffset: beforeDone.lastOffset,
      result: beforeDone.result,
    });
    await client.close();
  });
});
