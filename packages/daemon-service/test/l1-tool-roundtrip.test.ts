import { describe, expect, test } from "vitest";
import type { ServiceFrame, ToolExecServiceFrame } from "../src/protocol.js";
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
 * L1 host-tool relay (M1.5/T5' #128): the tool-agnostic agent-do dispatch
 * frame rides the service DO to the client's embedded omp runtime — journal
 * shape, pid-less ack, structured tool.exited closure, journal dedup, and
 * bash routing untouched.
 */

function ackToolExec(
  client: SimulatedClient,
  executionId: string,
  frame: ToolExecServiceFrame,
): void {
  client.send({
    type: "exec.spawn_ack",
    requestId: frame.requestId,
    threadId: frame.threadId,
    executionId,
    ok: true,
  });
}

function waitForToolExec(client: SimulatedClient): Promise<ToolExecServiceFrame> {
  return client.waitFor(
    (candidate): candidate is ToolExecServiceFrame => candidate.type === "tool.exec",
  );
}

describe("L1 tool roundtrip (T5')", () => {
  test("dispatch → tool.exec → pid-less ack → tool.exited lands the structured result", async () => {
    const hostId = uniqueHostId("tool");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();

    const outcome = dispatchViaSeam(hostId, {
      threadId,
      executionId,
      command: "unused",
      machineId: hostId,
      tool: "read",
      toolArguments: { path: "src/alpha.ts" },
    });

    const frame = await waitForToolExec(client);
    expect(frame.executionId).toBe(executionId);
    expect(frame.tool).toBe("read");
    expect(frame.arguments).toEqual({ path: "src/alpha.ts" });
    expect(frame.timeoutMs).toBe(600_000);
    ackToolExec(client, executionId, frame);
    await expect(outcome).resolves.toEqual({ kind: "accepted" });

    // Streaming output rides the same offset protocol as bash.
    client.sendOutput(executionId, 0, "[src/alpha.ts#A1B2]\n1:hello\n");
    await client.waitForOutput(executionId);

    client.send({
      type: "tool.exited",
      threadId,
      executionId,
      result: { status: "ok", exitCode: null, output: "[src/alpha.ts#A1B2]\n1:hello\n" },
    });

    const sink = sinkStub(threadId);
    await expect
      .poll(
        async () => (await sink.updates()).filter((update) => update.kind === "exited").length,
        { timeout: 5_000 },
      )
      .toBe(1);
    const exited = (await sink.updates()).find((update) => update.kind === "exited");
    expect(exited).toMatchObject({
      kind: "exited",
      executionId,
      result: { status: "ok", exitCode: null, output: "[src/alpha.ts#A1B2]\n1:hello\n" },
    });

    // Journal order: dispatch → spawn_forwarded → spawn_ack(pid-0 sentinel) →
    // output(+ack) → exited — the bash shape with a pid-less tool ack.
    const ops = await journalOf(hostId, executionId);
    expect(ops.map((op) => op.kind)).toEqual([
      "dispatch",
      "spawn_forwarded",
      "spawn_ack",
      "output",
      "output_ack",
      "exited",
    ]);
    expect(ops[0]).toMatchObject({ kind: "dispatch", tool: "read" });

    // Ack closes the loop: tombstone + forget frame (§8.4).
    await serviceStub(hostId).ackExecution(executionId, 42);
    const view = await executionViewOf(hostId, executionId);
    expect(view.state).toBe("TOMBSTONE");
    expect(view.result).toBeNull();
    await client.waitFor(
      (frame): frame is Extract<ServiceFrame, { type: "exec.forget" }> =>
        frame.type === "exec.forget" && frame.executionId === executionId,
    );

    // §3.5/E: re-dispatch is answered from the journal — no second forward.
    const again = await dispatchViaSeam(hostId, {
      threadId,
      executionId,
      command: "unused",
      machineId: hostId,
      tool: "read",
      toolArguments: { path: "src/alpha.ts" },
    });
    expect(again.kind).toBe("completed_cached");
    const forwards = opsOfKind(await journalOf(hostId), "spawn_forwarded").filter(
      (op) => op.executionId === executionId,
    );
    expect(forwards).toHaveLength(1);
    await client.close();
  });

  test("tool.exited carries isError and truncation verbatim to the agent sink", async () => {
    const hostId = uniqueHostId("toolerr");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();

    const outcome = dispatchViaSeam(hostId, {
      threadId,
      executionId,
      command: "unused",
      machineId: hostId,
      tool: "edit",
      toolArguments: { input: "garbage" },
    });
    const frame = await waitForToolExec(client);
    ackToolExec(client, executionId, frame);
    await outcome;
    client.send({
      type: "tool.exited",
      threadId,
      executionId,
      result: {
        status: "error",
        exitCode: null,
        output: 'input must begin with "[PATH#HASH]"',
        outputTruncated: true,
      },
    });

    const sink = sinkStub(threadId);
    await expect
      .poll(
        async () => (await sink.updates()).filter((update) => update.kind === "exited").length,
        { timeout: 5_000 },
      )
      .toBe(1);
    const exited = (await sink.updates()).find((update) => update.kind === "exited");
    expect(exited).toMatchObject({
      result: { status: "error", outputTruncated: true },
    });
    const view = await executionViewOf(hostId, executionId);
    expect(view.state).toBe("COMPLETED");
    expect(view.result).toMatchObject({ status: "error", outputTruncated: true });
    await client.close();
  });

  test("client-refused tool exec is journaled spawn_failed and reports host_offline", async () => {
    const hostId = uniqueHostId("toolref");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    const outcome = dispatchViaSeam(hostId, {
      threadId,
      executionId,
      command: "unused",
      machineId: hostId,
      tool: "grep",
      toolArguments: { pattern: "x" },
    });
    const frame = await waitForToolExec(client);
    client.send({
      type: "exec.spawn_ack",
      requestId: frame.requestId,
      threadId: frame.threadId,
      executionId,
      ok: false,
      error: "runtime_refused",
    });
    await expect(outcome).resolves.toEqual({ kind: "host_offline" });
    const failed = opsOfKind(await journalOf(hostId), "spawn_failed");
    expect(failed.map((op) => op.executionId)).toContain(executionId);
    await client.close();
  });

  test("bash keeps the M0 command path (routing regression guard)", async () => {
    const hostId = uniqueHostId("toolbash");
    const threadId = `thr_${hostId}`;
    const executionId = `${threadId}:1`;
    const client = new SimulatedClient(hostId);
    await client.dial();
    const outcome = dispatchViaSeam(hostId, {
      threadId,
      executionId,
      command: "echo poc",
      machineId: hostId,
    });
    // bash still arrives as exec.spawn with the projected command.
    const spawn = await client.waitForSpawn(executionId);
    expect(spawn.command).toBe("echo poc");
    await client.acknowledgeSpawn(executionId);
    await expect(outcome).resolves.toEqual({ kind: "accepted" });
    const dispatchOps = opsOfKind(await journalOf(hostId), "dispatch").filter(
      (op) => op.executionId === executionId,
    );
    expect(dispatchOps[0]).toMatchObject({ tool: null, command: "echo poc" });
    await client.close();
  });
});
