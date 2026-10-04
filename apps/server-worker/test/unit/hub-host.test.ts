import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { openWebSocket } from "../helpers.js";

/**
 * #193 S1: the hub side of the host changed broadcast — bb's registerDaemon
 * fan-out shape (ws/hub.ts:471-475 anchor; hub.test.ts:497 regression shape).
 * An id-bearing host changed frame reaches BOTH the host-detail:<id> key and
 * the host-list key (subscriptionKeysForMessage), and nothing else. The
 * vitest pool cannot deliver server→client frames to an in-isolate client
 * (compat/c4-ws FIXME), so targeting is asserted through the hub RPC results
 * (`delivered` counts) — the fan-out loop is shared with every changed frame.
 */

interface HubHostRpc {
  notifyHost(hostId: string, changes: string[]): Promise<{ delivered: number }>;
}

function hub(): HubHostRpc {
  return env.HUB.get(env.HUB.idFromName("hub"));
}

describe("#193 hub host changed fan-out", () => {
  it("delivers nothing to sockets subscribed to other hosts", async () => {
    const hostId = `host_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const other = await openWebSocket("/ws");
    const otherHostId = `host_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    try {
      other.send(
        JSON.stringify({ type: "subscribe", target: { kind: "host-detail", hostId: otherHostId } }),
      );
      // Integration settle: the hub processes the subscribe frame inside the
      // workers runtime, where fake timers cannot reach — a real beat is the
      // only way to let the DO apply the key (hub-delta.test.ts precedent).
      const { promise, resolve } = Promise.withResolvers<undefined>();
      setTimeout(resolve, 250);
      await promise;
      // The target id is unique to this test: no socket holds a matching key,
      // so the broadcast finds zero recipients.
      const result = await hub().notifyHost(hostId, ["host-connected"]);
      expect(result.delivered).toBe(0);
    } finally {
      other.send(
        JSON.stringify({
          type: "unsubscribe",
          target: { kind: "host-detail", hostId: otherHostId },
        }),
      );
      other.close();
    }
  });

  it("fans host-connected/host-disconnected to detail AND list subscribers", async () => {
    const hostId = `host_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const detail = await openWebSocket("/ws");
    const list = await openWebSocket("/ws");
    try {
      detail.send(JSON.stringify({ type: "subscribe", target: { kind: "host-detail", hostId } }));
      list.send(JSON.stringify({ type: "subscribe", target: { kind: "host-list" } }));
      // Integration settle (see above): subscribe frames land in the hub DO.
      const { promise, resolve } = Promise.withResolvers<undefined>();
      setTimeout(resolve, 250);
      await promise;

      const connected = await hub().notifyHost(hostId, ["host-connected"]);
      expect(connected.delivered).toBe(2);
      const disconnected = await hub().notifyHost(hostId, ["host-disconnected"]);
      expect(disconnected.delivered).toBe(2);
    } finally {
      detail.send(JSON.stringify({ type: "unsubscribe", target: { kind: "host-detail", hostId } }));
      list.send(JSON.stringify({ type: "unsubscribe", target: { kind: "host-list" } }));
      detail.close();
      list.close();
    }
  });
});
