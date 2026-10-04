import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { createThread, send } from "../helpers.js";
import { threadResponseSchema } from "../../src/contract/api/threads.js";
import type { ThreadDbRow } from "../../src/db/rows.js";
import { resolveThreadRuntimeState } from "../../src/services/runtime-display.js";

/**
 * #148: the thread runtime display never preempts an in-flight turn with a
 * host banner (streaming contract §9.3 — the banner's only legitimate source
 * is "no active turn ∧ runtime host offline"; 活跃 turn 期间横幅恒 ✗). Under
 * #73 execution suspension a turn keeps streaming pure chat while the host is
 * down, so `resolveThreadRuntimeState` echoes the row's execution status
 * verbatim; the #194 S2 host-aware branch (active + host-down →
 * host-reconnecting / waiting-for-host — the thr_jk45qe4786
 * banner-during-streaming repro) is gone. The hub grace state machine itself
 * stays (#193 S1 producers; covered by host-broadcast.test.ts) and the §9.3
 * row-4 post-turn host face lands with the bb-side S6 slice together with its
 * SPA follow-up queue/submit gate, reconciled with 消息可发.
 */
beforeAll(ensureMigrations);

const HOST_ID = "local";

/** Drives the composed daemon face exactly like the daemon client. */
async function enroll(hostId: string): Promise<Response> {
  return exports.default.fetch("https://example.com/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey: "poc-dev-enroll-key", hostId }),
  });
}

async function openSession(hostId: string): Promise<{ sessionId: string }> {
  const response = await exports.default.fetch("https://example.com/session/open", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer poc-dev-host-key" },
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

describe("#148 resolver mapping (echo-only display, §9.3)", () => {
  // The resolver reads only the row's status; the rest of the row is inert here.
  const row = (status: ThreadDbRow["status"]) => ({ status }) as ThreadDbRow;

  it("every status echoes itself — an active turn never renders a host banner", () => {
    for (const status of ["active", "idle", "starting", "stopping", "error"] as const) {
      expect(resolveThreadRuntimeState(row(status))).toEqual({
        displayStatus: status,
        hostReconnectGraceExpiresAt: null,
      });
    }
  });
});

describe("#148 wiring: an in-flight turn never banners, host state notwithstanding", () => {
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

  it("no attached host: the active thread reads active — no waiting-for-host banner", async () => {
    const thread = await createThread({ title: "runtime-host-orphan" });
    await send(thread.id);
    const body = await readThread(thread.id);
    expect(body.status).toBe("active");
    // #148 regression guard: #194's resolver read waiting-for-host here —
    // the banner that preempted the streaming face on thr_jk45qe4786.
    expect(body.runtime.displayStatus).toBe("active");
    expect(body.runtime.hostReconnectGraceExpiresAt).toBeNull();
  });

  it("attached host: the active thread echoes active", async () => {
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

  it("drop inside the 30s grace: the active row still reads active — no host-reconnecting banner", async () => {
    if (socket === null) throw new Error("attach did not leave a socket");
    socket.close(1000, "test-done");
    // The grace really armed on the hub — the display must ignore it anyway.
    expect(
      await pollUntil(
        async () => (await hub().getDaemonDisconnectState({ hostId: HOST_ID })).inGrace,
      ),
    ).toBe(true);

    // A fresh row ("starting") echoes itself — the echo path is status-only.
    const fresh = await readThread((await createThread({ title: "runtime-host-echo" })).id);
    expect(fresh.status).toBe("starting");
    expect(fresh.runtime.displayStatus).toBe("starting");
    expect(fresh.runtime.hostReconnectGraceExpiresAt).toBeNull();

    // The active row keeps the loading face while the host is mid-grace —
    // #194's resolver read host-reconnecting with the countdown here.
    const graceThread = await createThread({ title: "runtime-host-grace-active" });
    await send(graceThread.id);
    const graceBody = await readThread(graceThread.id);
    expect(graceBody.status).toBe("active");
    expect(graceBody.runtime.displayStatus).toBe("active");
    expect(graceBody.runtime.hostReconnectGraceExpiresAt).toBeNull();
  });

  it("recovery: active still reads active", async () => {
    const reopened = await openSession(HOST_ID);
    socket = await openDaemonSocket(HOST_ID, reopened.sessionId);
    const thread = await createThread({ title: "runtime-host-recovered" });
    await send(thread.id);
    const body = await readThread(thread.id);
    expect(body.runtime.displayStatus).toBe("active");
    expect(body.runtime.hostReconnectGraceExpiresAt).toBeNull();
  });
});
