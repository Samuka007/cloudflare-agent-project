import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { createThread, send } from "../helpers.js";
import { threadResponseSchema } from "../../src/contract/api/threads.js";
import type { ThreadDbRow } from "../../src/db/rows.js";
import {
  resolveThreadRuntimeState,
  type HostRuntimeSnapshot,
} from "../../src/services/runtime-display.js";
import { DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS } from "../../src/ws/hub.js";

/**
 * #194 S2: the thread runtime display is honest about the attached host.
 * The M0 topology (PM ruling) binds every thread's session to the single
 * attached daemon (ORCHESTRATOR_HOST_ID, "local" composed), so an active
 * thread's display derives from one host fact per request — bb
 * resolveThreadRuntimeStateFromLatestSession (thread-runtime-display.ts:
 * 194-221) reduced to HostRuntimeSnapshot. L2 three states: connected
 * echoes "active" (no banner — the old hardcoded waiting-for-host lie at
 * services/runtime-display.ts:18-23), a drop inside the hub's 30s grace
 * reads "host-reconnecting" with the countdown, past it
 * "waiting-for-host". The daemon-side moments feeding the hub are S1's
 * (#193) wiring; here the display consumption is exercised end-to-end.
 */
beforeAll(ensureMigrations);

const HOST_ID = "local";

/** Drives the composed daemon face exactly like the daemon client. */
async function enroll(hostId: string): Promise<Response> {
  return exports.default.fetch("https://example.com/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey: "[REDACTED-staging-secret]", hostId }),
  });
}

async function openSession(hostId: string): Promise<{ sessionId: string }> {
  const response = await exports.default.fetch("https://example.com/session/open", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer [REDACTED-staging-secret]" },
    body: JSON.stringify({ hostId, bootId: `boot_${hostId}`, protocolVersion: 1 }),
  });
  expect(response.status).toBe(201);
  return await response.json<{ sessionId: string }>();
}

/** WS attach straight into the per-host DO (pool's SELF WS gap, host-liveness idiom). */
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

interface HubRuntimeRpc {
  getDaemonDisconnectState(args: {
    hostId: string;
  }): Promise<{ inGrace: boolean; graceExpiresAt: number | null }>;
  markDaemonConnected(args: { hostId: string }): Promise<{ ok: true }>;
}

/** Test seam over the hub DO's runtime state (four call sites, typed RPC). */
function hub(): HubRuntimeRpc {
  return env.HUB.get(env.HUB.idFromName("hub"));
}

/**
 * Real-clock poll, not fake timers (host-liveness.test.ts precedent): the
 * arming happens inside the workers-runtime DO (webSocketClose → fire-and-
 * forget hub RPC), where vi/fake timers cannot reach — the platform clock
 * is the only observable wait surface, and there is no client-visible
 * signal to await instead.
 */
