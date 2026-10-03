import { describe, expect, test } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import {
  SimulatedClient,
  uniqueHostId,
  serviceStub,
  journalOf,
  opsOfKind,
  dispatchViaSeam,
  executionViewOf,
} from "./helpers.js";

/**
 * Lease lapse + grace (§5.2.1) and the same-boot heal (§6.2): a lapsed lease
 * marks the boot's RUNNING set orphan_suspect — no kills, no outcome changes;
 * the judgment tree resolves when the client returns. Also covers the
 * spawn-ack watchdog shape (§5.1 COMMAND_TIMEOUT).
 */

describe("L1 lease lapse and orphan_suspect", () => {
  test("lease expiry past grace marks orphan_suspect without killing or concluding", async () => {
    const hostId = uniqueHostId("lease");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeSpawnFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "sleep 60" }),
    );
    await client.close();

    // Force the lease deadline past its grace, then run the alarm now (the
    // official deterministic-alarm entry; wall-clock waiting is not used).
    await serviceStub(hostId).debugForceLeaseExpiry();
    await runDurableObjectAlarm(serviceStub(hostId));

    const ops = await journalOf(hostId, executionId);
    expect(opsOfKind(ops, "orphan_suspect")).toHaveLength(1);
    const view = await executionViewOf(hostId, executionId);
    expect(view.orphanSuspect).toBe(true);
    // No conclusion was drawn — the tree owns that decision on reconnect.
    expect(view.state).toBe("RUNNING");
    expect(opsOfKind(ops, "outcome_unknown")).toHaveLength(0);
  });

  test("same-boot reconnect after orphan_suspect clears it and resumes", async () => {
    const hostId = uniqueHostId("heal");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeSpawnFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "sleep 60" }),
    );
    client.sendOutput(executionId, 0, "buffered");
    await client.waitForOutput(executionId);
    await client.close();

    await serviceStub(hostId).debugForceLeaseExpiry();
    await runDurableObjectAlarm(serviceStub(hostId));
    expect((await executionViewOf(hostId, executionId)).orphanSuspect).toBe(true);

    // Same boot returns; §6.2: suspicion lifted, resume from the frontier.
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
          bufferedFromOffset: 0,
        },
      ],
    });
    const resume = await client2.waitForResume(executionId);
    expect(resume.ackedOffset).toBe(8); // "buffered" is 8 bytes
    const view = await executionViewOf(hostId, executionId);
    expect(view.orphanSuspect).toBe(false);
    expect(view.state).toBe("RUNNING");
    await client2.close();
  });
});

