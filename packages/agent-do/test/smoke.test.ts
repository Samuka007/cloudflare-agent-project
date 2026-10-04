import { afterEach, describe, expect, test } from "vitest";
import { abortAllDurableObjects } from "cloudflare:test";
import { createRig, resetRuntime, typeList } from "./helpers.js";

afterEach(() => {
  resetRuntime();
});

describe("smoke: worker wiring", () => {
  test("createThread persists thread.created", async () => {
    const rig = await createRig();
    const events = await rig.events();
    expect(typeList(events)).toEqual(["thread.created"]);
    expect(events[0]?.data).toMatchObject({ title: "rig", machineId: rig.threadId });
  });

  test("a full turn with no tool calls completes", async () => {
    const rig = await createRig({ turns: [{ deltas: ["Hello world"] }] });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    expect(sent.duplicated).toBe(false);
    const events = await rig.waitTurnComplete(sent.turnId);
    // #197 D3: the turn.phase markers (stream_started, first_token before
    // the first delta; terminal, settled after the turn row) are part of the
    // canonical journal shape now.
    expect(typeList(events)).toEqual([
      "thread.created",
      "turn.input",
      "model.call_started",
      "turn.phase",
      "turn.phase",
      "model.delta",
      "model.call_completed",
      "turn.completed",
      "turn.phase",
      "turn.phase",
    ]);
  });

  test("duplicate clientRequestId appends nothing (I2 shape)", async () => {
    const rig = await createRig({ turns: [{ deltas: ["done"] }] });
    const first = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    await rig.waitTurnComplete(first.turnId);
    const second = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    expect(second).toEqual({ turnId: first.turnId, steer: false, duplicated: true });
    const events = await rig.events();
    expect(events.filter((event) => event.type === "turn.input")).toHaveLength(1);
  });

  test("tool-calling turn runs against the fake daemon", async () => {
    const rig = await createRig({
      turns: [
        { deltas: ["running"], toolCalls: [{ name: "bash", arguments: { command: "ls" } }] },
        { deltas: ["all done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "list files" }],
      mode: "auto",
    });
    const completionPromise = rig.waitTurnComplete(sent.turnId);
    const toolCalls = await rig.waitFor((all) => all.some((event) => event.type === "tool.call"));
    const toolCall = toolCalls.find((event) => event.type === "tool.call");
    const callSeq = toolCall?.seq ?? 0;
    const executionId = `${rig.threadId}:${callSeq}`;
    await rig.service.clientEmitOutput(executionId, "file-a\nfile-b\n");
    await rig.service.clientExit(executionId, {
      status: "ok",
      exitCode: 0,
      output: "file-a\nfile-b\n",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    void completionPromise;
    expect(events.some((event) => event.type === "tool.call")).toBe(true);
    expect(events.some((event) => event.type === "tool.result")).toBe(true);
    expect(await rig.service.clientSpawnCalls()).toHaveLength(1);
  });

  test("crash + cold start replays to the identical log (drill shape)", async () => {
    const rig = await createRig({ turns: [{ deltas: ["a", "b", "c"] }] });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "in-1",
      content: [{ type: "text", text: "hi" }],
      mode: "auto",
    });
    await rig.waitTurnComplete(sent.turnId);
    const before = await rig.events();
    await abortAllDurableObjects();
    const after = await rig.afterAbort(() => rig.events());
    expect(after.map((event) => [event.seq, event.type, event.id])).toEqual(
      before.map((event) => [event.seq, event.type, event.id]),
    );
  });
});
