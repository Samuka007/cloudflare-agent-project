import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { hostSchema } from "../../src/contract/domain/host.js";
import type { Host } from "../../src/contract/domain/host.js";
import { LIVENESS_PROJECTION_INTERVAL_MS } from "@cap/daemon-service";
import { BASE, apiGet } from "../helpers.js";

/**
 * #62 hosts liveness, bb-verbatim (apps/server/src/ws/daemon-protocol.ts:
 * 129-136 → packages/db/src/data/sessions.ts:203-223 → data/hosts.ts:
 * 113-122): daemon heartbeats refresh the registry's last_seen_at, and
 * status derives read-time from the open daemon session (entity-lookup.ts:
 * 71-80) — never a route-level constant. The attach bridge (#49) is the row
 * creator; this suite covers the two directions the ticket names: heartbeat
 * → last_seen_at advances, disconnect → status flips.
 */
beforeAll(ensureMigrations);

/** Drives the composed daemon face exactly like the daemon client. */
async function enroll(hostId: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey: "[REDACTED-staging-secret]", hostId }),
  });
}

interface OpenedSession {
  sessionId: string;
}

async function openSession(hostId: string): Promise<OpenedSession> {
  const response = await exports.default.fetch(`${BASE}/session/open`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer [REDACTED-staging-secret]" },
    body: JSON.stringify({ hostId, bootId: `boot_${hostId}`, protocolVersion: 1 }),
  });
  expect(response.status).toBe(201);
  return await response.json<OpenedSession>();
}

/**
 * WS attach straight into the per-host daemon-service DO — the exact fetch
 * handler the composed front's handleWsAttach forwards to (worker.ts
 * stubForHost), sidestepping the pool's SELF WS transport gap.
 */
async function openDaemonSocket(hostId: string, sessionId: string): Promise<WebSocket> {
  const stub = env.DAEMON_SERVICE.get(env.DAEMON_SERVICE.idFromName(hostId));
  const response = await stub.fetch(
    `https://daemon-service/ws?hostId=${encodeURIComponent(hostId)}&sessionId=${encodeURIComponent(sessionId)}`,
    { headers: { upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("upgrade produced no websocket");
  socket.accept();
  return socket;
}

async function readHost(hostId: string): Promise<Host | null> {
  const response = await apiGet("/api/v1/hosts");
  expect(response.status).toBe(200);
  const body = await response.json<unknown[]>();
  const row = body.find((entry) => hostSchema.parse(entry).id === hostId);
  return row ? hostSchema.parse(row) : null;
}

async function storedLastSeenAt(hostId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT last_seen_at FROM hosts WHERE id = ?")
    .bind(hostId)
    .first<{ last_seen_at: number | null }>();
  return row?.last_seen_at ?? null;
}

async function backdateLastSeenAt(hostId: string, at: number): Promise<void> {
  await env.DB.prepare("UPDATE hosts SET last_seen_at = ? WHERE id = ?").bind(at, hostId).run();
}

/**
 * Integration wait on the remote DO's clock: the state change happens inside
 * the workers runtime (heartbeat → D1 projection, socket registry), where
 * fake timers cannot reach and no client-visible signal exists in this pool
 * (see c4-ws FIXME on server→client frames) — so poll the real clock until
 * the observable effect lands.
 */
async function pollUntil(probe: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await waitFor(100);
  }
}

/** Fixed settle for a negative assertion: give the DO a beat to (not) act. */
async function settle(ms: number): Promise<void> {
  await waitFor(ms);
}

/** House delay (lease-do.test.ts): withResolvers over executor callbacks. */
function waitFor(ms: number): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, ms);
  return promise;
}

describe("hosts liveness (#62)", () => {
  it("a live daemon session reads connected; closing it flips to disconnected", async () => {
    const hostId = "local-liveness-flip";
    expect((await enroll(hostId)).status).toBe(201);
    const { sessionId } = await openSession(hostId);
    const socket = await openDaemonSocket(hostId, sessionId);

    expect(await pollUntil(async () => (await readHost(hostId))?.status === "connected")).toBe(
      true,
    );

    socket.close(1000, "test-done");
    expect(
      await pollUntil(async () => (await readHost(hostId))?.status === "disconnected"),
    ).toBe(true);
  });

  it("heartbeat refreshes last_seen_at; fresh stamps stay throttled", async () => {
    const hostId = "local-liveness-heartbeat";
    expect((await enroll(hostId)).status).toBe(201);
    // The attach bridge (#49) stamps last_seen_at = now at open.
    const { sessionId } = await openSession(hostId);
    const socket = await openDaemonSocket(hostId, sessionId);

    // Within the projection window a heartbeat is a no-op (SQL guard).
    const fresh = await storedLastSeenAt(hostId);
    if (fresh === null) throw new Error("attach bridge did not stamp last_seen_at");
    socket.send(JSON.stringify({ type: "heartbeat" }));
    await settle(500);
    expect(await storedLastSeenAt(hostId)).toBe(fresh);

    // Stale stamp past the window: the same heartbeat path advances it
    // (bb markHostSeen), and the advance lands in /hosts too.
    const stale = fresh - LIVENESS_PROJECTION_INTERVAL_MS - 1_000;
    await backdateLastSeenAt(hostId, stale);
    socket.send(JSON.stringify({ type: "heartbeat" }));
    expect(await pollUntil(async () => (await storedLastSeenAt(hostId)) !== stale)).toBe(true);
    const advanced = await storedLastSeenAt(hostId);
    if (advanced === null) throw new Error("liveness stamp missing after heartbeat");
    expect(advanced).toBeGreaterThan(stale);
    expect(await pollUntil(async () => (await readHost(hostId))?.lastSeenAt === advanced)).toBe(
      true,
    );

    socket.close(1000, "test-done");
  });
});
