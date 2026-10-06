import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { apiGet, BASE, TEST_ENROLL_KEY, TEST_HOST_KEY } from "../helpers.js";
import { hostSchema } from "../../src/contract/domain/host.js";

/**
 * #193 S1: the daemon-service DO's host-change moments wired into the hub —
 * bb registerDaemon (hub.ts:456-476: cancel pending disconnect, register,
 * broadcast) and handleDaemonSocketClosed (session-owner-side-effects.ts:
 * 134-176: only the active session's close broadcasts + schedules grace).
 * The vitest pool cannot deliver server→client frames (compat/c4-ws FIXME),
 * so the wiring is asserted through the hub's daemon-disconnect state, the
 * only RPC-observable record the DO's markDaemon* calls leave: attach must
 * CANCEL a seeded grace, a replaced session's late close must NOT arm it,
 * and the live session's close must.
 */
beforeAll(ensureMigrations);

/** Drives the composed daemon face exactly like packages/daemon-service's client. */
async function enroll(hostId: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey: TEST_ENROLL_KEY, hostId }),
  });
}

interface OpenedSession {
  sessionId: string;
}

async function openSession(hostId: string): Promise<OpenedSession> {
  const response = await exports.default.fetch(`${BASE}/session/open`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_HOST_KEY}` },
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

interface HubHostRpc {
  markDaemonConnected(args: { hostId: string }): Promise<{ ok: true }>;
  markDaemonDisconnected(args: { hostId: string }): Promise<{ ok: true }>;
  getDaemonDisconnectState(args: { hostId: string }): Promise<{
    inGrace: boolean;
    graceExpiresAt: number | null;
  }>;
}

function hub(): HubHostRpc {
  return env.HUB.get(env.HUB.idFromName("hub"));
}

/**
 * Integration wait on the remote DO's clock: the broadcast happens inside
 * the workers runtime (fire-and-forget from the daemon-service DO into the
 * hub DO), where fake timers cannot reach — poll the real clock until the
 * hub state lands (host-liveness.test.ts precedent).
 */
async function pollUntil(probe: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    const { promise, resolve } = Promise.withResolvers<undefined>();
    setTimeout(resolve, 100);
    await promise;
  }
}

/** Fixed settle for a negative assertion: give the DO a beat to (not) act. */
async function settle(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, ms);
  await promise;
}

describe("host broadcast wiring (#193 S1)", () => {
  it("attach broadcasts host-connected: a seeded disconnect grace is cancelled", async () => {
    const hostId = "local-broadcast-attach";
    expect((await enroll(hostId)).status).toBe(201);
    const { sessionId } = await openSession(hostId);

    // Seed the exact state registerDaemon's first line erases
    // (cancelPendingDaemonDisconnect, hub.ts:457) — via the hub RPC the DO
    // bridge itself uses.
    await hub().markDaemonDisconnected({ hostId });
    expect((await hub().getDaemonDisconnectState({ hostId })).inGrace).toBe(true);

    await openDaemonSocket(hostId, sessionId);
    expect(
      await pollUntil(async () => !(await hub().getDaemonDisconnectState({ hostId })).inGrace),
    ).toBe(true);
  });

  it("replace leaves no spurious disconnect; only the live close arms the grace", async () => {
    const hostId = "local-broadcast-replace";
    expect((await enroll(hostId)).status).toBe(201);
    const first = await openSession(hostId);
    const socketA = await openDaemonSocket(hostId, first.sessionId);

    // 顶替 (§5.2.5): a second session/open closes A's socket; the new attach
    // broadcasts host-connected. A's late close event must be a no-op for
    // the broadcast (bb reads the old session's status, :147-149) — the
    // grace stays unarmed, then the LIVE socket's close arms it.
    const second = await openSession(hostId);
    const socketB = await openDaemonSocket(hostId, second.sessionId);
    await settle(750);
    expect((await hub().getDaemonDisconnectState({ hostId })).inGrace).toBe(false);

    socketB.close(1000, "test-done");
    expect(
      await pollUntil(async () => (await hub().getDaemonDisconnectState({ hostId })).inGrace),
    ).toBe(true);

    // A was replaced server-side; its client-side peer may already be closed.
    try {
      socketA.close(1000, "test-done");
    } catch {
      // already closed by the replacement
    }
  });

  it("close of the live socket arms the hub grace exactly once per disconnect", async () => {
    const hostId = "local-broadcast-close";
    expect((await enroll(hostId)).status).toBe(201);
    const { sessionId } = await openSession(hostId);
    const socket = await openDaemonSocket(hostId, sessionId);
    await settle(500);
    expect((await hub().getDaemonDisconnectState({ hostId })).inGrace).toBe(false);

    socket.close(1000, "test-done");
    expect(
      await pollUntil(async () => (await hub().getDaemonDisconnectState({ hostId })).inGrace),
    ).toBe(true);
  });
});

describe("host route moments (#193 S1)", () => {
  // The pool cannot surface server→client frames (probe: hub counted
  // delivered:1, client got null), so the routes' notifyHost fan-out is
  // pinned at the hub surface (unit/hub-host.test.ts); these drive each
  // route moment end-to-end — the awaited notifyHost RPC must complete or
  // the request itself fails.

  it("rename PATCH succeeds over the connection-change path", async () => {
    const hostId = "local-route-rename";
    expect((await enroll(hostId)).status).toBe(201);

    const response = await exports.default.fetch(`${BASE}/api/v1/hosts/${hostId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed-via-s1" }),
    });
    expect(response.status).toBe(200);
    const listing = await apiGet("/api/v1/hosts");
    const body = await listing.json<unknown[]>();
    const host = body.map((entry) => hostSchema.parse(entry)).find((row) => row.id === hostId);
    expect(host?.name).toBe("renamed-via-s1");
  });

  it("permission-ceiling PATCH succeeds over the same path", async () => {
    const hostId = "local-route-ceiling";
    expect((await enroll(hostId)).status).toBe(201);

    const response = await exports.default.fetch(
      `${BASE}/api/v1/hosts/${hostId}/permission-ceiling`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxPermissionMode: "accept-edits" }),
      },
    );
    expect(response.status).toBe(200);
    const listing = await apiGet("/api/v1/hosts");
    const body = await listing.json<unknown[]>();
    const host = body.map((entry) => hostSchema.parse(entry)).find((row) => row.id === hostId);
    expect(host?.maxPermissionMode).toBe("accept-edits");
  });

  it("DELETE soft-destroys: host leaves /hosts and re-DELETE 404s", async () => {
    const hostId = "local-route-delete";
    expect((await enroll(hostId)).status).toBe(201);
    // #386: real machines are always deletable — the removal guard anchors
    // on the seeded cloud placeholder row, not on a lone real host.

    const response = await exports.default.fetch(`${BASE}/api/v1/hosts/${hostId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);

    const listing = await apiGet("/api/v1/hosts");
    const body = await listing.json<unknown[]>();
    expect(body.some((entry) => hostSchema.parse(entry).id === hostId)).toBe(false);

    const row = await env.DB.prepare("SELECT destroyed_at FROM hosts WHERE id = ?")
      .bind(hostId)
      .first<{ destroyed_at: number | null }>();
    expect(row?.destroyed_at).not.toBeNull();

    const repeat = await exports.default.fetch(`${BASE}/api/v1/hosts/${hostId}`, {
      method: "DELETE",
    });
    expect(repeat.status).toBe(404);
  });
});
