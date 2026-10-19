import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import {
  createHostTool,
  HostToolDispatcher,
  type HostDispatchClient,
  type HostDispatchOutcome,
  type HostToolFrame,
  type HostToolResultPayload,
} from "../src/tools.js";

class FakeDispatchClient implements HostDispatchClient {
  readonly frames: HostToolFrame[] = [];
  outcome: HostDispatchOutcome = { kind: "accepted" };

  dispatch(frame: HostToolFrame): Promise<HostDispatchOutcome> {
    this.frames.push(frame);
    return Promise.resolve(this.outcome);
  }
}

function fakeApi(outputs: string[]): ToolExecutionApi {
  return {
    conversationId: "conv-1",
    taskId: "task-1",
    callId: "call-1",
    output: (chunk: string | Uint8Array) => {
      outputs.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    },
  } as unknown as ToolExecutionApi;
}

const scope = { machineId: "machine-1", threadId: "thread-1", turnId: "turn-1" };

function bashTool(client: HostDispatchClient) {
  const transport = new HostToolDispatcher(client);
  const tool = createHostTool(
    {
      name: "bash",
      description: "Run a command",
      parameters: Type.Object({ command: Type.String() }),
      scope,
      replay: "unsafe",
      schedule: "exclusive",
      timeoutMs: 12_000,
    },
    transport,
  );
  return { transport, tool };
}

describe("host tool wrapper", () => {
  it("maps output and an exited result", async () => {
    const client = new FakeDispatchClient();
    const { transport, tool } = bashTool(client);
    const outputs: string[] = [];
    const execution = tool.execute({ command: "echo hi" }, fakeApi(outputs), {} as never);
    await vi.waitFor(() => {
      if (client.frames.length === 0) throw new Error("dispatch not called");
    });
    const frame = client.frames[0];
    if (frame === undefined) throw new Error("dispatch frame missing");
    expect(frame).toMatchObject({
      tool: "bash",
      executionId: "thread-1:task-1",
      machineId: "machine-1",
      timeoutMs: 12_000,
      arguments: { command: "echo hi" },
    });
    transport.onUpdate({
      kind: "output",
      executionId: frame.executionId,
      offset: 0,
      chunk: "hello",
    });
    transport.onUpdate({
      kind: "exited",
      executionId: frame.executionId,
      result: { status: "ok", exitCode: 0, output: "hello" },
    });
    const result = await execution;
    expect(outputs).toEqual(["hello"]);
    expect(result.isError).toBe(false);
    expect(result.details).toEqual({ status: "ok", exitCode: 0 });
    expect(result.output).toEqual([{ type: "text", text: "hello" }]);
  });

  it("returns a cached result without an update", async () => {
    const client = new FakeDispatchClient();
    client.outcome = {
      kind: "completed_cached",
      result: { status: "ok", exitCode: 0, output: "cached" },
    };
    const { tool } = bashTool(client);
    const result = await tool.execute({ command: "echo hi" }, fakeApi([]), {} as never);
    expect(result.isError).toBe(false);
    expect(result.output).toEqual([{ type: "text", text: "cached" }]);
  });

  it("maps host_offline to an error diagnostic", async () => {
    const client = new FakeDispatchClient();
    client.outcome = { kind: "host_offline" };
    const { tool } = bashTool(client);
    const result = await tool.execute({ command: "echo hi" }, fakeApi([]), {} as never);
    expect(result.isError).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", code: "host_offline" }),
    ]);
  });

  it("marks a nonzero exit as an error and preserves truncation", async () => {
    const client = new FakeDispatchClient();
    const { transport, tool } = bashTool(client);
    const execution = tool.execute({ command: "false" }, fakeApi([]), {} as never);
    await vi.waitFor(() => {
      if (client.frames.length === 0) throw new Error("dispatch not called");
    });
    const frame = client.frames[0];
    if (frame === undefined) throw new Error("dispatch frame missing");
    const result: HostToolResultPayload = {
      status: "ok",
      exitCode: 1,
      output: "boom",
      outputTruncated: true,
    };
    transport.onUpdate({ kind: "exited", executionId: frame.executionId, result });
    const mapped = await execution;
    expect(mapped.isError).toBe(true);
    expect(mapped.details).toEqual({ status: "ok", exitCode: 1, outputTruncated: true });
    expect(mapped.diagnostics).toEqual([
      expect.objectContaining({ severity: "warn", code: "truncated" }),
    ]);
  });

  it("maps schedule/replay into pi execution policy", () => {
    const client = new FakeDispatchClient();
    const { tool } = bashTool(client);
    expect(tool.replay).toBe("unsafe");
    expect(tool.executionMode).toBe("sequential");

    const read = createHostTool(
      {
        name: "read",
        description: "Read a file",
        parameters: Type.Object({ path: Type.String() }),
        scope,
        replay: "safe",
        schedule: "read",
      },
      new HostToolDispatcher(client),
    );
    expect(read.replay).toBe("safe");
    expect(read.executionMode).toBe("parallel");
  });
});
