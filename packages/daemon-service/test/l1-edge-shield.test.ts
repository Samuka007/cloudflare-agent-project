import { describe, expect, test } from "vitest";
import { serviceStub, testEnv, uniqueHostId, workerFetch } from "./helpers.js";
import { DAEMON_PROTOCOL_VERSION } from "../src/constants.js";
import { DEPLOYMENT_AUTH_MIRROR_DO_ID } from "../src/worker.js";
import { authKvKey, sha256Hex } from "../src/edge.js";

/**
 * Edge shield (#36): the front's DO-request budget. Covers the auth ladder
 * (env compare → KV hash cache → DO fallback + backfill), the negative-cache
 * window, and the per-hostId token bucket — with the DO-touch counter
 * (`edgeStats`) proving that digested requests never reach the DO.
 */

const OPEN_URL = "https://daemon-service.test/session/open";

function openRequest(args: {
  hostKey: string;
  hostId?: string;
  bootId?: string;
  protocolVersion?: number;
}): Request {
  return new Request(OPEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.hostKey}`,
    },
    body: JSON.stringify({
      ...(args.hostId === undefined ? {} : { hostId: args.hostId }),
      protocolVersion: args.protocolVersion ?? DAEMON_PROTOCOL_VERSION,
      bootId: args.bootId ?? `boot_${crypto.randomUUID().slice(0, 8)}`,
    }),
  });
}

async function openCallsOf(hostId: string): Promise<number> {
  return (await serviceStub(hostId).edgeStats()).openSessionCalls;
}

describe("L1 edge shield — auth ladder (#36)", () => {
  test("a KV-held key authorizes locally and its hostIdHint resolves the DO", async () => {
    const hostId = uniqueHostId("edgeauth");
    const key = `edge-key-${crypto.randomUUID().slice(0, 8)}`;
    await testEnv.DAEMON_EDGE_KV.put(authKvKey(await sha256Hex(key)), JSON.stringify({ hostId }));
    try {
      // No hostId in the body: the hint must come from the KV cache entry.
      const response = await workerFetch(openRequest({ hostKey: key }));
      expect(response.status).toBe(201);
      const session = await serviceStub(hostId).sessionView();
      expect(session).not.toBeNull();
      expect(session?.hostId).toBe(hostId);
    } finally {
      await testEnv.DAEMON_EDGE_KV.delete(authKvKey(await sha256Hex(key)));
    }
  });

  test("a key outside env and cache is rejected without populating the cache", async () => {
    const key = `bogus-${crypto.randomUUID().slice(0, 8)}`;
    const keyHash = await sha256Hex(key);
    const response = await workerFetch(openRequest({ hostKey: key, hostId: uniqueHostId("edge") }));
    expect(response.status).toBe(401);
    expect(await testEnv.DAEMON_EDGE_KV.get(authKvKey(keyHash))).toBeNull();
  });

  test("KV miss falls back to the DO mirror once and backfills the cache", async () => {
    const hostId = uniqueHostId("edgebackfill");
    // Enroll: mirror write (authority) → KV put (cache).
    const enroll = await workerFetch(
      new Request("https://daemon-service.test/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enrollKey: testEnv.ENROLL_KEY, hostId }),
      }),
    );
    expect(enroll.status).toBe(201);
    // Simulate cache eviction + plant a non-env key directly in the mirror
    // (the M1 shape: issuance registry, no env key). The L1 rig's env key
    // path would otherwise short-circuit below the KV rungs. The mirror
    // lives in the deployment auth-mirror DO (#377 constant) — the DO the
    // ladder's fallback consults.
    const mirrorKey = `mirror-${crypto.randomUUID().slice(0, 8)}`;
    const mirrorHash = await sha256Hex(mirrorKey);
    await testEnv.DAEMON_EDGE_KV.delete(authKvKey(await sha256Hex(testEnv.DAEMON_HOST_KEY)));
    await serviceStub(DEPLOYMENT_AUTH_MIRROR_DO_ID).mirrorHostKey({
      keyHash: mirrorHash,
      hostId,
      ttlMs: 60_000,
    });
    try {
      const before = await testEnv.DAEMON_EDGE_KV.get(authKvKey(mirrorHash));
      expect(before).toBeNull();
      const response = await workerFetch(openRequest({ hostKey: mirrorKey, hostId }));
      expect(response.status).toBe(201);
      // Backfill: the cache now holds the mirror's verdict.
      const backfilled = await testEnv.DAEMON_EDGE_KV.get(authKvKey(mirrorHash));
      if (backfilled === null) throw new Error("auth cache was not backfilled");
      expect(JSON.parse(backfilled)).toEqual({ hostId });
    } finally {
      await testEnv.DAEMON_EDGE_KV.delete(authKvKey(mirrorHash));
    }
  });
});

describe("L1 edge shield — negative cache (#36)", () => {
  test("overload arms a window: 50 requests, 1 DO touch, then expiry reconnects", async () => {
    const hostId = uniqueHostId("negcache");
    const stub = serviceStub(hostId);
    await stub.debugSetOverload(true);

    const first = await workerFetch(openRequest({ hostKey: testEnv.DAEMON_HOST_KEY, hostId }));
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).not.toBeNull();
    expect(await openCallsOf(hostId)).toBe(1); // the request that armed the window

    // Window: every further negotiation request is answered at the edge.
    const during: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      during.push(
        (await workerFetch(openRequest({ hostKey: testEnv.DAEMON_HOST_KEY, hostId }))).status,
      );
    }
    expect(during.every((status) => status === 429)).toBe(true);
    expect(await openCallsOf(hostId)).toBe(1); // zero DO touches in the window
    // /ws attach is digested by the same window.
    const ws = await workerFetch(
      new Request(`https://daemon-service.test/ws?hostId=${hostId}&sessionId=sess_x`, {
        headers: {
          Upgrade: "websocket",
          authorization: `Bearer ${testEnv.DAEMON_HOST_KEY}`,
        },
      }),
    );
    expect(ws.status).toBe(429);
    expect(await openCallsOf(hostId)).toBe(1);

    // Window expiry (L1 rig DAEMON_NEGATIVE_CACHE_MS=1500): expiry lives on
    // the workerd isolate clock, which fake timers in this (test) realm
    // cannot advance — so poll the real condition instead of sleeping:
    // each poll attempt inside the window is answered at the edge (429,
    // zero DO), and the first attempt after expiry reaches the DO and
    // succeeds (bucket is untouched while the window holds).
    await stub.debugSetOverload(false);
    await expect
      .poll(
        async () =>
          (await workerFetch(openRequest({ hostKey: testEnv.DAEMON_HOST_KEY, hostId }))).status,
        { timeout: 5_000, interval: 200 },
      )
      .toBe(201);
    expect(await openCallsOf(hostId)).toBe(2);
  });
});

describe("L1 edge shield — token bucket (#36)", () => {
  test("a flood above the per-host capacity is rejected at the edge", async () => {
    const hostId = uniqueHostId("bucket");
    let rejections = 0;
    for (let i = 0; i < 30; i += 1) {
      const response = await workerFetch(openRequest({ hostKey: testEnv.DAEMON_HOST_KEY, hostId }));
      if (response.status === 429) {
        rejections += 1;
        expect(response.headers.get("retry-after")).not.toBeNull();
      }
    }
    expect(rejections).toBeGreaterThanOrEqual(5);
    // Bucket rejections must not have translated into DO touches.
    expect(await openCallsOf(hostId)).toBeLessThanOrEqual(30 - rejections);
  });
});
