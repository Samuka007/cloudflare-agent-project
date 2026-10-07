import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { apiGet, ensureRigReady, RIG_MODEL_ID, RIG_PROVIDER_ID } from "../helpers.js";
import {
  buildHostFileContentResponse,
  decodeHostFileContent,
  remapHostFileRouteError,
} from "../../src/services/host-files.js";
import type { HostFileReadResult } from "../../src/contract/api/hosts.js";
import { ApiError } from "../../src/shared/api-error.js";

/**
 * B1 (#321): GET /threads/:id/host-files/content — the files face's minimal
 * content-read subset. The ok-path roundtrip (a live daemon answering
 * host.read_file) is pinned at L1 (daemon-service l1-host-read-file +
 * host-files bun suite); this pool pins the route's resolution + error
 * contract (bb data.ts:660-682 shapes) and the response builder unit
 * (bb daemon-file-response.ts port).
 */
beforeAll(async () => {
  await ensureRigReady();
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

async function createThreadOnHost(hostId: string | undefined): Promise<string> {
  const environment =
    hostId === undefined
      ? { type: "host", workspace: { type: "personal" } }
      : { type: "host", hostId, workspace: { type: "unmanaged", path: "/tmp/b1-workspace" } };
  const response = await apiGet("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "proj_personal",
      origin: "app",
      environment,
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
      input: [{ type: "text", text: "render a diagram" }],
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json<{ id: string }>();
  return body.id;
}

describe("GET /threads/:id/host-files/content (#321)", () => {
  it("404s an unknown thread (bb requirePublicThread)", async () => {
    const response = await apiGet(
      "/api/v1/threads/thr_b1_missing/host-files/content?path=%2Ftmp%2Fx.png",
    );
    expect(response.status).toBe(404);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("thread_not_found");
  });

  it("422s a blank path query before any host ask", async () => {
    const threadId = await createThreadOnHost(undefined);
    const response = await apiGet(`/api/v1/threads/${threadId}/host-files/content?path=`);
    expect(response.status).toBe(422);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("validation_failed");
  });

  it("502s host_unavailable when the bound environment's host has no live daemon", async () => {
    await seedHostRow("host_b1_offline");
    const threadId = await createThreadOnHost("host_b1_offline");
    const response = await apiGet(
      `/api/v1/threads/${threadId}/host-files/content?path=${encodeURIComponent("/tmp/rendered.png")}`,
    );
    expect(response.status).toBe(502);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("host_unavailable");
    expect(body.message).toBe("Host is not connected");
  });

  it("502s host_unavailable for the deployment posture (personal workspace, no session)", async () => {
    const threadId = await createThreadOnHost(undefined);
    const response = await apiGet(
      `/api/v1/threads/${threadId}/host-files/content?path=${encodeURIComponent("/tmp/rendered.png")}`,
    );
    expect(response.status).toBe(502);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("host_unavailable");
  });

  it("404s a dangling environment binding (bb requireEnvironment)", async () => {
    await seedHostRow("host_b1_dangling");
    const threadId = await createThreadOnHost("host_b1_dangling");
    const row = await env.DB.prepare("SELECT environment_id FROM threads WHERE id = ?")
      .bind(threadId)
      .first<{ environment_id: string }>();
    if (row === null) throw new Error("thread row missing");
    await env.DB.prepare("DELETE FROM environments WHERE id = ?")
      .bind(row.environment_id)
      .run();
    const response = await apiGet(
      `/api/v1/threads/${threadId}/host-files/content?path=${encodeURIComponent("/tmp/rendered.png")}`,
    );
    expect(response.status).toBe(404);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("environment_not_found");
  });
});

describe("host-file content response builder (bb daemon-file-response port)", () => {
  const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d] as const;
  const pngResult: HostFileReadResult = {
    path: "/tmp/rendered.png",
    content: btoa(String.fromCharCode(...PNG_BYTES)),
    contentEncoding: "base64",
    mimeType: "image/png",
    sizeBytes: 5,
    sha256: "a".repeat(64),
  };

  it("decodes base64 and frames the mime type", () => {
    const response = buildHostFileContentResponse(pngResult);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(decodeHostFileContent(pngResult))).toEqual(Uint8Array.of(...PNG_BYTES));
  });

  it("serves utf8 content verbatim and falls back to octet-stream without mime", async () => {
    const textResult: HostFileReadResult = {
      path: "/tmp/notes.txt",
      content: "host notes",
      contentEncoding: "utf8",
      sizeBytes: 10,
      sha256: "b".repeat(64),
    };
    const response = buildHostFileContentResponse(textResult);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    await expect(response.text()).resolves.toBe("host notes");
  });

  it("remaps the daemon dispatch codes onto the route statuses (bb remapDaemonFileRouteError)", () => {
    const statusFor = (code: string): number => {
      try {
        remapHostFileRouteError(new ApiError({ status: 502, code, message: "x" }));
      } catch (error) {
        if (error instanceof ApiError) return error.status;
        throw error;
      }
      throw new Error("remap did not throw");
    };
    expect(statusFor("ENOENT")).toBe(404);
    expect(statusFor("invalid_path")).toBe(400);
    expect(statusFor("file_too_large")).toBe(413);
    expect(statusFor("command_failed")).toBe(502);
  });
});
