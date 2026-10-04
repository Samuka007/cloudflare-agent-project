import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { threadListEntrySchema } from "../../src/contract/domain/thread.js";
import { threadListQuerySchema } from "../../src/contract/api/threads.js";
import { createThread } from "../helpers.js";
import { exports } from "cloudflare:workers";

/**
 * Criterion 2 (port-inventory §6.2): the thread list response is a bare array
 * (`z.array(threadListEntrySchema)`), supporting offset params even though
 * the SPA does not scroll-load.
 */
beforeAll(ensureMigrations);

describe("criterion 2: thread list bare array", () => {
  it("returns a bare array of valid thread list entries", async () => {
    const created = await createThread({ title: "list-entry" });
    const response = await exports.default.fetch("https://example.com/api/v1/threads?limit=50");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    const entries = (body as unknown[]).map((entry) => threadListEntrySchema.parse(entry));
    const match = entries.find((entry) => entry.id === created.id);
    expect(match).toBeDefined();
    expect(match?.runtime.displayStatus).toBeTypeOf("string");
    expect(match?.activity.activeBackgroundAgentCount).toBe(0);
    expect(match?.environmentWorkspaceDisplayKind).toBe("other");
  });

  it("supports the bb filter surface (sectionId, archived, hasParent)", async () => {
    const query = threadListQuerySchema.parse({
      archived: "false",
      hasParent: "false",
      limit: "10",
      offset: "0",
    });
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, value]));
    const response = await exports.default.fetch(
      `https://example.com/api/v1/threads?${params.toString()}`,
    );
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  it("rejects conflicting section filters like bb", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/v1/threads?sectionId=sec_x&unsectioned=true",
    );
    expect(response.status).toBe(400);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("invalid_request");
  });
});
