import { describe, expect, test } from "vitest";
import { testEnv, workerFetch } from "./helpers.js";
import { consumeJoinCode, joinCodeKvKey, mintJoinCode, sha256Hex } from "../src/join-codes.js";

/**
 * #258: the enroll front redeems one-time join codes minted by the control
 * plane's POST /hosts/join-codes (the Add-a-machine path). bb anchor: the
 * daemon enrolls with the enrollKey and the server issues identity from the
 * key's metadata (internal/hosts.ts:83-122, machine-auth.ts:360-401) — the
 * daemon never self-assigns the hostId on this path. The static env key path
 * (#176) claims only an EXPLICIT body hostId; without one it mints a fresh
 * host (#377) — the old deployment-identity fallback fabricated a synthetic
 * "local" machine every env-key enrollee collided on.
 */

function enroll(credential: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return workerFetch(
    new Request("https://daemon-service.test/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollKey: credential, hostName: "joiner-host", ...extra }),
    }),
  );
}

describe("L1 enroll join codes (#258)", () => {
  test("a minted code enrolls the daemon as the minted hostId", async () => {
    const minted = await mintJoinCode(testEnv.DAEMON_EDGE_KV, "host_jc_a1b2c3d4e5");
    const response = await enroll(minted.code);
    expect(response.status).toBe(201);
    const body = await response.json<{ hostId: string; hostKey: string }>();
    expect(body.hostId).toBe("host_jc_a1b2c3d4e5");
    expect(body.hostKey).toBe(testEnv.DAEMON_HOST_KEY);
  });

  test("the minted hostId wins over a body claim (bb key-metadata authority)", async () => {
    const minted = await mintJoinCode(testEnv.DAEMON_EDGE_KV, "host_jc_authority1");
    const response = await enroll(minted.code, { hostId: "host_jc_squatter" });
    expect(response.status).toBe(201);
    const body = await response.json<{ hostId: string }>();
    expect(body.hostId).toBe("host_jc_authority1");
  });

  test("a code redeems exactly once (bb remaining: 1)", async () => {
    const minted = await mintJoinCode(testEnv.DAEMON_EDGE_KV, "host_jc_oneshot01");
    expect((await enroll(minted.code)).status).toBe(201);
    expect((await enroll(minted.code)).status).toBe(401);
  });

  test("an expired record redeems nothing even if KV still serves it", async () => {
    const code = "capjc_stale";
    await testEnv.DAEMON_EDGE_KV.put(
      joinCodeKvKey(await sha256Hex(code)),
      JSON.stringify({ hostId: "host_jc_stale001", expiresAt: Date.now() - 1_000 }),
    );
    expect((await enroll(code)).status).toBe(401);
    // The dead record must not linger as a replayable artifact.
    await expect(consumeJoinCode(testEnv.DAEMON_EDGE_KV, code)).resolves.toBeNull();
  });

  test("unknown credentials and the no-KV posture stay 401", async () => {
    expect((await enroll("capjc_never-minted")).status).toBe(401);
    expect((await enroll("")).status).toBe(401);
  });

  test("static env key enrollment keeps its explicit body claim", async () => {
    const response = await enroll(testEnv.ENROLL_KEY, { hostId: "host_jc_static01" });
    expect(response.status).toBe(201);
    const body = await response.json<{ hostId: string }>();
    expect(body.hostId).toBe("host_jc_static01");
  });

  test("env-key enroll without a claim mints a fresh bb-shape host (#377)", async () => {
    const first = await enroll(testEnv.ENROLL_KEY);
    const second = await enroll(testEnv.ENROLL_KEY);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const mintedA = await first.json<{ hostId: string }>();
    const mintedB = await second.json<{ hostId: string }>();
    // bb id shape, and NEVER a shared deployment identity.
    expect(mintedA.hostId).toMatch(/^host_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u);
    expect(mintedB.hostId).toMatch(/^host_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u);
    expect(mintedA.hostId).not.toBe(mintedB.hostId);
  });
});
