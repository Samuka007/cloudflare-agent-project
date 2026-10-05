import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { threadListEntrySchema } from "../../src/contract/domain/thread.js";
import type { ThreadListEntry } from "../../src/contract/domain/thread.js";
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
  // #337 exception note: real-clock backoff, not fake timers — the visibility
  // window lives in the workers-pool runtime (workerd isolate scheduling), a
  // domain vi.useFakeTimers cannot advance.
  const backoff = (ms: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    setTimeout(() => {
      resolve(undefined);
    }, ms);
    return promise;
  };

  it("returns a bare array of valid thread list entries", async () => {
    const created = await createThread({ title: "list-entry" });
    // #337: under CI's parallel workers-pool load the freshly created row can
    // take a moment to become visible to the list read. Retry the READ ONLY
    // (bounded): a genuine consistency defect still fails — the create is
    // never repeated, so a row that never lands stays missing. #326
    // recurrence (two consecutive CI verify runs red at ~750ms while the
    // identical suite passed locally twice): widen to 12×250ms ≈ 3s — the
    // 2-core runners need more headroom than the original 6×150ms budget.
    let match: ThreadListEntry | undefined;
    for (let attempt = 0; attempt < 12 && match === undefined; attempt++) {
      if (attempt > 0) await backoff(250);
      const response = await exports.default.fetch("https://example.com/api/v1/threads?limit=50");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
      const entries = (body as unknown[]).map((entry) => threadListEntrySchema.parse(entry));
      match = entries.find((entry) => entry.id === created.id);
    }
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
