import { describe, expect, test } from "vitest";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import type { ToolExecServiceFrame } from "../src/protocol.js";
import {
  SimulatedClient,
  dispatchViaSeam,
  journalOf,
  opsOfKind,
  serviceStub,
  uniqueHostId,
} from "./helpers.js";

/**
 * L1 workspace relay (#290 C1) — the service DO's half of the frame
 * workspace leg: forward carries the ref verbatim, the journal holds it as
 * the replay truth, the spawn-watchdog re-forward rebuilds the identical
 * frame (§0 rule 2), and the journal payload survives a hard eviction.
 * The client-side placement semantics live in the Bun l1-workspace
 * semantics suite (real omp runtime — Bun-only, excluded from this run).
 */

const WS = { id: "ws-relay-a", path: "/tmp/cap-ws-relay-a" };

describe("L1 workspace frame relay (#290)", () => {
  test("tool.exec forward carries the workspace ref and the journal records it", async () => {
    const hostId = uniqueHostId("wsrelay");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();

    const frame = await client.acknowledgeToolExecFor(
      executionId,
      dispatchViaSeam(hostId, {
        threadId,
        executionId,
        machineId: hostId,
        command: "echo hi",
        workspace: WS,
      }),
    );
    expect(frame.workspace).toEqual(WS);

    const dispatch = opsOfKind(await journalOf(hostId, executionId), "dispatch");
    expect(dispatch).toHaveLength(1);
    expect(JSON.parse(dispatch[0]?.workspaceJson ?? "null")).toEqual(WS);
    await client.close();
  });

  test("no workspace keeps the sandbox default: frame and journal stay null", async () => {
    const hostId = uniqueHostId("wsrelaydef");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();

    const frame = await client.acknowledgeToolExecFor(
      executionId,
      dispatchViaSeam(hostId, {
        threadId,
        executionId,
        machineId: hostId,
        command: "echo hi",
      }),
    );
    expect(frame.workspace).toBeUndefined();

    const dispatch = opsOfKind(await journalOf(hostId, executionId), "dispatch");
    expect(dispatch[0]?.workspaceJson).toBe("null");
    await client.close();
  });

  test("spawn-watchdog re-forward rebuilds the workspace leg from the journal", async () => {
    const hostId = uniqueHostId("wsreitr");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();

    // The dispatch RPC does not settle until the client acks — never ack:
    // the frame stays un-acked and the watchdog owns the re-forward.
    const dispatch = dispatchViaSeam(hostId, {
      threadId,
      executionId,
      machineId: hostId,
      command: "echo hi",
      workspace: WS,
    });
    const first = await client.waitForToolExec(executionId);

    // Official deterministic-alarm entry (l1-lease-orphan drill): the alarm
    // re-forwards every RUNNING row whose spawn was never acked.
    await runDurableObjectAlarm(serviceStub(hostId));

    // The re-forward carries a fresh requestId — the deterministic signal
    // distinguishing it from the first forward in the inbound queue.
    const reForward = await client.waitFor(
      (candidate): candidate is ToolExecServiceFrame =>
        candidate.type === "tool.exec" &&
        candidate.executionId === executionId &&
        candidate.requestId !== first.requestId,
    );
    expect(reForward.executionId).toBe(executionId);
    expect(reForward.workspace).toEqual(WS);
    expect(opsOfKind(await journalOf(hostId, executionId), "spawn_forwarded")).toHaveLength(2);
    await client.refuseToolExec(executionId, "test teardown");
    await dispatch;
    await client.close();
  });

  test("journal payload (workspaceJson included) survives a hard eviction verbatim", async () => {
    const hostId = uniqueHostId("wsreplay");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();

    await client.acknowledgeToolExecFor(
      executionId,
      dispatchViaSeam(hostId, {
        threadId,
        executionId,
        machineId: hostId,
        command: "echo hi",
        workspace: WS,
      }),
    );
    const before = await journalOf(hostId, executionId);

    // Hard memory loss on THIS DO only (l1-i19 drill): eviction clears the
    // heap, keeps SQLite — the replay must fold the same dispatch op.
    await evictDurableObject(serviceStub(hostId), { webSockets: "close" });

    const after = await journalOf(hostId, executionId);
    expect(after).toEqual(before);
    await client.close();
  });
});
