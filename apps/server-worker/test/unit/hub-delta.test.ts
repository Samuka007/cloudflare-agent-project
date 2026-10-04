import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { openWebSocket } from "../helpers.js";
import { threadDeltaMessage } from "@cap/protocol";

/**
 * #197: the hub's Tier-A delta frame surface. The vitest pool cannot deliver
 * server→client WS frames to an in-isolate client (see compat/c4-ws FIXME),
 * so targeting and waiter-wake are asserted through the hub RPC results
 * (`delivered` counts) — the fan-out loop itself is shared with `changed`.
 */

interface HubDeltaRpc {
  notifyThreadDelta(frame: Record<string, unknown>): Promise<{ delivered: number }>;
  notifyThread(
    threadId: string,
    changes: string[],
    metadata?: Record<string, unknown>,
  ): Promise<{ delivered: number }>;
  waitThreadEvent(args: { threadId: string; waitMs: number }): Promise<{ resolved: boolean }>;
}

function hub(): HubDeltaRpc {
  return env.HUB.get(env.HUB.idFromName("hub"));
}

describe("#197 hub delta frame surface", () => {
  it("fans deltas to thread-detail subscribers only (thread-list gets none)", async () => {
    const threadId = `thr_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const detail = await openWebSocket("/ws");
    detail.send(JSON.stringify({ type: "subscribe", target: { kind: "thread-detail", threadId } }));
    const list = await openWebSocket("/ws");
    list.send(JSON.stringify({ type: "subscribe", target: { kind: "thread-list" } }));
    // Give the hub DO a beat to process both subscribe frames (ordered on the
    // same DO, but arriving over two sockets).
    await new Promise((resolve) => setTimeout(resolve, 250));

    const frame = threadDeltaMessage({
      threadId,
      turnId: "turn_delta1",
      itemId: `itm-am-turn_delta1:7`,
      seq: 7,
      text: "hello stream",
      latestSeq: 7,
    });
    const result = await hub().notifyThreadDelta(frame);
    expect(result.delivered).toBe(1);

    const otherDetail = await openWebSocket("/ws");
    otherDetail.send(
      JSON.stringify({ type: "subscribe", target: { kind: "thread-detail", threadId } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterSecond = await hub().notifyThreadDelta(frame);
    expect(afterSecond.delivered).toBe(2);
  });

  it("resolves events/wait waiters on delta notifies (spec §5.2)", async () => {
    const threadId = `thr_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const waitPromise = hub().waitThreadEvent({ threadId, waitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await hub().notifyThreadDelta({
      type: "delta",
      entity: "thread",
      id: threadId,
      turnId: "turn_delta2",
      itemId: "itm-am-turn_delta2:3",
      seq: 3,
      latestSeq: 3,
    });
    const waited = await waitPromise;
    // Flag semantics (hub.ts waiter): false = woken by a notify, true = the
    // waitMs deadline expired. A delta notify must WAKE the waiter.
    expect(waited.resolved).toBe(false);
  });

  it("skips invalid delta frames without crashing (strict schema, broadcastChanged posture)", async () => {
    const result = await hub().notifyThreadDelta({
      type: "delta",
      entity: "thread",
      id: "thr_invalid",
      // missing turnId/itemId/seq/latestSeq — hub must skip, not throw
    });
    expect(result.delivered).toBe(0);
  });

  it("carries phase-changed through the strict changed path with the phase payload", async () => {
    const threadId = `thr_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const detail = await openWebSocket("/ws");
    detail.send(JSON.stringify({ type: "subscribe", target: { kind: "thread-detail", threadId } }));
    const list = await openWebSocket("/ws");
    list.send(JSON.stringify({ type: "subscribe", target: { kind: "thread-list" } }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await hub().notifyThread(threadId, ["phase-changed"], {
      latestSeq: 12,
      phase: { turnId: "turn_phase1", phase: "terminal", reason: "completed" },
    });
    // changed frames with an id fan out to detail AND list (bb rule). The
    // count is hub-global (earlier tests' sockets stay subscribed), so this
    // asserts at least this test's two subscribers were reached.
    expect(result.delivered).toBeGreaterThanOrEqual(2);

    const rejected = await hub().notifyThread(threadId, ["phase-changed"], {
      latestSeq: 13,
      phase: { turnId: "turn_phase1", phase: "not-a-phase" },
    });
    expect(rejected.delivered).toBe(0);
  });
});
