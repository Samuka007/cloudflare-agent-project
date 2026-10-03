import { describe, expect, test } from "vitest";
import {
  SimulatedClient,
  uniqueHostId,
  workerFetch,
  testEnv,
  journalOf,
  opsOfKind,
} from "./helpers.js";
import { DAEMON_PROTOCOL_VERSION } from "../src/constants.js";

/**
 * Handshake + auth surface (bb §2.1/§5; §8.5 tree steps 1–3): Bearer hostKey
 * on the daemon seam, protocol-version freeze, 1008 on invalid attach, and
 * the same-host replacement semantics (I17 shape).
 */

describe("L1 handshake + auth", () => {
  test("session/open with a wrong bearer hostKey is 401", async () => {
    const hostId = uniqueHostId("auth");
    const response = await workerFetch(
      new Request("https://daemon-service.test/session/open", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
        body: JSON.stringify({ hostId, protocolVersion: DAEMON_PROTOCOL_VERSION, bootId: "boot_x" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("session/open without any authorization header is 401", async () => {
    const response = await workerFetch(
      new Request("https://daemon-service.test/session/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: "h", protocolVersion: DAEMON_PROTOCOL_VERSION, bootId: "boot_x" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("protocol version mismatch is a 400 with protocol_version_mismatch", async () => {
    const hostId = uniqueHostId("proto");
    const client = new SimulatedClient(hostId);
    try {
      await client.dial({ protocolVersion: DAEMON_PROTOCOL_VERSION + 7 });
      expect.unreachable("dial should have failed");
    } catch (error) {
      expect(String(error)).toContain("400");
    }
    const response = await workerFetch(
      new Request("https://daemon-service.test/session/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${testEnv.DAEMON_HOST_KEY}`,
        },
        body: JSON.stringify({ hostId, protocolVersion: 999, bootId: "boot_x" }),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string }; code?: string };
    expect(body.code ?? body.error?.code).toBe("protocol_version_mismatch");
  });

  test("WS attach with a bogus sessionId is rejected before any socket exists", async () => {
    const hostId = uniqueHostId("attach");
    const response = await workerFetch(
      new Request(
        `https://daemon-service.test/ws?hostId=${encodeURIComponent(hostId)}&sessionId=sess_bogus`,
        {
          headers: {
            Upgrade: "websocket",
            authorization: `Bearer ${testEnv.DAEMON_HOST_KEY}`,
          },
        },
      ),
    );
    // Platform reality (documented deviation from bb's post-upgrade 1008):
    // the DO rejects the upgrade before any socket exists.
    expect(response.status).toBe(401);
    expect(response.webSocket).toBeNull();
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("invalid_session");
  });

  test("second dial for the same host replaces: old socket closed 1000 replaced (I17)", async () => {
    const hostId = uniqueHostId("replace");
    const first = new SimulatedClient(hostId);
    await first.dial();
    const second = new SimulatedClient(hostId);
    await second.dial();

    // 顶替: the DO closes the old socket with 1000 "replaced" (§5.2.5).
    await expect
      .poll(
        () => first.closeEvents.find((event) => event.code === 1000)?.reason ?? "",
        { timeout: 5000, interval: 50 },
      )
      .toBe("replaced");
    expect(first.closeEvents.find((event) => event.code === 1000)?.code).toBe(1000);

    const replaced = opsOfKind(await journalOf(hostId), "session_replaced");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.oldSessionId).not.toBe(second.bootId);
    await first.close();
    await second.close();
  });
});
