import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { apiGet } from "../helpers.js";

/**
 * #302: GET /hosts/:id/directory — the Add-project path browser's listing,
 * the route whose absence surfaced as the dialog's inline "Route not found".
 * The success path (a live daemon answering host-rpc.request) cannot run in
 * this pool — server→client frames never reach the in-isolate socket
 * (compat/c4-ws FIXME) — so the roundtrip is pinned at L1
 * (packages/daemon-service l1-host-directory) and these tests pin the
 * route's error contract: the exact shapes bb's assertUsableHostId +
 * online-rpc mapping produce (routes/hosts.ts:221-233 + online-rpc.ts:
 * 153-167), which is what the SPA's RemotePathBrowser branches on.
 */
beforeAll(async () => {
  await apiGet("/api/v1/hosts");
});

async function seedHostRow(hostId: string, destroyedAt: number | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at,
                        last_seen_at, last_rejected_protocol_version, created_at, updated_at)
     VALUES (?, ?, 'persistent', NULL, 'full', ?, NULL, NULL, ?, ?)`,
  )
    .bind(hostId, hostId, destroyedAt, Date.now(), Date.now())
    .run();
}

describe("GET /hosts/:id/directory (#302)", () => {
  it("404s an unknown host with bb's host_not_found shape", async () => {
    const response = await apiGet("/api/v1/hosts/host_dir_missing/directory");
    expect(response.status).toBe(404);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("host_not_found");
    expect(body.message).toBe("Host not found");
  });

  it("404s a destroyed host with the read-face tombstone shape (G12)", async () => {
    await seedHostRow("host_dir_destroyed", Date.now());
    const response = await apiGet("/api/v1/hosts/host_dir_destroyed/directory");
    expect(response.status).toBe(404);
    const body = await response.json<{
      code: string;
      details: { reason: string; destroyedAt: number };
    }>();
    expect(body.code).toBe("host_unavailable");
    expect(body.details.reason).toBe("destroyed");
  });

  it("502s host_unavailable for an enrolled host with no live daemon", async () => {
    await seedHostRow("host_dir_offline", null);
    const response = await apiGet("/api/v1/hosts/host_dir_offline/directory");
    expect(response.status).toBe(502);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("host_unavailable");
    expect(body.message).toBe("Host is not connected");
  });

  it("422s a blank path query instead of forwarding it to the daemon", async () => {
    await seedHostRow("host_dir_query", null);
    const response = await apiGet("/api/v1/hosts/host_dir_query/directory?path=");
    expect(response.status).toBe(422);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("validation_failed");
  });
});
