import { describe, expect, test } from "vitest";
import { evictDurableObject } from "cloudflare:test";
import type { ToolExecServiceFrame } from "../src/protocol.js";
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

  test("structured tool result replays verbatim across a hard kill (T5')", async () => {
    const hostId = uniqueHostId("i19tool");
    const threadId = `thr_${hostId}`;
    const doneId = `${threadId}:1`;
    const runningId = `${threadId}:2`;
    const client = new SimulatedClient(hostId);
    await client.dial();

    const ackTool = async (executionId: string): Promise<ToolExecServiceFrame> => {
      const frame = await client.waitFor(
        (candidate): candidate is ToolExecServiceFrame =>
          candidate.type === "tool.exec" && candidate.executionId === executionId,
      );
      client.send({
        type: "exec.spawn_ack",
        requestId: frame.requestId,
        threadId,
        executionId,
        ok: true,
      });
      return frame;
    };

    // Completed tool run with a structured (error + truncation) payload.
    const doneDispatch = dispatchViaSeam(hostId, {
      threadId,
      executionId: doneId,
      machineId: hostId,
      command: "unused",
      tool: "edit",
      toolArguments: { input: "garbage" },
    });
    await ackTool(doneId);
    await doneDispatch;
    client.sendOutput(doneId, 0, "partial stderr");
    await client.waitForOutput(doneId);
    client.send({
      type: "tool.exited",
      threadId,
      executionId: doneId,
      result: {
        status: "error",
        exitCode: null,
        output: "edit failed: no such hunk",
        outputTruncated: true,
      },
    });

    // Running tool run: dispatched + acked, no exit yet.
    const runningDispatch = dispatchViaSeam(hostId, {
      threadId,
      executionId: runningId,
      machineId: hostId,
      command: "unused",
      tool: "read",
      toolArguments: { path: "src/alpha.ts" },
    });
    await ackTool(runningId);
    await runningDispatch;
    client.sendOutput(runningId, 0, "[src/alpha.ts#A1B2]\n1:hello\n");
    await client.waitForOutput(runningId);

    const beforeDone = await executionViewOf(hostId, doneId);
    const beforeRunning = await executionViewOf(hostId, runningId);
    const beforeOps = await journalOf(hostId);
    expect(beforeDone.state).toBe("COMPLETED");
    expect(beforeDone.result).toEqual({
      status: "error",
      exitCode: null,
      output: "edit failed: no such hunk",
      outputTruncated: true,
    });
    expect(beforeRunning.state).toBe("RUNNING");

    await evictDurableObject(serviceStub(hostId), { webSockets: "close" });

    const afterOps = await journalOf(hostId);
    expect(afterOps.map((op) => op.kind)).toEqual(beforeOps.map((op) => op.kind));
    // The omp projection travels verbatim (§8.3 先落盘后 ack): replayed state
    // equals live state — no exit-code re-derivation from the bash fold.
    const afterDone = await executionViewOf(hostId, doneId);
    expect(afterDone).toMatchObject({
      state: "COMPLETED",
      lastOffset: beforeDone.lastOffset,
      result: beforeDone.result,
    });
    const afterRunning = await executionViewOf(hostId, runningId);
    expect(afterRunning).toMatchObject({
      state: "RUNNING",
      lastOffset: beforeRunning.lastOffset,
      ackedOffset: beforeRunning.ackedOffset,
      result: null,
    });
    await client.close();
  });
});
