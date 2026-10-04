import { describe, expect, test } from "vitest";
import {
  SimulatedClient,
  uniqueHostId,
  journalOf,
  opsOfKind,
  dispatchViaSeam,
  executionViewOf,
  sinkStub,
} from "./helpers.js";
import type { ObservedExecution } from "../src/protocol.js";

/**
 * I23 — announce full reset (§8.2): every session/open's first announce
 * replaces the service's observed view; generation is monotonic; stale or
 * duplicate announces have zero side effects.
 */

describe("L1 I23 announce full reset", () => {
  test("a fresh session resets the observed view; stale generation rejected with zero journal delta", async () => {
    const hostId = uniqueHostId("i23");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;

    // Session 1: run one execution to completion so a phantom observed view
    // has something to be wrong about.
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeToolExecFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "echo i23" }),
    );
    client.sendOutput(executionId, 0, "i23\n");
    client.sendExited(executionId, 0, 4);
    await client.close();

    // Session 2: announce an OBSERVED view containing a fake running entry —
    // the reset means the service's judgment uses exactly this snapshot.
    const client2 = new SimulatedClient(hostId);
    const phantom: ObservedExecution = {
      executionId: "phantom:99",
      threadId: "thr_phantom",
      pid: 1234,
      pidStartedAt: 99,
      state: "running",
      bufferedFromOffset: 0,
    };
    await client2.dial({ observed: [phantom] });

    // The phantom entry is unknown to the journal → I24-style unauthorized →
    // kill-listed; it is NOT silently adopted as a tracked RUNNING record.
    const killList = await client2.waitForKillList();
    expect(killList.entries.map((entry) => entry.executionId)).toEqual(["phantom:99"]);
    const view = await executionViewOf(hostId, "phantom:99");
    expect(view.state).toBe("ABSENT");

    // Stale generation on the SAME session: re-sending the accepted
    // generation (1, not > 1) is rejected with the error frame and zero new
    // journal ops. (Generation 0 would fail frame validation outright.)
    const opsBefore = (await journalOf(hostId)).length;
    client2.generation = 0;
    client2.bootId = `boot_${crypto.randomUUID().slice(0, 8)}`;
    client2.send({
      type: "boot.announce",
      bootId: client2.bootId,
      protocolVersion: 1,
      capabilities: { platform: "linux", sandboxRoot: "/tmp/poc-sandbox", protocolVersion: 1 },
      generation: 1,
      observed: [],
    });
    await client2.waitFor((frame) => frame.type === "error");
    expect((await journalOf(hostId)).length).toBe(opsBefore);
    expect(
      opsOfKind(await journalOf(hostId), "reconcile_action").filter(
        (op) => op.executionId === "phantom:99" && op.action === "resume",
      ),
    ).toHaveLength(0);
    await client2.close();
  });

  test("duplicate announce (same generation) has zero side effects beyond the rejection", async () => {
    const hostId = uniqueHostId("i23dup");
    const client = new SimulatedClient(hostId);
    await client.dial();
    const opsAfterFirst = (await journalOf(hostId)).length;

    // Same-generation re-announce → rejected by the monotonic guard.
    client.generation -= 1; // resend "generation 1" again
    client.send({
      type: "boot.announce",
      bootId: client.bootId,
      protocolVersion: 1,
      capabilities: { platform: "linux", sandboxRoot: "/tmp/poc-sandbox", protocolVersion: 1 },
      generation: 1,
      observed: [],
    });
    const error = await client.waitFor((frame) => frame.type === "error");
    expect(error.code).toBe("stale_generation");
    expect((await journalOf(hostId)).length).toBe(opsAfterFirst);
    await client.close();
  });

  test("deliveries keep flowing to the agent sink across session resets", async () => {
    const hostId = uniqueHostId("i23sink");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeToolExecFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "echo x" }),
    );
    await client.close();

    // Second session, SAME bootId (mere disconnection): the still-RUNNING
    // execution resumes per the tree (§8.5 same-branch).
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
    await client2.waitForResume(executionId);
    client2.sendExited(executionId, 0, 0);
    await expect
      .poll(
        async () => (await sinkStub(threadId).updates()).some((update) => update.kind === "exited"),
        {
          timeout: 5000,
          interval: 50,
        },
      )
      .toBe(true);
    await client2.close();
  });
});
