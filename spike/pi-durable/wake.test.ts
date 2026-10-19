import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { SpikeSession } from "./worker";

const context = BACKGROUND_CONTEXT;
describe("pi-durable in a Cloudflare Durable Object", () => {
  it("does not rerun an unsafe tool after an eviction", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, async (instance: SpikeSession, state) => {
      instance.script([
        { kind: "tool", name: "marker", args: { label: "once" }, id: "call-1" },
        { kind: "text", text: "done" },
      ]);
      await instance.submit("run marker", "tool-1");
      await instance.toolStarted.promise;
      expect(instance.markerCount()).toBe(1);
      // The recovery heartbeat was armed before the input was admitted.
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const result = await runInDurableObject(stub, async (instance: SpikeSession) => {
      const root = await instance.root();
      // The same request ID finds the submission admitted before the eviction.
      const submission = await root.submit({ type: "input", content: "run marker", requestId: "tool-1" }, context);
      const settled = await submission.wait(context);
      const count = instance.markerCount();
      if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      const message = entry?.model?.[0];
      return { count, role: message?.role, text: JSON.stringify(message?.content) };
    });
    // The marker tool ran exactly once; the retry saw `interrupted`, not a rerun.
    expect(result.count).toBe(1);
    expect(result.role).toBe("assistant");
    expect(result.text).toContain("done");
  });

  it("recovers a turn an eviction cut off mid-stream through the heartbeat alarm", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, async (instance: SpikeSession, state) => {
      instance.script([{ kind: "hang" }, { kind: "text", text: "recovered" }]);
      await instance.submit("hi", "turn-1");
      await instance.hanging.promise;
      // The heartbeat alarm armed before the input was admitted.
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const answer = await runInDurableObject(stub, async (instance: SpikeSession) => {
      const root = await instance.root();
      // The same request ID finds the submission admitted before the eviction.
      const submission = await root.submit({ type: "input", content: "hi", requestId: "turn-1" }, context);
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      const message = entry?.model?.[0];
      return message?.role === "assistant" ? message.content : undefined;
    });
    expect(JSON.stringify(answer)).toContain("recovered");
  });
});
