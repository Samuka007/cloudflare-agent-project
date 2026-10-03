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
 * I24 — authorization list is unique (§8.5 new-boot branch): the service DO
 * journal is the ONLY authorization list. A marker process the journal does
 * not know is unauthorized — it joins the kill-list and the journal grows no
 * RUNNING record for it.
 */

describe("L1 I24 journal is the sole authorization list", () => {
  test("an observed-only marker orphan is kill-listed without a journal record", async () => {
    const hostId = uniqueHostId("i24");
    const threadId = `thr_${hostId}`;
    const authorizedId = `${threadId}:1`;
    const ghostId = "ghost:1";

    // Boot 1: authorize + spawn one execution, keep it RUNNING, disconnect.
    const client = new SimulatedClient(hostId);
    await client.dial();
    const ack = await client.acknowledgeSpawnFor(
      authorizedId,
      dispatchViaSeam(hostId, { threadId, executionId: authorizedId, machineId: hostId, command: "sleep 60" }),
    );
    await client.close();

    // Boot 2 (restart): the /proc marker scan reports BOTH the authorized
    // orphan and a ghost process the journal never authorized.
    const client2 = new SimulatedClient(hostId);
    const observed: ObservedExecution[] = [
      {
        executionId: authorizedId,
        threadId,
        pid: ack.pid,
        pidStartedAt: ack.pidStartedAt,
        state: "running",
        bufferedFromOffset: 0,
      },
      {
        executionId: ghostId,
        threadId: "thr_ghost",
        pid: ack.pid + 1,
        pidStartedAt: ack.pidStartedAt + 1,
        state: "running",
        bufferedFromOffset: 0,
      },
    ];
    await client2.dial({ observed });

    const killList = await client2.waitForKillList();
    const listed = killList.entries.map((entry) => entry.executionId).sort();
    expect(listed).toEqual([authorizedId, ghostId].sort());

    // Both entries carry pid + start time for client-side verification (I22).
    for (const entry of killList.entries) {
      expect(entry.pidStartedAt).toBeGreaterThan(0);
    }

    // The journal authorized exactly one of them: the ghost has NO record.
    const ghostView = await executionViewOf(hostId, ghostId);
    expect(ghostView.state).toBe("ABSENT");
    const ghostOps = await journalOf(hostId, ghostId);
    expect(opsOfKind(ghostOps, "outcome_unknown")).toHaveLength(0);
    // …but the kill decision is journaled for audit.
    expect(opsOfKind(ghostOps, "reconcile_action").map((op) => op.action)).toEqual(["kill_list"]);

    // The authorized orphan is judged UNKNOWN and reported to the agent.
    const view = await executionViewOf(hostId, authorizedId);
    expect(view.state).toBe("UNKNOWN");
    await expect
      .poll(async () => (await sinkStub(threadId).updates()).some((update) => update.kind === "exited"), {
        timeout: 5000,
        interval: 50,
      })
      .toBe(true);
    await client2.close();
  });
});
