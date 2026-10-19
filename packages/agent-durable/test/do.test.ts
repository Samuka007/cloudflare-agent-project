import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { TestDurableAgentDO } from "./worker.js";

describe("DurableAgentDO", () => {
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
