import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { apiGet } from "../helpers.js";

/**
 * #494: POST /api/v1/files/mkdir — the Add-project folder browser's "New
 * folder" (bb routes/files.ts:289-308; RemotePathBrowser.tsx:137 posts
 * { hostId, path }). The success-path roundtrip (a live daemon creating the
 * directory) cannot run in this pool — server→client host-rpc frames never
 * reach the in-isolate socket (host-directory.test.ts FIXME) — so the daemon
 * side is pinned at the daemon lane (packages/daemon-service
 * test/host-path-mutations.test.ts: real-fs semantics + dispatch glue).
 * This pool pins the route's resolution + error contract and the #494 family
 * adjudication: the deferred faces answer an explicit 501 not_implemented,
 * never the bare router 404 this ticket exists to remove.
 */
beforeAll(async () => {
  await apiGet("/api/v1/hosts");
});

async function seedHostRow(hostId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at,
                        last_seen_at, last_rejected_protocol_version, created_at, updated_at)
     VALUES (?, ?, 'persistent', NULL, 'full', NULL, NULL, NULL, ?, ?)`,
  )
    .bind(hostId, hostId, Date.now(), Date.now())
    .run();
}

function mkdirWithJson(body: unknown): Promise<Response> {
  return apiGet("/api/v1/files/mkdir", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /files/mkdir (#494)", () => {
  it("422s a missing path before any host resolution", async () => {
    const response = await mkdirWithJson({ hostId: "host_mkdir_never" });
    expect(response.status).toBe(422);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("validation_failed");
  });

  it("422s unknown fields and mistyped values (bb's strict request schema)", async () => {
    await seedHostRow("host_mkdir_strict");
    const backslash = await mkdirWithJson({
      hostId: "host_mkdir_strict",
      path: "/tmp/x",
      recursive: "yes",
    });
    expect(backslash.status).toBe(422);
    const unknownField = await mkdirWithJson({
      hostId: "host_mkdir_strict",
      path: "/tmp/x",
      hostID: "typo",
    });
    expect(unknownField.status).toBe(422);
  });

  it("415s a mutation body that is not application/json (bb requirePrivilegedJsonMutation)", async () => {
    const response = await apiGet("/api/v1/files/mkdir", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    expect(response.status).toBe(415);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("unsupported_media_type");
    expect(body.message).toBe("content-type must be application/json");
  });

  it("404s an unknown host with bb's host_not_found shape", async () => {
    const response = await mkdirWithJson({ hostId: "host_mkdir_missing", path: "/tmp/x" });
    expect(response.status).toBe(404);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("host_not_found");
    expect(body.message).toBe("Host not found");
  });

  it("400s the cloud placeholder host — it holds no daemon to create anything", async () => {
    const response = await mkdirWithJson({ hostId: "cloud", path: "/tmp/x" });
    expect(response.status).toBe(400);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("unsupported_host");
    expect(body.message).toBe("Host cannot run threads");
  });

  it("resolves an omitted hostId to the primary host — a 400, never a routing 404", async () => {
    // The seeded primary is the cloud placeholder (#436/#386), so omission
    // lands on the same refusal as the explicit placeholder id.
    const response = await mkdirWithJson({ path: "newfolder" });
    expect(response.status).toBe(400);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("unsupported_host");
  });

  it("502s host_unavailable for an enrolled host with no live daemon", async () => {
    await seedHostRow("host_mkdir_offline");
    const response = await mkdirWithJson({ hostId: "host_mkdir_offline", path: "/tmp/x" });
    expect(response.status).toBe(502);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("host_unavailable");
    expect(body.message).toBe("Host is not connected");
  });
});

describe("deferred files faces answer explicit 501s (#494 adjudication)", () => {
  const DEFERRED_FACES: { method: "POST" | "GET"; path: string; message: string }[] = [
    {
      method: "POST",
      path: "/api/v1/files/read",
      message: "Host file read is not supported in this deployment yet",
    },
    {
      method: "POST",
      path: "/api/v1/files/write",
      message: "Host file write is not supported in this deployment yet",
    },
    {
      method: "POST",
      path: "/api/v1/files/list",
      message: "Host file listing is not supported in this deployment yet",
    },
    {
      method: "POST",
      path: "/api/v1/files/paths",
      message: "Host path listing is not supported in this deployment yet",
    },
    {
      method: "POST",
      path: "/api/v1/files/move",
      message: "Host file move is not supported in this deployment yet",
    },
    {
      method: "POST",
      path: "/api/v1/files/remove",
      message: "Host file removal is not supported in this deployment yet",
    },
    {
      method: "POST",
      path: "/api/v1/files/previews",
      message: "Host file previews are not supported in this deployment yet",
    },
    {
      method: "GET",
      path: "/api/v1/file-previews/lease-id/notes.txt",
      message: "Host file previews are not supported in this deployment yet",
    },
  ];

  for (const face of DEFERRED_FACES) {
    it(`${face.method} ${face.path} → 501 not_implemented`, async () => {
      const response = await apiGet(face.path, { method: face.method });
      expect(response.status).toBe(501);
      const body = await response.json<{ code: string; message: string }>();
      expect(body.code).toBe("not_implemented");
      expect(body.message).toBe(face.message);
    });
  }
});
