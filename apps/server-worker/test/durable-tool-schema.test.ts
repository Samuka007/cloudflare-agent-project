import { TOOL_REGISTRY } from "@cap/agent-do";
import { createHostTool, HostToolDispatcher } from "@cap/agent-durable";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

describe("durable runtime tool projection", () => {
  it("compiles the bash registry schema as a pi tool", () => {
    const row = TOOL_REGISTRY.find((candidate) => candidate.name === "bash");
    if (row === undefined) throw new Error("bash registry row missing");
    const tool = createHostTool(
      {
        name: row.name,
        description: row.descriptionTemplate,
        parameters: row.schema.toJsonSchema(),
        scope: { machineId: "m", threadId: "t", turnId: "turn" },
        replay: "unsafe",
        schedule: row.schedule,
      },
      new HostToolDispatcher({
        dispatch: () => Promise.resolve({ kind: "host_offline" }),
      }),
    );
    const args = validateToolArguments(tool, {
      id: "call-1",
      name: "bash",
      arguments: { command: "echo hi" },
    });
    expect(args).toMatchObject({ command: "echo hi" });
  });
});
