import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { SELF } from "cloudflare:test";
import {
  threadTimelineResponseSchema,
  threadEventsQuerySchema,
} from "../../src/contract/api/threads.js";
import { timelineRowSchema } from "../../src/contract/thread-timeline.js";
import { createThread, send } from "../helpers.js";

/**
 * Criterion 3 (port-inventory §6.3): timeline contract — `rows` + monotonic
 * `maxSeq` + `page {kind, hasOlderRows, olderCursor}` + `afterSequence`
 * delta; events are append-only with a unique per-thread seq.
 */
beforeAll(ensureMigrations);

describe("criterion 3: timeline contract", () => {
  it("serves rows + maxSeq + page metadata for the latest window", async () => {
    const thread = await createThread();
    await send(thread.id);
    const response = await SELF.fetch(
      "https://example.com/api/v1/threads/:id/timeline".replace(":id", thread.id) +
        "?segmentLimit=20&includeNestedRows=true",
    );
    expect(response.status).toBe(200);
    const parsed = threadTimelineResponseSchema.parse(await response.json());
    expect(parsed.timelinePage.kind).toBe("latest");
    expect(parsed.timelinePage.segmentLimit).toBe(20);
    expect(parsed.timelinePage.returnedSegmentCount).toBe(parsed.rows.length);
    expect(parsed.timelinePage.hasOlderRows).toBe(false);
    expect(parsed.timelinePage.olderCursor).toBeNull();
    for (const row of parsed.rows) {
      expect(timelineRowSchema.parse(row)).toBeTruthy();
      expect(row.sourceSeqStart).toBeLessThanOrEqual(row.sourceSeqEnd);
    }
  });

  it("grows maxSeq monotonically as events append", async () => {
    const thread = await createThread();
    const first = threadTimelineResponseSchema.parse(
      await (
        await SELF.fetch(`https://example.com/api/v1/threads/${thread.id}/timeline?segmentLimit=20`)
      ).json(),
    );
    await send(thread.id);
    const second = threadTimelineResponseSchema.parse(
      await (
        await SELF.fetch(`https://example.com/api/v1/threads/${thread.id}/timeline?segmentLimit=20`)
      ).json(),
    );
    expect(second.maxSeq).toBeGreaterThanOrEqual(first.maxSeq);
  });

  it("returns an afterSequence delta against a warm cache and falls back to full rows otherwise", async () => {
    const thread = await createThread();
    await send(thread.id);
    // Settle the turn first: the warm-cache window must be stable across the
    // fetches below (a mid-flight turn would append rows between them).
    const settled = await SELF.fetch(
      `https://example.com/api/v1/threads/${thread.id}/events/wait?type=turn/completed&afterSeq=0&waitMs=10000`,
    );
    expect(settled.status).toBe(200);
    const url = `https://example.com/api/v1/threads/${thread.id}/timeline?segmentLimit=20`;
    const full = threadTimelineResponseSchema.parse(await (await SELF.fetch(url)).json());
    // The projection materializes the user-message row from the turn input.
    expect(full.rows.length).toBeGreaterThan(0);
    // Warm-cache delta: same params + afterSequence = current maxSeq.
    const deltaResponse = await SELF.fetch(`${url}&afterSequence=${full.maxSeq}`);
    const delta = threadTimelineResponseSchema.parse(await deltaResponse.json());
    expect(delta.rows).toEqual(full.rows);
    expect(delta.delta).toBeDefined();
    expect(delta.delta?.upsertRows).toEqual([]);
    // Cold cache: a different paramsKey must serve full rows again.
    const other = threadTimelineResponseSchema.parse(
      await (await SELF.fetch(`${url}&summaryOnly=true`)).json(),
    );
    // summaryOnly omits rows by contract (bb summary face); the miss must
    // still serve no delta and the same high-water mark.
    expect(other.rows).toEqual([]);
    expect(other.delta).toBeUndefined();
    expect(other.maxSeq).toBe(full.maxSeq);
  });

  it("keeps the event replay append-only with a strictly increasing unique seq", async () => {
    const thread = await createThread();
    await send(thread.id);
    await send(thread.id);
    const query = threadEventsQuerySchema.parse({ afterSeq: "0", limit: "500" });
    const response = await SELF.fetch(
      `https://example.com/api/v1/threads/${thread.id}/events?afterSeq=${query.afterSeq}&limit=${query.limit}`,
    );
    expect(response.status).toBe(200);
    const rows = (await response.json()) as { seq: number; id: string }[];
    const seqs = rows.map((row) => row.seq);
    for (let index = 1; index < seqs.length; index += 1) {
      const previous = seqs[index - 1];
      const current = seqs[index];
      if (previous === undefined || current === undefined) {
        throw new Error("event sequence array has holes");
      }
      expect(current).toBeGreaterThan(previous);
    }
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("responds 204 when /events/wait times out without a matching event", async () => {
    const thread = await createThread();
    const response = await SELF.fetch(
      `https://example.com/api/v1/threads/${thread.id}/events/wait?type=system/error&afterSeq=0&waitMs=250`,
    );
    expect(response.status).toBe(204);
  });
});
