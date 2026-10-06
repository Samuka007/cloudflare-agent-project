import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import { ensureMigrations } from "../migrate.js";
import { hostSchema, type Host } from "../../src/contract/domain/host.js";
import { BASE, apiGet, createThread } from "../helpers.js";

/**
 * #386: the cloud placeholder is a REAL hosts row (migration 0004) — bb's
 * "must have one machine" invariant anchors on it, so the fleet is never
 * empty and every real machine stays deletable (the #377 rowless shape made
 * the guard anchor the last REAL host instead: lxc-stg-01 remove was refused
 * with "this machine runs bb and can not be removed"). The row carries
 * empty-machine semantics: explicit UI annotation, never connected, never a
 * heartbeat target (the id is reserved on the daemon seam), and a
 * placeholder-bound thread's host face answers the honest host_offline.
 */
beforeAll(ensureMigrations);

async function enroll(hostId: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey: "[REDACTED-staging-secret]", hostId }),
  });
}

function openSessionRaw(hostId: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/session/open`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer [REDACTED-staging-secret]" },
    body: JSON.stringify({ hostId, bootId: `boot_${hostId}`, protocolVersion: 1 }),
  });
}

async function listedHosts(): Promise<Host[]> {
  const response = await apiGet("/api/v1/hosts");
  expect(response.status).toBe(200);
  const body = await response.json<unknown[]>();
  return body.map((entry) => hostSchema.parse(entry));
}

async function deleteHost(hostId: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/api/v1/hosts/${hostId}`, { method: "DELETE" });
}

/** Test-rig only (the suite shares one D1): strip real machines so the
 * exact-fleet assertions see the fresh-deploy shape; the seeded placeholder
 * survives — production can never reach a placeholder-less fleet. */
async function wipeRealHosts(): Promise<void> {
  await env.DB.prepare("DELETE FROM hosts WHERE id <> 'cloud'").run();
}

describe("cloud placeholder host row (#386)", () => {
  it("a fresh fleet lists exactly the placeholder row with its annotation", async () => {
    await wipeRealHosts();
    const hosts = await listedHosts();
    expect(hosts.map((host) => host.id)).toEqual([CLOUD_PLACEHOLDER_HOST_ID]);
    const placeholder = hosts[0];
    if (placeholder === undefined) throw new Error("placeholder row missing");
    expect(placeholder.type).toBe("placeholder");
    expect(placeholder.status).toBe("disconnected");
    expect(placeholder.lastSeenAt).toBeNull();
    expect(placeholder.maxPermissionMode).toBe("full");
    // The UI annotation rides the name (the pinned SPA renders host.name).
    expect(placeholder.name).toContain("虚拟·W6 前不可执行");
  });

  it("the id is reserved on the daemon seam — the row never pretends online", async () => {
    const squatter = await enroll(CLOUD_PLACEHOLDER_HOST_ID);
    expect(squatter.status).toBe(422);
    const open = await openSessionRaw(CLOUD_PLACEHOLDER_HOST_ID);
    expect(open.status).toBe(422);
    // No DO session can exist for the id, so the row stays disconnected with
    // no last_seen_at (no heartbeat) and its type is untouched.
    const hosts = await listedHosts();
    const placeholder = hosts.find((host) => host.id === CLOUD_PLACEHOLDER_HOST_ID);
    expect(placeholder?.type).toBe("placeholder");
    expect(placeholder?.status).toBe("disconnected");
    expect(placeholder?.lastSeenAt).toBeNull();
  });

  it("every real machine is deletable; the fleet falls back to the placeholder and recovers", async () => {
    await wipeRealHosts();
    // lxc-stg-01 shape: the lone real machine, previously primary-protected.
    const only = "local-386-lone-machine";
    expect((await enroll(only)).status).toBe(201);
    expect((await deleteHost(only)).status).toBe(200);
    expect((await listedHosts()).map((host) => host.id)).toEqual([CLOUD_PLACEHOLDER_HOST_ID]);
    // 可重 enroll: a fresh machine onboards into the placeholder-anchored fleet.
    const replacement = "local-386-replacement";
    expect((await enroll(replacement)).status).toBe(201);
    expect((await deleteHost(replacement)).status).toBe(200);
    expect((await listedHosts()).map((host) => host.id)).toEqual([CLOUD_PLACEHOLDER_HOST_ID]);
  });

  it("a placeholder-bound thread's host face answers the honest host_offline", async () => {
    // Deployment-default creation (no environment) binds the placeholder.
    const thread = await createThread({ title: "386-placeholder-offline" });
    const response = await apiGet(
      `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent("/tmp/rendered.png")}`,
    );
    expect(response.status).toBe(502);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("host_unavailable");
    expect(body.message).toBe("Host is not connected");
  });
});
