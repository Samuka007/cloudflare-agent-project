import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { TestDurableAgentDO } from "./worker.js";

describe("DurableAgentDO", () => {
  it("creates a thread and streams pi events into the derived journal", async () => {
    const stub = env.AGENT_DO.get(env.AGENT_DO.newUniqueId());
    const result = await runInDurableObject(stub, async (instance: TestDurableAgentDO) => {
      instance.script([{ kind: "text", text: "done" }]);
      const created = await instance.createThread({ threadId: "thread-x", title: "T" });
      const sent = await instance.sendMessage({
        clientRequestId: "req-1",
        content: [{ type: "text", text: "hi" }],
        mode: "start",
      });
      const again = await instance.sendMessage({
        clientRequestId: "req-1",
        content: [{ type: "text", text: "hi" }],
        mode: "start",
      });
      return { created, sent, again };
    });
    expect(result.created).toEqual({ threadId: "thread-x", duplicated: false });
    expect(result.sent).toEqual({ turnId: "turn-thread-x-1", steer: false, duplicated: false });
    expect(result.again).toEqual({ turnId: "turn-thread-x-1", steer: false, duplicated: true });

    const page = await runInDurableObject(stub, async (instance: TestDurableAgentDO) => {
      await vi.waitFor(
        async () => {
          const current = await instance.getEvents({ sinceSeq: 0 });
          if (!current.events.some((event) => event.type === "item/completed")) {
            throw new Error("agent message not committed yet");
          }
        },
        { timeout: 10_000, interval: 50 },
      );
      return instance.getEvents({ sinceSeq: 0 });
    });
    expect(page.events.map((event) => event.type)).toEqual([
      "client/thread/start",
      "item/started",
      "turn/started",
      "item/completed",
      "turn/completed",
    ]);
    expect(page.events[1]?.data).toMatchObject({
      item: { type: "userMessage", content: [{ type: "text", text: "hi" }] },
    });
    expect(page.events[3]?.data).toMatchObject({
      item: { type: "agentMessage", text: "done" },
    });
    expect(page.latestSeq).toBe(page.events.length);
  });

  it("does not rerun an unsafe tool after an eviction", async () => {
    const stub = env.AGENT_DO.get(env.AGENT_DO.newUniqueId());
    await runInDurableObject(stub, async (instance: TestDurableAgentDO, state) => {
      instance.script([
        { kind: "tool", name: "marker", args: { label: "once" }, id: "call-1" },
        { kind: "text", text: "done" },
      ]);
      await instance.submit("run marker", "tool-1");
      await vi.waitFor(
        () => {
          if (!instance.state().toolStarted) throw new Error("marker tool not started");
        },
        { timeout: 10_000, interval: 20 },
      );
      expect(instance.state().markerCount).toBe(1);
      // The recovery heartbeat was armed before the input was admitted.
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const result = await runInDurableObject(stub, async (instance: TestDurableAgentDO) => {
      const settled = await instance.wait("tool-1", "run marker");
      return { count: instance.state().markerCount, settled };
    });
    // The marker tool ran exactly once; the retry saw `interrupted`, not a rerun.
    expect(result.count).toBe(1);
    expect(result.settled.status).toBe("done");
    expect(JSON.stringify(result.settled)).toContain("done");
  });

  it("recovers a turn an eviction cut off mid-stream through the heartbeat alarm", async () => {
    const stub = env.AGENT_DO.get(env.AGENT_DO.newUniqueId());
    await runInDurableObject(stub, async (instance: TestDurableAgentDO, state) => {
      instance.script([{ kind: "hang" }, { kind: "text", text: "recovered" }]);
      await instance.submit("hi", "turn-1");
      await vi.waitFor(
        () => {
          if (!instance.state().hanging) throw new Error("model request not hanging yet");
        },
        { timeout: 10_000, interval: 20 },
      );
      // The heartbeat alarm armed before the input was admitted.
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const answer = await runInDurableObject(stub, async (instance: TestDurableAgentDO) => {
      const settled = await instance.wait("turn-1", "hi");
      if (settled.status !== "done" || settled.type !== "input") {
        throw new Error(`Unexpected settlement: ${settled.status}`);
      }
      const root = instance.root();
      const entry = await root.commit(
        (tx) => tx.entry(AssistantEntry, settled.answer),
        BACKGROUND_CONTEXT,
      );
      return entry?.model?.[0];
    });
    expect(JSON.stringify(answer)).toContain("recovered");
  });
});
