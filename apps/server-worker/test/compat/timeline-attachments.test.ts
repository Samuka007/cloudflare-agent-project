import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import {
  threadConversationOutlineResponseSchema,
  threadResponseSchema,
  threadTimelineResponseSchema,
} from "../../src/contract/api/threads.js";
import {
  timelineRowSchema,
  type TimelineUserConversationRow,
} from "../../src/contract/thread-timeline.js";
import { uploadedPromptAttachmentSchema } from "../../src/contract/api/projects.js";
import { exports } from "cloudflare:workers";
import { ensureRigReady, RIG_MODEL_ID, RIG_PROVIDER_ID } from "../helpers.js";

/**
 * #320 A5: the timeline projection feeds the user row's attachment block from
 * the journal prompt content (bb user-message-parsing parsePromptInput +
 * toConversationAttachments). This is the only server-side gap in the SPA
 * render face — the pinned SPA's ConversationAttachments renders
 * `attachments` when non-null, and the #316 content face answers the image
 * src URLs it builds. Text-only rows keep `attachments: null` (the shipped
 * M0 shape, upstream-equivalent: ConversationAttachments.tsx:128 renders
 * nothing for empty lists either way).
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

/** bb PNG bytes with real magic (same fixture the #316/#317 suites use). */
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
  expect(response.status).toBe(201);
  return threadResponseSchema.parse(await response.json());
}

/** User-role timeline rows in projection order. */
async function userRows(threadId: string): Promise<TimelineUserConversationRow[]> {
  const response = await apiFetch(`/api/v1/threads/${threadId}/timeline?segmentLimit=50`);
  expect(response.status).toBe(200);
  const parsed = threadTimelineResponseSchema.parse(await response.json());
  return parsed.rows
    .map((row) => timelineRowSchema.parse(row))
    .filter(
      (row): row is TimelineUserConversationRow =>
        row.kind === "conversation" && row.role === "user",
    );
}

describe("#320 A5 timeline attachment projection", () => {
  it("feeds the user row attachment block from the create-face content", async () => {
    const image = await upload(PROJECT, new File([PNG_BYTES], "pic.png", { type: "image/png" }));
    const file = await upload(
      PROJECT,
      new File([PDF_BYTES], "notes.pdf", { type: "application/pdf" }),
    );
    const thread = await createWithInput([
      { type: "text", text: "look at these" },
      { type: "localImage", path: image.path },
      { type: "image", url: "https://example.com/web.png" },
      { type: "localFile", path: file.path },
    ]);

    const rows = await userRows(thread.id);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.attachments).toEqual({
      webImages: 1,
      localImages: 1,
      localFiles: 1,
      imageUrls: ["https://example.com/web.png"],
      localImagePaths: [image.path],
      localFilePaths: [file.path],
    });
  });

  it("keeps text-only user rows at attachments null (the shipped M0 shape)", async () => {
    const thread = await createWithInput([{ type: "text", text: "plain words" }]);
    const rows = await userRows(thread.id);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.attachments).toBeNull();
  });

  it("counts runtime-passthrough absolute image paths like upstream", async () => {
    const thread = await createWithInput([{ type: "localImage", path: "/tmp/local-only.png" }]);
    const rows = await userRows(thread.id);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.attachments).toEqual({
      webImages: 0,
      localImages: 1,
      localFiles: 0,
      imageUrls: [],
      localImagePaths: ["/tmp/local-only.png"],
      localFilePaths: [],
    });
  });

  it("feeds the send-face user row the same way", async () => {
    const seeded = await createWithInput([], { originKind: "fork" });
    const image = await upload(PROJECT, new File([PNG_BYTES], "sent.png", { type: "image/png" }));
    const sent = await apiFetch(`/api/v1/threads/${seeded.id}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: [
          { type: "text", text: "with attachment" },
          { type: "localImage", path: image.path },
        ],
        mode: "auto",
      }),
    });
    expect(sent.status).toBe(200);

    const rows = await userRows(seeded.id);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)?.attachments).toEqual({
      webImages: 0,
      localImages: 1,
      localFiles: 0,
      imageUrls: [],
      localImagePaths: [image.path],
      localFilePaths: [],
    });
  });

  it("derives the outline attachment summary from the fed block", async () => {
    const image = await upload(PROJECT, new File([PNG_BYTES], "only.png", { type: "image/png" }));
    const file = await upload(
      PROJECT,
      new File([PDF_BYTES], "only.pdf", { type: "application/pdf" }),
    );
    const thread = await createWithInput([
      { type: "localImage", path: image.path },
      { type: "localFile", path: file.path },
      { type: "image", url: "https://example.com/web2.png" },
    ]);

    const response = await apiFetch(`/api/v1/threads/${thread.id}/conversation-outline`);
    expect(response.status).toBe(200);
    const outline = threadConversationOutlineResponseSchema.parse(await response.json());
    const userItems = outline.items.filter((item) => item.role === "user");
    expect(userItems).toHaveLength(1);
    expect(userItems.at(0)?.preview).toBe("");
    expect(userItems.at(0)?.attachmentSummary).toEqual({ imageCount: 2, fileCount: 1 });
  });
});
