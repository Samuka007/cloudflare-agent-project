import { beforeAll, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { uploadedPromptAttachmentSchema } from "../../src/contract/api/projects.js";
import { env } from "../helpers.js";

/**
 * #316 A1 keystone: the R2 attachment storage face — bb
 * routes/projects.ts:855-913 (commit d2ab40f0) over the R2 object family
 * `attachment/<projectId>/<sha256><ext>` (services/attachments.ts). The
 * ticket acceptance is this suite: upload (multipart) → object lands in R2 →
 * GET returns byte-identical bytes, plus the bb limit / single-field /
 * containment semantics and the copy face the SPA draft-move uses.
 */
beforeAll(ensureMigrations);

const BASE = "https://example.com";

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, init);
}

async function seedProject(): Promise<string> {
  const response = await apiFetch("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `attachments-${Math.random().toString(36).slice(2, 8)}`,
      source: { hostId: `host_${Math.random().toString(36).slice(2, 8)}`, type: "local_path", path: "/tmp/attachments-lane" },
    }),
  });
  if (response.status !== 201) {
    throw new Error(`seedProject failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json<{ id: string }>();
  return body.id;
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

async function upload(projectId: string, file: File): Promise<Response> {
  const form = new FormData();
  form.append("file", file);
  return apiFetch(`/api/v1/projects/${projectId}/attachments`, { method: "POST", body: form });
}

/** bb PNG bytes with real magic so the mime sniff face is exercised honestly. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x01, 0x02]);

describe("#316 R2 attachment storage face", () => {
  it("exposes the R2 binding through the wrangler config", () => {
    expect(env.BLOBS).toBeDefined();
  });

  it("uploads an image into the R2 family and answers the bb 201 shape", async () => {
    const projectId = await seedProject();
    const response = await upload(projectId, new File([PNG_BYTES], "hello.png", { type: "image/png" }));
    expect(response.status).toBe(201);
    const attachment = uploadedPromptAttachmentSchema.parse(await response.json());
    expect(attachment.type).toBe("localImage");
    expect(attachment.path).toBe(`${await sha256Hex(PNG_BYTES)}.png`);
    expect(attachment.name).toBe("hello.png");
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.sizeBytes).toBe(PNG_BYTES.length);

    // 落 R2: the object exists under the project-scoped family with the
    // metadata the content face serves back.
    const object = await env.BLOBS.head(`attachment/${projectId}/${attachment.path}`);
    expect(object).not.toBeNull();
    expect(object?.size).toBe(PNG_BYTES.length);
    expect(object?.httpMetadata?.contentType).toBe("image/png");
    expect(object?.customMetadata?.name).toBe("hello.png");
    expect(object?.customMetadata?.sha256).toBe(await sha256Hex(PNG_BYTES));
  });

  it("returns byte-identical content whose sha256 matches the path", async () => {
    const projectId = await seedProject();
    const uploaded = uploadedPromptAttachmentSchema.parse(
      await (await upload(projectId, new File([PNG_BYTES], "hello.png", { type: "image/png" }))).json(),
    );
    const response = await apiFetch(
      `/api/v1/projects/${projectId}/attachments/content?path=${encodeURIComponent(uploaded.path)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(PNG_BYTES);
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(PNG_BYTES));
  });

  it("sniffs non-image uploads as localFile and serves the declared mime", async () => {
    const projectId = await seedProject();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const response = await upload(projectId, new File([bytes], "doc.pdf", { type: "application/pdf" }));
    expect(response.status).toBe(201);
    const attachment = uploadedPromptAttachmentSchema.parse(await response.json());
    expect(attachment.type).toBe("localFile");
    expect(attachment.mimeType).toBe("application/pdf");

    const content = await apiFetch(
      `/api/v1/projects/${projectId}/attachments/content?path=${encodeURIComponent(attachment.path)}`,
    );
    expect(content.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
  });

  it("converges identical bytes on one content-addressed object", async () => {
    const projectId = await seedProject();
    const first = uploadedPromptAttachmentSchema.parse(
      await (await upload(projectId, new File([PNG_BYTES], "a.png", { type: "image/png" }))).json(),
    );
    const second = uploadedPromptAttachmentSchema.parse(
      await (await upload(projectId, new File([PNG_BYTES], "b.png", { type: "image/png" }))).json(),
    );
    expect(second.path).toBe(first.path);
    expect(second.name).toBe("b.png");
  });

  it("enforces the bb multipart contract (single File field named file)", async () => {
    const projectId = await seedProject();

    const empty = await apiFetch(`/api/v1/projects/${projectId}/attachments`, {
      method: "POST",
      body: new FormData(),
    });
    expect(empty.status).toBe(400);
    expect((await empty.json<{ message: string }>()).message).toBe("Attachment file is required");

    const misnamed = new FormData();
    misnamed.append("attachment", new File([PNG_BYTES], "hello.png", { type: "image/png" }));
    const wrongField = await apiFetch(`/api/v1/projects/${projectId}/attachments`, {
      method: "POST",
      body: misnamed,
    });
    expect(wrongField.status).toBe(400);
    expect((await wrongField.json<{ message: string }>()).message).toBe(
      'Attachment upload accepts exactly one multipart field named "file"',
    );

    const twoFields = new FormData();
    twoFields.append("file", new File([PNG_BYTES], "hello.png", { type: "image/png" }));
    twoFields.append("note", "extra");
    const extra = await apiFetch(`/api/v1/projects/${projectId}/attachments`, {
      method: "POST",
      body: twoFields,
    });
    expect(extra.status).toBe(400);

    const textField = new FormData();
    textField.append("file", "just-a-string");
    const notAFile = await apiFetch(`/api/v1/projects/${projectId}/attachments`, {
      method: "POST",
      body: textField,
    });
    expect(notAFile.status).toBe(400);

    const blankName = new FormData();
    blankName.append("file", new File([PNG_BYTES], "  ", { type: "image/png" }));
    const blank = await apiFetch(`/api/v1/projects/${projectId}/attachments`, { method: "POST", body: blankName });
    expect(blank.status).toBe(400);
    expect((await blank.json<{ message: string }>()).message).toBe("Attachment filename is required");
  });

  it("enforces the bb upstream limits: images 10MB, files 25MB", async () => {
    const projectId = await seedProject();
    const atLimit = new Uint8Array(10 * 1024 * 1024);
    const boundary = await upload(projectId, new File([atLimit], "big.png", { type: "image/png" }));
    expect(boundary.status).toBe(201);

    const overImage = new Uint8Array(10 * 1024 * 1024 + 1);
    const imageLimit = await upload(projectId, new File([overImage], "big.png", { type: "image/png" }));
    expect(imageLimit.status).toBe(400);
    expect((await imageLimit.json<{ message: string }>()).message).toBe("Attachment exceeds 10MB limit");

    const overFile = new Uint8Array(25 * 1024 * 1024 + 1);
    const fileLimit = await upload(projectId, new File([overFile], "big.bin", { type: "application/octet-stream" }));
    expect(fileLimit.status).toBe(400);
    expect((await fileLimit.json<{ message: string }>()).message).toBe("Attachment exceeds 25MB limit");
  });

  it("keeps the bb containment semantics on the content face", async () => {
    const projectId = await seedProject();

    const unknownProject = await apiFetch("/api/v1/projects/prj_missing/attachments/content?path=whatever");
    expect(unknownProject.status).toBe(404);
    expect((await unknownProject.json<{ code: string }>()).code).toBe("project_not_found");

    const traversal = await apiFetch(
      `/api/v1/projects/${projectId}/attachments/content?path=${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(traversal.status).toBe(400);
    expect((await traversal.json<{ message: string }>()).message).toBe("Attachment path escapes project directory");

    const backslash = await apiFetch(
      `/api/v1/projects/${projectId}/attachments/content?path=${encodeURIComponent("..\\..\\secret")}`,
    );
    expect(backslash.status).toBe(400);

    const absolute = await apiFetch(
      `/api/v1/projects/${projectId}/attachments/content?path=${encodeURIComponent("/etc/passwd")}`,
    );
    expect(absolute.status).toBe(400);
    expect((await absolute.json<{ message: string }>()).message).toBe(
      "Attachment path escapes project directory",
    );

    const root = await apiFetch(
      `/api/v1/projects/${projectId}/attachments/content?path=${encodeURIComponent(".")}`,
    );
    expect(root.status).toBe(400);
    expect((await root.json<{ message: string }>()).message).toBe(
      "Attachment path must refer to a file inside the project directory",
    );

    const missing = await apiFetch(
      `/api/v1/projects/${projectId}/attachments/content?path=${"0".repeat(64)}.png`,
    );
    expect(missing.status).toBe(404);
    expect((await missing.json<{ message: string }>()).message).toBe("Attachment not found");

    const noPath = await apiFetch(`/api/v1/projects/${projectId}/attachments/content`);
    expect(noPath.status).toBe(422);
    expect((await noPath.json<{ code: string }>()).code).toBe("validation_failed");
  });

  it("copies attachments across projects and re-anchors them under the target family", async () => {
    const sourceProjectId = await seedProject();
    const targetProjectId = await seedProject();
    const uploaded = uploadedPromptAttachmentSchema.parse(
      await (await upload(sourceProjectId, new File([PNG_BYTES], "hello.png", { type: "image/png" }))).json(),
    );

    const absent = await apiFetch(
      `/api/v1/projects/${targetProjectId}/attachments/content?path=${encodeURIComponent(uploaded.path)}`,
    );
    expect(absent.status).toBe(404);

    const copy = await apiFetch(`/api/v1/projects/${targetProjectId}/attachments/copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceProjectId, paths: [uploaded.path, uploaded.path] }),
    });
    expect(copy.status).toBe(200);
    expect(await copy.json()).toEqual({ ok: true });

    const copied = await apiFetch(
      `/api/v1/projects/${targetProjectId}/attachments/content?path=${encodeURIComponent(uploaded.path)}`,
    );
    expect(copied.status).toBe(200);
    expect(copied.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await copied.arrayBuffer())).toEqual(PNG_BYTES);
    expect(await env.BLOBS.head(`attachment/${targetProjectId}/${uploaded.path}`)).not.toBeNull();

    const missingSource = await apiFetch(`/api/v1/projects/${targetProjectId}/attachments/copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceProjectId, paths: [`${"f".repeat(64)}.png`] }),
    });
    expect(missingSource.status).toBe(404);

    const noOp = await apiFetch(`/api/v1/projects/${targetProjectId}/attachments/copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceProjectId: targetProjectId, paths: [uploaded.path] }),
    });
    expect(noOp.status).toBe(200);

    const unknownSource = await apiFetch(`/api/v1/projects/${targetProjectId}/attachments/copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceProjectId: "prj_missing", paths: [uploaded.path] }),
    });
    expect(unknownSource.status).toBe(404);
    expect((await unknownSource.json<{ code: string }>()).code).toBe("project_not_found");
  });

  it("404s uploads and copies for unknown projects before touching storage", async () => {
    const uploadResponse = await apiFetch("/api/v1/projects/prj_missing/attachments", {
      method: "POST",
      body: new FormData(),
    });
    expect(uploadResponse.status).toBe(404);
    expect((await uploadResponse.json<{ code: string }>()).code).toBe("project_not_found");

    const copyResponse = await apiFetch("/api/v1/projects/prj_missing/attachments/copy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceProjectId: "prj_also_missing", paths: ["x"] }),
    });
    expect(copyResponse.status).toBe(404);
  });
});
