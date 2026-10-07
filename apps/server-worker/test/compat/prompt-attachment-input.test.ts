import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { agentEventDataSchemas } from "@cap/agent-do";
import { apiErrorSchema } from "@cap/protocol";
import { ensureMigrations } from "../migrate.js";
import { ensureRigReady, RIG_MODEL_ID, RIG_PROVIDER_ID } from "../helpers.js";
import { uploadedPromptAttachmentSchema } from "../../src/contract/api/projects.js";
import { threadResponseSchema } from "../../src/contract/api/threads.js";
import type { AgentDoRpc } from "../../src/seam/agent-do.js";

/**
 * #317 A2: the M0 "text only" 422 gate is unlocked — the prompt input union
 * (image/localImage/localFile) rides create-with-input and send into the DO
 * journal verbatim, while a relative localImage/localFile path stays a
 * server-managed attachment reference: containment escapes are a 400 and a
 * contained-but-unuploaded reference is a 400, on both faces. Absolute paths
 * and URI-like values pass through untouched (bb runtime-readable rule).
 */
beforeAll(async () => {
  await ensureMigrations();
  await ensureRigReady();
});

const BASE = "https://example.com";
const PROJECT = "proj_personal";

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, init);
}

/** bb PNG bytes with real magic (same fixture the #316 suite uses). */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x01, 0x02,
]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

async function upload(projectId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const response = await apiFetch(`/api/v1/projects/${projectId}/attachments`, {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(201);
  return uploadedPromptAttachmentSchema.parse(await response.json());
}

async function createWithInput(input: unknown[], overrides: Record<string, unknown> = {}) {
  const response = await apiFetch("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: PROJECT,
      origin: "app",
      environment: { type: "host", workspace: { type: "personal" } },
      // #450: the explicit selection the fail-closed create validation demands.
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
      input,
      ...overrides,
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function sendInput(threadId: string, input: unknown[]): Promise<Response> {
  return apiFetch(`/api/v1/threads/${threadId}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, mode: "auto" }),
  });
}

/** Raw per-thread DO journal: every turn.input content array in log order. */
async function rawTurnInputContents(threadId: string): Promise<unknown[][]> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as AgentDoRpc;
  const { events } = await stub.getEvents({ sinceSeq: 0 });
  return events
    .filter((event) => event.type === "turn.input")
    .map((event) => agentEventDataSchemas["turn.input"].parse(event.data).content);
}

describe("#317 prompt input union gate unlock", () => {
  it("create with an uploaded image input answers 201 and lands the union in the journal", async () => {
    const uploaded = await upload(
      PROJECT,
      new File([PNG_BYTES], "hello.png", { type: "image/png" }),
    );
    const created = await createWithInput([
      { type: "text", text: "look at this" },
      { type: "localImage", path: uploaded.path },
    ]);
    expect(created.status).toBe(201);
    const thread = threadResponseSchema.parse(created.body);
    const contents = await rawTurnInputContents(thread.id);
    expect(contents).toEqual([
      [
        { type: "text", text: "look at this" },
        { type: "localImage", path: uploaded.path },
      ],
    ]);
  });

  it("web image urls and absolute/URI-like paths ride through unvalidated", async () => {
    const input = [
      { type: "image", url: "https://example.com/cat.png" },
      { type: "localImage", path: "/tmp/local-only.png" },
      { type: "localImage", path: "file:///tmp/local-only.png" },
    ];
    const created = await createWithInput(input);
    expect(created.status).toBe(201);
    const thread = threadResponseSchema.parse(created.body);
    expect(await rawTurnInputContents(thread.id)).toEqual([input]);
  });

  it("localFile keeps name/sizeBytes/mimeType in the journal", async () => {
    const uploaded = await upload(
      PROJECT,
      new File([PDF_BYTES], "doc.pdf", { type: "application/pdf" }),
    );
    const input = [
      {
        type: "localFile",
        path: uploaded.path,
        name: uploaded.name,
        sizeBytes: uploaded.sizeBytes,
        mimeType: uploaded.mimeType,
      },
    ];
    const created = await createWithInput(input);
    expect(created.status).toBe(201);
    const thread = threadResponseSchema.parse(created.body);
    expect(await rawTurnInputContents(thread.id)).toEqual([input]);
  });

  it("an escaping attachment reference is a 400 and creates no turn", async () => {
    const created = await createWithInput([
      { type: "localImage", path: "../9f86d081884c7d659a2feaa0c55ad015.png" },
    ]);
    expect(created.status).toBe(400);
    const error = apiErrorSchema.parse(created.body);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("escapes project directory");
  });

  it("a contained-but-unuploaded relative reference is a 400 not-uploaded", async () => {
    const created = await createWithInput([
      { type: "localFile", path: "9f86d081884c7d659a2feaa0c55ad015.pdf" },
    ]);
    expect(created.status).toBe(400);
    const error = apiErrorSchema.parse(created.body);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("was not uploaded");
  });

  it("the send face applies the same unlock and reference rules", async () => {
    // Programmatic no-input start (bb no-input-no-turn guard): the dispatch
    // surface the send route then feeds.
    const seeded = await createWithInput([], { originKind: "fork" });
    expect(seeded.status).toBe(201);
    const thread = threadResponseSchema.parse(seeded.body);

    const uploaded = await upload(
      PROJECT,
      new File([PNG_BYTES], "send.png", { type: "image/png" }),
    );
    const sent = await sendInput(thread.id, [
      { type: "text", text: "with attachment" },
      { type: "localImage", path: uploaded.path },
    ]);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ ok: true });
    const contents = await rawTurnInputContents(thread.id);
    expect(contents.at(-1)).toEqual([
      { type: "text", text: "with attachment" },
      { type: "localImage", path: uploaded.path },
    ]);

    const escape = await sendInput(thread.id, [{ type: "localImage", path: "../outside.png" }]);
    expect(escape.status).toBe(400);
    expect(apiErrorSchema.parse(await escape.json()).message).toContain(
      "escapes project directory",
    );

    const missing = await sendInput(thread.id, [
      { type: "localFile", path: "deadbeef000000000000000000000000.pdf" },
    ]);
    expect(missing.status).toBe(400);
    expect(apiErrorSchema.parse(await missing.json()).message).toContain("was not uploaded");
  });
});
