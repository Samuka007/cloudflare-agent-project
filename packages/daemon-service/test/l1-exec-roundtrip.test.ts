import { describe, expect, test } from "vitest";
import {
  SimulatedClient,
  uniqueHostId,
  journalOf,
  opsOfKind,
  dispatchViaSeam,
  executionViewOf,
  sinkStub,
  serviceStub,
} from "./helpers.js";

/**
 * Exec roundtrip over the real WS path (§6.1 normal sequence, service half):
 * journal-first ordering, offset acks, result assembly, agent-sink delivery,
 * execution dedup at the journal (§3.5/E — the service-side half of I16),
 * tombstone + forget closure (§8.4), business cancel (§2.4).
 */

describe("L1 exec roundtrip", () => {
  test("dispatch → spawn → output → exited lands in journal + agent sink, then tombstone + forget", async () => {
    const hostId = uniqueHostId("rt");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();

    const outcome = dispatchViaSeam(hostId, {
      threadId,
      executionId,
      machineId: hostId,
      command: "echo poc",
    });

    const spawn = await client.waitForSpawn(executionId);
    expect(spawn.command).toBe("echo poc");
    expect(spawn.threadId).toBe(threadId);
    await client.acknowledgeSpawn(executionId);
    await expect(outcome).resolves.toEqual({ kind: "accepted" });

    client.sendOutput(executionId, 0, "poc-output\n");
    const ack = await client.waitForOutput(executionId);
    expect(ack.ackedOffset).toBe(11);

    client.sendExited(executionId, 0, 11);

    const sink = sinkStub(threadId);
    await expect
      .poll(
        async () => (await sink.updates()).filter((update) => update.kind === "exited").length,
        {
          timeout: 5000,
          interval: 50,
        },
      )
      .toBe(1);
    const exited = (await sink.updates()).find((update) => update.kind === "exited");
    expect(exited).toMatchObject({
      kind: "exited",
      executionId,
      result: { status: "ok", exitCode: 0, output: "poc-output\n" },
    });

    // Journal order: dispatch → spawn_forwarded → spawn_ack → output → exited.
    const ops = await journalOf(hostId, executionId);
    expect(ops.map((op) => op.kind)).toEqual([
      "dispatch",
      "spawn_forwarded",
      "spawn_ack",
      "output",
      "output_ack",
      "exited",
    ]);

    // Ack closes the loop: tombstone + forget frame (§8.4).
    await serviceStub(hostId).ackExecution(executionId, 42);
    const view = await executionViewOf(hostId, executionId);
    expect(view.state).toBe("TOMBSTONE");
    expect(view.result).toBeNull();
    await client.waitFor((frame) => frame.type === "exec.forget");

    // §3.5/E: re-dispatch after completion is answered from the journal —
    // no second spawn_forwarded, cached result returned.
    const again = await dispatchViaSeam(hostId, {
      threadId,
      executionId,
      machineId: hostId,
      command: "echo poc",
    });
    expect(again.kind).toBe("completed_cached");
    const opsAfter = opsOfKind(await journalOf(hostId), "spawn_forwarded").filter(
      (op) => op.executionId === executionId,
    );
    expect(opsAfter).toHaveLength(1);
    await client.close();
  });

  test("kill journeys to the client and the exit is cancelled (§2.4)", async () => {
    const hostId = uniqueHostId("kill");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    await client.acknowledgeSpawnFor(
      executionId,
      dispatchViaSeam(hostId, { threadId, executionId, machineId: hostId, command: "sleep 60" }),
    );

    await serviceStub(hostId).kill(executionId);
    await client.waitFor((frame) => frame.type === "exec.kill");
    client.sendExited(executionId, null, 0);

    await expect
      .poll(
        async () =>
          (await sinkStub(threadId).updates()).find(
            (update) => update.kind === "exited" && update.executionId === executionId,
          ),
        { timeout: 5000, interval: 50 },
      )
      .toMatchObject({ result: { status: "cancelled" } });
    await client.close();
  });

  test("dispatch with no live client session is host_offline (§5.1, never a hang)", async () => {
    const hostId = uniqueHostId("offline");
    const threadId = `thr_${hostId}`;
    const outcome = await dispatchViaSeam(hostId, {
      threadId,
      executionId: `${threadId}:1`,
      machineId: hostId,
      command: "echo x",
    });
    expect(outcome).toEqual({ kind: "host_offline" });
  });

  test("client-refused spawn is journaled spawn_failed and reports host_offline", async () => {
    const hostId = uniqueHostId("refuse");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    const refused = dispatchViaSeam(hostId, {
      threadId,
      executionId,
      machineId: hostId,
      command: "cd /etc && rm -rf /", // cwd outside sandbox → refused below
    });
    await client.waitForSpawn(executionId);
    await client.refuseSpawn(executionId, "sandbox escape refused");
    await expect(refused).resolves.toEqual({ kind: "host_offline" });
    const failed = opsOfKind(await journalOf(hostId, executionId), "spawn_failed");
    expect(failed).toHaveLength(1);
    await client.close();
  });
});
