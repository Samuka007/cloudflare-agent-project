import { describe, expect, test } from "vitest";
import {
  SimulatedClient,
  uniqueHostId,
  serviceStub,
  journalOf,
  opsOfKind,
  dispatchViaSeam,
} from "./helpers.js";

/**
 * I30 — syncing gate (§8.2/§8.5): between WS attach and reconcile completion
 * the session is `syncing` and no exec.spawn may be forwarded. The gate is
 * proven structurally: the journal records the spawn AFTER the reconcile's
 * clean marker, and the wire shows sync.complete before exec.spawn. A
 * pre-reconcile spawn would carry a lower op_seq — the log is the order
 * record, so no wall-clock race probing is needed.
 */

describe("L1 I30 syncing gate", () => {
  test("dispatch during syncing defers the spawn until after reconcile", async () => {
    const hostId = uniqueHostId("i30");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;

    // Attach WITHOUT the announce: the session is syncing (§8.2).
    const client = new SimulatedClient(hostId);
    await client.dial({ skipAnnounce: true });
    const view = await serviceStub(hostId).sessionView();
    expect(view?.syncing).toBe(true);

    const dispatchPromise = dispatchViaSeam(hostId, {
      threadId,
      executionId,
      machineId: hostId,
      command: "echo gated",
    });

    // Announce → reconcile → gate releases → spawn flows.
    await client.announce([]);
    const spawn = await client.waitForSpawn(executionId);
    expect(spawn.command).toBe("echo gated");
    await client.acknowledgeSpawn(executionId);
    await expect(dispatchPromise).resolves.toEqual({ kind: "accepted" });

    // Journal order proves the gate: the spawn follows the clean marker.
    const ops = await journalOf(hostId);
    const clean = opsOfKind(ops, "reconcile_action").at(-1);
    const forwarded = opsOfKind(ops, "spawn_forwarded");
    expect(forwarded).toHaveLength(1);
    expect(clean?.action).toBe("clean");
    expect(forwarded[0]?.opSeq).toBeGreaterThan(clean?.opSeq ?? 0);

    // Frame order on the wire: sync.complete precedes exec.spawn.
    const types = client.inbound.map((frame) => frame.type);
    expect(types.indexOf("sync.complete")).toBeLessThan(types.indexOf("exec.spawn"));
    await client.close();
  });
});
