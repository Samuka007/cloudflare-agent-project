import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { apiGet, BASE } from "../helpers.js";
import { hostSchema } from "../../src/contract/domain/host.js";

/**
 * #195 S3/S4: host identity + protocol-upgrade data face (G4/G5/G7/G12) and
 * the delete terminal (G11) — bb anchors in each test. S5's provider-clis
 * path unification is pinned in m1-ux-fixes.test.ts; S6/S7 are adjudications
 * recorded in docs/research/bb-host-surface.md §8 (no code).
 */
beforeAll(ensureMigrations);

async function enroll(hostId: string, hostName?: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey: "[REDACTED-staging-secret]", hostId, hostName }),
  });
}

interface OpenedSession {
  sessionId: string;
}

/** Raw open so a test can drive mismatched protocolVersions. */
async function openSessionRaw(hostId: string, body: Record<string, unknown>): Promise<Response> {
  return exports.default.fetch(`${BASE}/session/open`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer [REDACTED-staging-secret]" },
    body: JSON.stringify({ hostId, bootId: `boot_${hostId}`, protocolVersion: 1, ...body }),
  });
}

async function openSession(hostId: string): Promise<OpenedSession> {
  const response = await openSessionRaw(hostId, {});
  expect(response.status).toBe(201);
  return await response.json<OpenedSession>();
}

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

function daemonStub(hostId: string): DurableObjectStub & {
  hostLiveness(args: { hostId: string }): Promise<{ connected: boolean }>;
  closeSession(args: { hostId: string; reason: string }): Promise<{ closed: boolean }>;
} {
  return env.DAEMON_SERVICE.get(env.DAEMON_SERVICE.idFromName(hostId));
}

