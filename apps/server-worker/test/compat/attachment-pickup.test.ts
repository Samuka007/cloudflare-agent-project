import { beforeAll, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { DAEMON_PROTOCOL_VERSION } from "@cap/daemon-service";
import { ensureMigrations } from "../migrate.js";
import { projectAttachmentReader } from "../../src/services/attachment-pickup.js";
import { env } from "../helpers.js";
import type { Env } from "../../src/env.js";

/**
 * #318 A3: the attachment pickup bridge — the deployment half of the daemon
 * face's /internal/session/project-attachment-content. The route transport
 * (Bearer gate, DO session binding, query validation) is L1-covered in
 * packages/daemon-service (l1-attachment-pickup.test.ts); this suite drives
 * the composed bridge DIRECTLY against the rig's D1 + R2 (#316 family) and
 * pins the bb cross-check verdicts (internal/session.ts:149-192 verbatim):
 * thread→project (403), thread→bound-host (403), and the A1 read face.
 */

beforeAll(ensureMigrations);

const BOUND_HOST_ID = "local";

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`https://example.com${path}`, init);
}

/**
 * The helpers' env carries the wrangler-generated namespace types; the
 * bridge is typed against the app's structural Env — the rig object IS the
 * deployment env, so the seam is a named one-line cast, not a re-wrap.
 */
const reader = projectAttachmentReader(env as unknown as Env);

async function seedProject(hostId: string): Promise<string> {
  const response = await apiFetch("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `pickup-${Math.random().toString(36).slice(2, 8)}`,
      source: { hostId, type: "local_path", path: "/tmp/pickup-lane" },
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ id: string }>()).id;
}

async function seedThread(projectId: string): Promise<string> {
  const response = await apiFetch("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "pickup-thread",
      projectId,
      origin: "app",
      input: [{ type: "text", text: "pickup seed" }],
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ id: string }>()).id;
}

async function uploadPng(projectId: string): Promise<{ storedPath: string; bytes: Uint8Array }> {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x01, 0x02,
  ]);
  const form = new FormData();
  form.append("file", new File([bytes], "pickup.png", { type: "image/png" }));
  const response = await apiFetch(`/api/v1/projects/${projectId}/attachments`, {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(201);
  const uploaded = await response.json<{ path: string }>();
  return { storedPath: uploaded.path, bytes };
}

/**
 * The bound host must exist before any thread resolves its binding against
 * it — the enroll leg of the daemon handshake (bb §5). The pickup query's
 * session-binding leg rides the per-host DaemonServiceDO and is covered by
 * the daemon-service L1 suite; here the enroll only materializes the row.
 */
async function enrollBoundHost(): Promise<void> {
  const enroll = await apiFetch("/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey: "[REDACTED-staging-secret]", hostId: BOUND_HOST_ID }),
  });
  expect(enroll.status).toBe(201);
  const open = await apiFetch("/session/open", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer [REDACTED-staging-secret]" },
    body: JSON.stringify({
      hostId: BOUND_HOST_ID,
      bootId: `boot_${BOUND_HOST_ID}_${crypto.randomUUID().slice(0, 8)}`,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    }),
  });
  expect(open.status).toBe(201);
}

async function seedFixture(): Promise<{
  projectId: string;
  threadId: string;
  storedPath: string;
  bytes: Uint8Array;
}> {
  await enrollBoundHost();
  const projectId = await seedProject(BOUND_HOST_ID);
  const threadId = await seedThread(projectId);
  const { storedPath, bytes } = await uploadPng(projectId);
  return { projectId, threadId, storedPath, bytes };
}

describe("#318 attachment pickup bridge (composed deployment)", () => {
  it("serves the R2 bytes for the bound thread's project with mime metadata", async () => {
    const { projectId, threadId, storedPath, bytes } = await seedFixture();

    const result = await reader({
      hostId: BOUND_HOST_ID,
      query: {
        hostId: BOUND_HOST_ID,
        sessionId: "sess_covered_by_l1",
        threadId,
        projectId,
        path: storedPath,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.bytes]).toEqual([...bytes]);
    expect(result.mimeType).toBe("image/png");
  });

  it("rejects a project the thread does not belong to (upstream verdict verbatim)", async () => {
    const { threadId } = await seedFixture();
    const otherProject = await seedProject(BOUND_HOST_ID);

    const result = await reader({
      hostId: BOUND_HOST_ID,
      query: {
        hostId: BOUND_HOST_ID,
        sessionId: "sess_x",
        threadId,
        projectId: otherProject,
        path: "whatever.png",
      },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden",
      message: "Thread does not belong to project",
    });
  });

  it("rejects a host the thread is not bound to (upstream verdict verbatim)", async () => {
    const { projectId, threadId } = await seedFixture();

    const result = await reader({
      hostId: `${BOUND_HOST_ID}_stranger`,
      query: {
        hostId: `${BOUND_HOST_ID}_stranger`,
        sessionId: "sess_x",
        threadId,
        projectId,
        path: "whatever.png",
      },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden",
      message: "Host is not assigned to thread environment",
    });
  });

  it("surfaces the A1 404 for an absent attachment path", async () => {
    const { projectId, threadId } = await seedFixture();

    const result = await reader({
      hostId: BOUND_HOST_ID,
      query: {
        hostId: BOUND_HOST_ID,
        sessionId: "sess_x",
        threadId,
        projectId,
        path: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.png",
      },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      // A1's read face answers 404 with the closed-set code (services/
      // attachments.ts getAttachment); the bridge maps it verbatim.
      code: "invalid_request",
      message: "Attachment not found",
    });
  });
});
