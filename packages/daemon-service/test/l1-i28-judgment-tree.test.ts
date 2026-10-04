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
 * I28 — judgment-tree completeness (§8.5): each (boot continuity × process
 * fate) combination maps to EXACTLY ONE action — resume, ended backfill,
 * kill-list+UNKNOWN, direct UNKNOWN, or clean — never none, never two.
 */

function runningObserved(
  executionId: string,
  threadId: string,
  pid: number,
  startedAt: number,
): ObservedExecution {
  return {
    executionId,
    threadId,
    pid,
    pidStartedAt: startedAt,
    state: "running",
    bufferedFromOffset: 0,
  };
}

function endedObserved(
  executionId: string,
  threadId: string,
  finalOffset: number,
  exitCode: number,
): ObservedExecution {
  return {
    executionId,
    threadId,
    pid: 0,
    pidStartedAt: 0,
    state: "ended",
    bufferedFromOffset: 0,
    finalOffset,
    exitCode,
  };
}

describe("L1 I28 judgment tree", () => {
  test("same boot + process running → resume, exactly one action", async () => {
    const hostId = uniqueHostId("i28a");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeToolExecFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "sleep 60" }),
    );
    await client.close();

    const client2 = new SimulatedClient(hostId);
    await client2.dial({
      bootId: client.bootId,
      observed: [runningObserved(executionId, threadId, 201, 2010)],
    });
    await client2.waitForResume(executionId);

    const actions = opsOfKind(await journalOf(hostId, executionId), "reconcile_action");
    expect(actions.map((op) => op.action)).toEqual(["resume"]);
    expect((await executionViewOf(hostId, executionId)).state).toBe("RUNNING");
    await client2.close();
  });

  test("same boot + process ended with full stream → backfill closes from the announce", async () => {
    const hostId = uniqueHostId("i28b");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeToolExecFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "echo done" }),
    );
    client.sendOutput(executionId, 0, "done\n");
    await client.waitForOutput(executionId);
    await client.close();

    // Reconnect announcing the process ENDED with the full stream + exit.
    const client2 = new SimulatedClient(hostId);
    await client2.dial({
      bootId: client.bootId,
      observed: [endedObserved(executionId, threadId, 5, 0)],
    });
    await client2.waitFor((frame) => frame.type === "sync.complete");

    const actions = opsOfKind(await journalOf(hostId, executionId), "reconcile_action");
    expect(actions.map((op) => op.action)).toEqual(["backfill"]);
    const view = await executionViewOf(hostId, executionId);
    expect(view.state).toBe("COMPLETED");
    expect(view.result).toMatchObject({ status: "ok", exitCode: 0, output: "done\n" });
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

  test("new boot + process alive in /proc → kill-list + UNKNOWN, exactly one action", async () => {
    const hostId = uniqueHostId("i28c");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeToolExecFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "sleep 60" }),
    );
    await client.close();

    const client2 = new SimulatedClient(hostId); // fresh bootId
    await client2.dial({
      observed: [runningObserved(executionId, threadId, 301, 3010)],
    });
    const killList = await client2.waitForKillList();
    expect(killList.entries).toHaveLength(1);
    expect(killList.entries[0]).toMatchObject({
      executionId,
      pid: 301,
      pidStartedAt: 3010,
    });

    const actions = opsOfKind(await journalOf(hostId, executionId), "reconcile_action");
    expect(actions.map((op) => op.action)).toEqual(["kill_list"]);
    expect((await executionViewOf(hostId, executionId)).state).toBe("UNKNOWN");
    await expect
      .poll(
        async () =>
          (await sinkStub(threadId).updates()).find(
            (update) => update.kind === "exited" && update.executionId === executionId,
          ),
        { timeout: 5000, interval: 50 },
      )
      .toMatchObject({ result: { status: "outcome_unknown" } });
    await client2.close();
  });

  test("new boot + process gone → direct UNKNOWN, no kill frame", async () => {
    const hostId = uniqueHostId("i28d");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeToolExecFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "sleep 60" }),
    );
    await client.close();

    const client2 = new SimulatedClient(hostId);
    await client2.dial({ observed: [] }); // restart lost the process
    await client2.waitFor((frame) => frame.type === "sync.complete");

    const actions = opsOfKind(await journalOf(hostId, executionId), "reconcile_action");
    expect(actions.map((op) => op.action)).toEqual(["outcome_unknown_direct"]);
    expect((await executionViewOf(hostId, executionId)).state).toBe("UNKNOWN");
    expect(client2.framesOfType("kill.list")).toHaveLength(0);
    await expect
      .poll(
        async () =>
          (await sinkStub(threadId).updates()).find(
            (update) => update.kind === "exited" && update.executionId === executionId,
          ),
        { timeout: 5000, interval: 50 },
      )
      .toMatchObject({ result: { status: "outcome_unknown" } });
    await client2.close();
  });

  test("no in-flight work → clean session action, nothing sent", async () => {
    const hostId = uniqueHostId("i28e");
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.close();

    const client2 = new SimulatedClient(hostId);
    await client2.dial();
    await client2.waitFor((frame) => frame.type === "sync.complete");

    const actions = opsOfKind(await journalOf(hostId), "reconcile_action");
    // One clean per session establishment; nothing else ever ran on this DO.
    expect(actions.map((op) => op.action)).toEqual(["clean", "clean"]);
    expect(client2.framesOfType("kill.list")).toHaveLength(0);
    expect(client2.framesOfType("exec.resume")).toHaveLength(0);
    await client2.close();
  });
});