/**
 * Integration wait on the remote DO's clock: the server-initiated close runs
 * inside the workers runtime (fire-and-forget from the DELETE route into the
 * daemon-service DO), where fake timers cannot reach — poll the real clock
 * until the DO's liveness lands (host-broadcast.test.ts precedent). The rule
 * exception applies: this deliberately exercises the platform clock.
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

async function hostRow(hostId: string) {
  const listing = await apiGet(`/api/v1/hosts/${hostId}`);
  expect(listing.status).toBe(200);
  return hostSchema.parse(await listing.json<object>());
}

async function retryUpdate(hostId: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/api/v1/hosts/${hostId}/retry-update`, {
    method: "POST",
  });
}

function hub(): {
  requestHostProtocolUpdateRetry(args: { hostId: string }): Promise<{ ok: true }>;
} {
  return env.HUB.get(env.HUB.idFromName("hub"));
}

describe("host identity: daemon hostname capture (#195 S3, G4)", () => {
  it("the registry names the host from the daemon's self-reported hostname", async () => {
    const hostId = "local-s3-name";
    // bb writes the hostname at enroll (internal/hosts.ts:110) and again at
    // the first session/open (internal/session.ts:93) — insert-if-absent.
    expect((await enroll(hostId, "zeta-workstation")).status).toBe(201);
    await openSessionRaw(hostId, { hostName: "zeta-workstation" });
    expect((await hostRow(hostId)).name).toBe("zeta-workstation");
  });

  it("owner rename survives a re-dial (bb keeps the existing row's name)", async () => {
    const hostId = "local-s3-rename";
    expect((await enroll(hostId)).status).toBe(201);
    await openSessionRaw(hostId, { hostName: "zeta-rename" });

    const patch = await exports.default.fetch(`${BASE}/api/v1/hosts/${hostId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "owner-named" }),
    });
    expect(patch.status).toBe(200);

    // bb upsertHost (data/hosts.ts:70-91): an existing row's name is not in
    // the update set, so the daemon reporting the same hostname again never
    // clobbers the owner's rename.
    await openSession(hostId);
    expect((await hostRow(hostId)).name).toBe("owner-named");
  });
});

describe("protocol upgrade face: lastRejectedProtocolVersion + retry-update (#195 S3, G5/G7)", () => {
  const hostId = "local-s3-upgrade";

  it("mismatch stamps the daemon version and answers the bb 400 details", async () => {
    expect((await enroll(hostId)).status).toBe(201);
    const rejected = await openSessionRaw(hostId, { protocolVersion: 2 });
    expect(rejected.status).toBe(400);
    const body = await rejected.json<{
      code: string;
      details: {
        expected: number;
        received: number;
        retryUpdate: boolean;
        serverProtocolVersion: number;
      };
    }>();
    expect(body.code).toBe("protocol_version_mismatch");
    // bb internal/session.ts:66-76 shape (expected/received is the M0
    // scheme-A extra); retryUpdate starts unarmed. Version 2 = a newer
    // daemon — the ported host schema requires positive versions (bb
    // domain/src/host.ts), so 0 is not a storable rejection.
    expect(body.details).toMatchObject({
      expected: 1,
      received: 2,
      retryUpdate: false,
      serverProtocolVersion: 1,
    });
    expect((await hostRow(hostId)).lastRejectedProtocolVersion).toBe(2);
  });

  it("retry-update gates: not_needed, then armed retry consumed by the next mismatch", async () => {
    // Gate 1: nothing rejected → 409 host_update_not_needed (routes/hosts.ts:170-176).
    const fresh = "local-s3-upgrade-fresh";
    expect((await enroll(fresh)).status).toBe(201);
    const notNeeded = await retryUpdate(fresh);
    expect(notNeeded.status).toBe(409);
    expect((await notNeeded.json<{ code: string }>()).code).toBe("host_update_not_needed");

    // The retryable arm (rejected < server) is structurally unreachable at
    // M0: any mismatching version is ≥ 1 = DAEMON_PROTOCOL_VERSION, so the
    // route would answer host_cannot_self_update. The arm → consume circuit
    // is exercised at the hub surface instead (bb hub.ts:851-860).
    await hub().requestHostProtocolUpdateRetry({ hostId: fresh });

    // bb internal/session.ts:56: the rejected handshake consumes the flag
    // and reports it to the daemon in the 400 details.
    const rejected = await openSessionRaw(fresh, { protocolVersion: 2 });
    expect(rejected.status).toBe(400);
    const body = await rejected.json<{ details: { retryUpdate: boolean } }>();
    expect(body.details.retryUpdate).toBe(true);

    // The flag is take-semantics: a third mismatch reports false again.
    const again = await openSessionRaw(fresh, { protocolVersion: 2 });
    expect((await again.json<{ details: { retryUpdate: boolean } }>()).details.retryUpdate).toBe(
      false,
    );
  });

  it("a daemon newer than the server cannot self-update (gate 2)", async () => {
    // rejected 2 >= server 1 → 409 host_cannot_self_update
    // (routes/hosts.ts:177-183).
    const newer = await openSessionRaw(hostId, { protocolVersion: 2 });
    expect(newer.status).toBe(400);
    const blocked = await retryUpdate(hostId);
    expect(blocked.status).toBe(409);
    expect((await blocked.json<{ code: string }>()).code).toBe("host_cannot_self_update");
  });

  it("a successful open clears the rejection (bb internal/session.ts:96-98)", async () => {
    await openSession(hostId);
    expect((await hostRow(hostId)).lastRejectedProtocolVersion).toBeNull();
  });
});

describe("delete terminal (#195 S4, G11) + destroyed 404 shape (G12)", () => {
  // The removal guard reads the whole fleet, so earlier describes' hosts
  // would crowd the "lone real host" setup — these tests wipe the registry
  // first (test rig only; production never wipes). #386: the wipe preserves
  // the seeded cloud placeholder — the row the guard anchors on; production
  // can never reach a placeholder-less fleet.
  async function wipeHosts(): Promise<void> {
    await env.DB.prepare("DELETE FROM hosts WHERE id <> 'cloud'").run();
  }

  it("DELETE of the placeholder refuses with the empty-machine judgment (#386)", async () => {
    await wipeHosts();
    const refused = await exports.default.fetch(`${BASE}/api/v1/hosts/cloud`, {
      method: "DELETE",
    });
    expect(refused.status).toBe(400);
    const body = await refused.json<{ code: string; message: string }>();
    expect(body.code).toBe("placeholder_host_removal_refused");
    expect(body.message).toBe("placeholder holds empty-machine semantics");
    const row = await env.DB.prepare("SELECT destroyed_at FROM hosts WHERE id = 'cloud'").first<{
      destroyed_at: number | null;
    }>();
    expect(row?.destroyed_at).toBeNull();
  });

  it("a lone real host is deletable — the guard no longer anchors real machines (#386)", async () => {
    await wipeHosts();
    const hostId = "local-s4-primary";
    expect((await enroll(hostId)).status).toBe(201);
    const response = await exports.default.fetch(`${BASE}/api/v1/hosts/${hostId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    // The fleet fell back to the placeholder with its semantics intact.
    const listing = await apiGet("/api/v1/hosts");
    const body = await listing.json<unknown[]>();
    expect(body.map((entry) => hostSchema.parse(entry).id)).toEqual(["cloud"]);
  });

  it("delete closes the live DO session, then tombstones", async () => {
    await wipeHosts();
    const hostId = "local-s4-terminal";
    expect((await enroll(hostId)).status).toBe(201);
    // The anchor host keeps the DO-session close observable from a still-
    // attached machine; under #386 both are deletable regardless.
    expect((await enroll("local-s4-terminal-anchor")).status).toBe(201);
    const anchor = await openSession("local-s4-terminal-anchor");
    const anchorSocket = await openDaemonSocket("local-s4-terminal-anchor", anchor.sessionId);

    const { sessionId } = await openSession(hostId);
    const socket = await openDaemonSocket(hostId, sessionId);
    expect((await daemonStub(hostId).hostLiveness({ hostId })).connected).toBe(true);

    const response = await exports.default.fetch(`${BASE}/api/v1/hosts/${hostId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);

    // The DO socket is closed server-side: liveness flips without any
    // client-side close (bb handleHostRemoved closeDaemonSession). The
    // bb revoke step (routes/hosts.ts:200-203) has no per-host credential
    // to act on in the POC key model — recorded as the S4 divergence.
    expect(
      await pollUntil(async () => !(await daemonStub(hostId).hostLiveness({ hostId })).connected),
    ).toBe(true);
    try {
      socket.close(1000, "test-done");
    } catch {
      // the server-initiated close already tore the socket down
    }
    const row = await env.DB.prepare("SELECT destroyed_at FROM hosts WHERE id = ?")
      .bind(hostId)
      .first<{ destroyed_at: number | null }>();
    expect(row?.destroyed_at).not.toBeNull();
    try {
      anchorSocket.close(1000, "test-done");
    } catch {
      // anchor socket teardown
    }
    const listing = await apiGet("/api/v1/hosts");
    const body = await listing.json<unknown[]>();
    expect(body.some((entry) => hostSchema.parse(entry).id === hostId)).toBe(false);
  });

  it("destroyed host GET answers host_unavailable with the bb details (G12)", async () => {
    const hostId = "local-s4-terminal";
    const response = await apiGet(`/api/v1/hosts/${hostId}`);
    expect(response.status).toBe(404);
    const body = await response.json<{
      code: string;
      message: string;
      details: {
        reason: string;
        hostStatus: string | null;
        suspendedAt: number | null;
        destroyedAt: number;
      };
    }>();
    // bb entity-lookup.ts:123-129 + lifecycle-api-errors.ts:149-158.
    expect(body.code).toBe("host_unavailable");
    expect(body.message).toBe("Host is unavailable");
    expect(body.details.reason).toBe("destroyed");
    expect(body.details.hostStatus).toBeNull();
    expect(body.details.suspendedAt).toBeNull();
    expect(typeof body.details.destroyedAt).toBe("number");
  });

  it("the last real host is deletable too; the fleet then is the placeholder alone", async () => {
    const response = await exports.default.fetch(`${BASE}/api/v1/hosts/local-s4-terminal-anchor`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    const listing = await apiGet("/api/v1/hosts");
    const body = await listing.json<unknown[]>();
    expect(body.map((entry) => hostSchema.parse(entry).id)).toEqual(["cloud"]);
  });

  it("mutation routes answer a destroyed host with plain host_not_found (bb requireMutableHost)", async () => {
    const patch = await exports.default.fetch(`${BASE}/api/v1/hosts/local-s4-terminal`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "after-death" }),
    });
    expect(patch.status).toBe(404);
    expect((await patch.json<{ code: string }>()).code).toBe("host_not_found");
  });
});
