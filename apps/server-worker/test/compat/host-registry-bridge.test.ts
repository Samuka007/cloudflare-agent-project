import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { hostSchema } from "../../src/contract/domain/host.js";
import { BASE, apiGet } from "../helpers.js";

/**
 * #49 bridge: the daemon client's attach handshake (daemon-service /enroll +
 * /session/open, served by the composed daemon face) must land the host in
 * the control-plane registry, so GET /api/v1/hosts lists it and the SPA's
 * composer unlocks. This is the exact seam the census found dead: the daemon
 * attached while /hosts returned [].
 */
beforeAll(ensureMigrations);

/** Drives the composed daemon face exactly like packages/daemon-service's client. */
async function enroll(hostId: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey: "poc-dev-enroll-key", hostId }),
  });
}

async function openSession(hostId: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/session/open`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer poc-dev-host-key",
    },
    body: JSON.stringify({ hostId, bootId: `boot_${hostId}`, protocolVersion: 1 }),
  });
}

async function listedHostIds(): Promise<string[]> {
  const response = await apiGet("/api/v1/hosts");
  expect(response.status).toBe(200);
  const body = await response.json<unknown[]>();
  return body.map((entry) => hostSchema.parse(entry).id);
}

describe("daemon attach → /hosts registry bridge (#49)", () => {
  it("enroll makes the host visible via /hosts", async () => {
    const hostId = "local-bridge-enroll";
    const enrollResponse = await enroll(hostId);
    expect(enrollResponse.status).toBe(201);

    const response = await apiGet("/api/v1/hosts");
    const body = await response.json<unknown[]>();
    const row = body.find((entry) => hostSchema.parse(entry).id === hostId);
    expect(row).toBeDefined();
    const host = hostSchema.parse(row);
    // bb list shape: registry entry stays even while its daemon is between
    // sessions; no daemon socket attaches in this test, so the derived
    // status reads disconnected (#62, entity-lookup.ts toHostStatus).
    expect(host.status).toBe("disconnected");
    expect(host.type).toBe("persistent");
    expect(host.lastSeenAt).not.toBeNull();
  });

  it("session/open alone (skipped enroll) also registers the host, idempotently", async () => {
    const hostId = "local-bridge-open";
    expect((await openSession(hostId)).status).toBe(201);
    expect((await openSession(hostId)).status).toBe(201);
    expect(await listedHostIds()).toContain(hostId);
  });

  it("attach refreshes last_seen_at without touching owner-owned fields", async () => {
    const hostId = "local-bridge-refresh";
    expect((await enroll(hostId)).status).toBe(201);
    await env.DB.prepare("UPDATE hosts SET name = 'renamed', max_permission_mode = 'accept-edits' WHERE id = ?")
      .bind(hostId)
      .run();

    expect((await openSession(hostId)).status).toBe(201);
    const response = await apiGet("/api/v1/hosts");
    const body = await response.json<unknown[]>();
    const host = hostSchema.parse(body.find((entry) => hostSchema.parse(entry).id === hostId));
    expect(host.name).toBe("renamed");
    expect(host.maxPermissionMode).toBe("accept-edits");
  });

  it("never resurrects a destroyed host", async () => {
    const hostId = "local-bridge-destroyed";
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at,
                          last_seen_at, last_rejected_protocol_version, created_at, updated_at)
       VALUES (?, 'gone', 'persistent', NULL, 'full', ?, NULL, NULL, ?, ?)`,
    )
      .bind(hostId, now, now, now)
      .run();

    expect((await enroll(hostId)).status).toBe(201);
    expect((await openSession(hostId)).status).toBe(201);
    expect(await listedHostIds()).not.toContain(hostId);
  });
});