async function pollUntil(probe: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function readThread(id: string) {
  const detail = await exports.default.fetch(`https://example.com/api/v1/threads/${id}`);
  expect(detail.status).toBe(200);
  return threadResponseSchema.parse(await detail.json());
}

describe("#194 resolver mapping (bb thread-runtime-display.ts:96-108, 194-221)", () => {
  // The resolver reads only the row's status; the rest of the row is inert here.
  const row = (status: ThreadDbRow["status"]) => ({ status }) as ThreadDbRow;

  it("active + connected host echoes active with no banner instant", () => {
    expect(
      resolveThreadRuntimeState(row("active"), { connected: true, graceExpiresAt: null }),
    ).toEqual({ displayStatus: "active", hostReconnectGraceExpiresAt: null });
  });

  it("active + drop inside the grace reads host-reconnecting with the countdown", () => {
    const expiresAt = Date.now() + DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS;
    expect(
      resolveThreadRuntimeState(row("active"), { connected: false, graceExpiresAt: expiresAt }),
    ).toEqual({ displayStatus: "host-reconnecting", hostReconnectGraceExpiresAt: expiresAt });
  });

  it("active + drop past the grace reads waiting-for-host", () => {
    expect(
      resolveThreadRuntimeState(row("active"), { connected: false, graceExpiresAt: null }),
    ).toEqual({ displayStatus: "waiting-for-host", hostReconnectGraceExpiresAt: null });
  });

  it("non-active statuses echo themselves verbatim regardless of the host", () => {
    for (const status of ["idle", "starting", "stopping", "error"] as const) {
      for (const host of [
        { connected: true, graceExpiresAt: null },
        { connected: false, graceExpiresAt: Date.now() },
        { connected: false, graceExpiresAt: null },
      ] satisfies HostRuntimeSnapshot[]) {
        expect(resolveThreadRuntimeState(row(status), host)).toEqual({
          displayStatus: status,
          hostReconnectGraceExpiresAt: null,
        });
      }
    }
  });
});

describe("#194 thread runtime host awareness (wiring)", () => {
  let socket: WebSocket | null = null;

  beforeAll(async () => {
    // Order-independence in the shared worker: nothing else in the suite may
    // have armed a grace on the composed host identity.
    await hub().markDaemonConnected({ hostId: HOST_ID });
  });

  afterAll(async () => {
    socket?.close(1000, "test-done");
    // Leave the shared hub clean: no lingering "local" grace for sibling files.
    await hub().markDaemonConnected({ hostId: HOST_ID });
  });

  it("no attached host: an active thread waits-for-host with no grace", async () => {
    const thread = await createThread({ title: "runtime-host-orphan" });
    await send(thread.id);
    const body = await readThread(thread.id);
    expect(body.status).toBe("active");
    expect(body.runtime.displayStatus).toBe("waiting-for-host");
    expect(body.runtime.hostReconnectGraceExpiresAt).toBeNull();
  });

  it("attached host: the active thread echoes active — no banner", async () => {
    expect((await enroll(HOST_ID)).status).toBe(201);
    const { sessionId } = await openSession(HOST_ID);
    socket = await openDaemonSocket(HOST_ID, sessionId);
    // The register-before-broadcast order (S1) means the hub state and the DO
    // liveness agree by the time the attach fetch resolves.
    const thread = await createThread({ title: "runtime-host-live" });
    await send(thread.id);
    const body = await readThread(thread.id);
    expect(body.status).toBe("active");
    expect(body.runtime.displayStatus).toBe("active");
    expect(body.runtime.hostReconnectGraceExpiresAt).toBeNull();
  });

  it("drop inside the 30s grace: host-reconnecting with a 30s countdown", async () => {
    if (socket === null) throw new Error("attach did not leave a socket");
    socket.close(1000, "test-done");
    expect(
      await pollUntil(
        async () => (await hub().getDaemonDisconnectState({ hostId: HOST_ID })).inGrace,
      ),
    ).toBe(true);

    // A fresh row ("starting") next to the dropped host: the echo path
    // ignores the host entirely.
    const fresh = await readThread((await createThread({ title: "runtime-host-echo" })).id);
    expect(fresh.status).toBe("starting");
    expect(fresh.runtime.displayStatus).toBe("starting");
    expect(fresh.runtime.hostReconnectGraceExpiresAt).toBeNull();

    // The active row shows the reconnecting banner with the countdown —
    // pinned above 20s so the pre-G3 5s constant cannot pass.
    const graceThread = await createThread({ title: "runtime-host-grace-active" });
    await send(graceThread.id);
    const graceBody = await readThread(graceThread.id);
    expect(graceBody.runtime.displayStatus).toBe("host-reconnecting");
    const now = Date.now();
    const expiresAt = graceBody.runtime.hostReconnectGraceExpiresAt;
    // Narrowing guard, not an assertion (repo lint): a null here would mean
    // the hub answered inGrace without an expiry.
    if (expiresAt === null) throw new Error("grace expiry missing on host-reconnecting display");
    expect(expiresAt).toBeGreaterThan(now + 20_000);
    expect(expiresAt).toBeLessThanOrEqual(now + DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS + 5_000);
  });

  it("recovery clears the banner: active returns", async () => {
    const reopened = await openSession(HOST_ID);
    socket = await openDaemonSocket(HOST_ID, reopened.sessionId);
    const thread = await createThread({ title: "runtime-host-recovered" });
    await send(thread.id);
    const body = await readThread(thread.id);
    expect(body.runtime.displayStatus).toBe("active");
    expect(body.runtime.hostReconnectGraceExpiresAt).toBeNull();
  });
});
