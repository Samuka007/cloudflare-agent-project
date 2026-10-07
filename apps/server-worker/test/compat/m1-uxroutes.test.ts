import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import {
  threadArchiveAllResponseSchema,
  threadChildSummaryResponseSchema,
  threadResponseSchema,
  threadTimelineResponseSchema,
} from "../../src/contract/api/threads.js";
import { buildTimelinePage, projectTimelineRows } from "../../src/services/timeline.js";
import type { UxThreadEvent } from "../../src/seam/agent-do.js";
import {
  BASE,
  createThread,
  ensureRigReady,
  RIG_MODEL_ID,
  RIG_PROVIDER_ID,
  send,
} from "../helpers.js";
import { exports } from "cloudflare:workers";

/**
 * M1 UX route/pagination fixes re-verified in the browser (#121 #122 #123):
 *
 * - #121 timeline older pagination returned the newest window for ANY anchor
 *   (`seq < anchor || id !== anchorId` let the id clause match every
 *   non-anchor row) and never stopped claiming older rows, so the SPA cursor
 *   ping-ponged at ~1.5s forever. bb semantics: strictly-before at the
 *   sequence level with only the anchor row excluded
 *   (timeline-pagination.ts:193-195), and hasOlderRows inferred from the
 *   slice dropping rows for BOTH page kinds, so an older page can touch
 *   bottom.
 * - #122 the SPA Archive menu POSTs /threads/:id/archive-all (sdk
 *   threads.ts:894-910 "Match the UI"); the port only had /archive → 404.
 * - #123 the delete-confirm flow GETs /threads/:id/child-summary
 *   (ThreadActionsProvider.tsx:208-237); a 404 makes requestDelete resolve
 *   null and the dialog silently never opens.
 */
beforeAll(async () => {
  await ensureMigrations();
  await ensureRigReady();
});

let seqCounter = 0;

function uxEvent(type: string, data: unknown, seq?: number): UxThreadEvent {
  seqCounter += 1;
  return {
    id: `evt-${seqCounter}`,
    threadId: "thr_test",
    seq: seq ?? seqCounter,
    type,
    data,
    createdAt: 0,
  };
}

/** Long-thread fixture: `count` user rows at seqs 101..100+count-1. */
function longThreadEvents(count: number): UxThreadEvent[] {
  return Array.from({ length: count }, (_, index) =>
    uxEvent(
      "item/started",
      {
        turnId: "t1",
        item: {
          type: "userMessage",
          id: `u${index + 1}`,
          content: [{ type: "text", text: `m${index + 1}` }],
        },
      },
      101 + index,
    ),
  );
}

async function getJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await exports.default.fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return { status: response.status, body: await response.json() };
}

/** helpers.createThread plus the parent/source/visibility create fields. */
async function createThreadFixture(
  args?: Partial<{
    parentThreadId: string;
    visibility: "visible" | "hidden";
    /** fork-origin side chat: linked via source_thread_id, not assignment. */
    forkOfParent: string;
  }>,
): Promise<{ id: string; projectId: string }> {
  const response = await exports.default.fetch(`${BASE}/api/v1/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "proj_personal",
      origin: "app",
      environment: { type: "host", workspace: { type: "personal" } },
      // #450: the explicit selection the fail-closed create validation demands.
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
      // originKind null + non-empty input is the assigned-child shape (the
      // create route maps parentThreadId → parent link only when originKind
      // is null; fork origin maps it to a source link instead).
      ...(args?.forkOfParent === undefined
        ? { input: [{ type: "text", text: "hi" }] }
        : { input: [], originKind: "fork", parentThreadId: args.forkOfParent }),
      ...(args?.parentThreadId !== undefined ? { parentThreadId: args.parentThreadId } : {}),
      ...(args?.visibility !== undefined ? { visibility: args.visibility } : {}),
    }),
  });
  expect(response.status).toBe(201);
  return response.json<{ id: string; projectId: string }>();
}

describe("#121: buildTimelinePage older pagination (24-row long thread)", () => {
  it("returns only rows strictly before the anchor and touches bottom", () => {
    const rows = projectTimelineRows(longThreadEvents(24));
    expect(rows).toHaveLength(24);

    // Latest window: newest 20, cursor at the page's first row.
    const latest = buildTimelinePage(rows, { kind: "latest", segmentLimit: 20 });
    expect(latest.rows).toHaveLength(20);
    expect(latest.page.hasOlderRows).toBe(true);
    expect(latest.page.olderCursor).toEqual({ anchorSeq: 105, anchorId: "u5" });

    // older@105: with the regressed predicate the id clause let every
    // non-anchor row through and this page re-served the NEWEST 20 rows
    // (seq 106..124). bb semantics serve the 4 remaining older rows.
    const older = buildTimelinePage(rows, {
      kind: "older",
      segmentLimit: 20,
      beforeAnchor: { anchorSeq: 105, anchorId: "u5" },
    });
    expect(older.rows.map((row) => row.id)).toEqual(["u1", "u2", "u3", "u4"]);
    for (const row of older.rows) {
      expect(row.sourceSeqStart).toBeLessThan(105);
    }
    // Bottom: the slice dropped nothing → no older rows, no cursor. This is
    // the fetch-older loop's terminate condition.
    expect(older.page.hasOlderRows).toBe(false);
    expect(older.page.olderCursor).toBeNull();
    expect(older.page.returnedSegmentCount).toBe(4);
  });

  it("excludes only the anchor row among rows sharing the anchor sequence", () => {
    const events = longThreadEvents(24);
    events.push(
      uxEvent(
        "item/started",
        {
          turnId: "t1",
          item: { type: "userMessage", id: "u-tie", content: [{ type: "text", text: "tie" }] },
        },
        124,
      ),
    );
    const rows = projectTimelineRows(events);
    const page = buildTimelinePage(rows, {
      kind: "older",
      segmentLimit: 20,
      beforeAnchor: { anchorSeq: 124, anchorId: "u24" },
    });
    const ids = page.rows.map((row) => row.id);
    expect(ids).toContain("u-tie");
    expect(ids).not.toContain("u24");
    expect(page.page.hasOlderRows).toBe(true);
    // Cursor anchors at the returned page's first row (u5, seq 105).
    expect(page.page.olderCursor).toEqual({ anchorSeq: 105, anchorId: "u5" });
  });

  it("keeps latest-page hasOlderRows false when everything fits one window", () => {
    const rows = projectTimelineRows(longThreadEvents(24));
    const page = buildTimelinePage(rows, { kind: "latest", segmentLimit: 100 });
    expect(page.rows).toHaveLength(24);
    expect(page.page.hasOlderRows).toBe(false);
    expect(page.page.olderCursor).toBeNull();
  });
});

describe("#121: GET /threads/:id/timeline cursor walk terminates without repeats", () => {
  it("walks older cursors to the bottom, losing no rows and never revisiting one", async () => {
    const thread = await createThread();
    // Grow the log past one 20-row window (each send appends at least the
    // user-message row synchronously).
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const probe = threadTimelineResponseSchema.parse(
        await (
          await exports.default.fetch(
            `${BASE}/api/v1/threads/${thread.id}/timeline?segmentLimit=100&includeNestedRows=true`,
          )
        ).json(),
      );
      if (probe.rows.length >= 24) {
        break;
      }
      await send(thread.id);
    }
    const full = threadTimelineResponseSchema.parse(
      await (
        await exports.default.fetch(
          `${BASE}/api/v1/threads/${thread.id}/timeline?segmentLimit=100&includeNestedRows=true`,
        )
      ).json(),
    );
    expect(full.rows.length).toBeGreaterThanOrEqual(24);

    const latest = threadTimelineResponseSchema.parse(
      await (
        await exports.default.fetch(
          `${BASE}/api/v1/threads/${thread.id}/timeline?segmentLimit=20&includeNestedRows=true`,
        )
      ).json(),
    );
    expect(latest.timelinePage.hasOlderRows).toBe(true);

    const seenIds = new Set(latest.rows.map((row) => row.id));
    let cursor = latest.timelinePage.olderCursor;
    let steps = 0;
    while (cursor !== null) {
      steps += 1;
      expect(steps).toBeLessThan(10); // the walk must terminate
      const page = threadTimelineResponseSchema.parse(
        await (
          await exports.default.fetch(
            `${BASE}/api/v1/threads/${thread.id}/timeline?segmentLimit=20&includeNestedRows=true` +
              `&beforeAnchorSeq=${cursor.anchorSeq}&beforeAnchorId=${encodeURIComponent(cursor.anchorId)}`,
          )
        ).json(),
      );
      expect(page.timelinePage.kind).toBe("older");
      const anchor = cursor;
      for (const row of page.rows) {
        // Older page: nothing at-or-after the anchor window comes back, and
        // the ping-pong bug revisited newer row ids across pages.
        expect(row.id).not.toBe(anchor.anchorId);
        expect(row.sourceSeqStart).toBeLessThanOrEqual(anchor.anchorSeq);
        expect(seenIds.has(row.id)).toBe(false);
        seenIds.add(row.id);
      }
      expect(page.timelinePage.hasOlderRows).toBe(page.timelinePage.olderCursor !== null);
      cursor = page.timelinePage.olderCursor;
    }
    // Touching bottom consumed every projected row exactly once.
    expect(seenIds.size).toBe(full.rows.length);
  });
});

describe("#122: POST /threads/:id/archive-all cascades like the UI", () => {
  it("archives live children, hidden source forks, and the parent; skips already-archived", async () => {
    const parent = await createThreadFixture();
    const childA = await createThreadFixture({ parentThreadId: parent.id });
    const childB = await createThreadFixture({ parentThreadId: parent.id });
    const hiddenSource = await createThreadFixture({
      visibility: "hidden",
      forkOfParent: parent.id,
    });
    const deletedChild = await createThreadFixture({ parentThreadId: parent.id });
    const outsider = await createThreadFixture();

    // childB is pre-archived: bb lists UNARCHIVED targets only, so its id
    // must not reappear in the cascade response.
    const preArchive = await getJson(`/api/v1/threads/${childB.id}/archive`, { method: "POST" });
    expect(preArchive.status).toBe(200);
    // A deleted child is not a cascade target (deleted_at IS NULL filter).
    const del = await getJson(`/api/v1/threads/${deletedChild.id}`, {
      method: "DELETE",
      body: JSON.stringify({ childThreadsConfirmed: false }),
    });
    expect(del.status).toBe(200);

    const response = await getJson(`/api/v1/threads/${parent.id}/archive-all`, { method: "POST" });
    expect(response.status).toBe(200);
    const parsed = threadArchiveAllResponseSchema.parse(response.body);
    expect(parsed.ok).toBe(true);
    expect(new Set(parsed.archivedThreadIds).size).toBe(parsed.archivedThreadIds.length);
    expect(parsed.archivedThreadIds).toContain(parent.id);
    expect(parsed.archivedThreadIds).toContain(childA.id);
    expect(parsed.archivedThreadIds).toContain(hiddenSource.id);
    expect(parsed.archivedThreadIds).not.toContain(childB.id);
    expect(parsed.archivedThreadIds).not.toContain(deletedChild.id);
    expect(parsed.archivedThreadIds).not.toContain(outsider.id);

    for (const id of [parent.id, childA.id, hiddenSource.id]) {
      const row = threadResponseSchema.parse((await getJson(`/api/v1/threads/${id}`)).body);
      expect(row.archivedAt).not.toBeNull();
    }
    // /archive stays for API parity (bb keeps both routes).
    const parity = await getJson(`/api/v1/threads/${outsider.id}/archive`, { method: "POST" });
    expect(parity.status).toBe(200);

    // Unknown thread 404s like bb (requirePublicThread).
    const missing = await getJson(`/api/v1/threads/thr_missing/archive-all`, { method: "POST" });
    expect(missing.status).toBe(404);
  });
});

describe("#123: GET /threads/:id/child-summary feeds the delete confirm", () => {
  it("counts non-deleted assigned children and shrinks after a delete", async () => {
    const parent = await createThreadFixture();
    const childA = await createThreadFixture({ parentThreadId: parent.id });
    await createThreadFixture({ parentThreadId: parent.id });
    await createThreadFixture(); // another root: not a child of parent

    const before = await getJson(`/api/v1/threads/${parent.id}/child-summary`);
    expect(before.status).toBe(200);
    expect(threadChildSummaryResponseSchema.parse(before.body)).toEqual({
      nonDeletedChildCount: 2,
    });

    const del = await getJson(`/api/v1/threads/${childA.id}`, {
      method: "DELETE",
      body: JSON.stringify({ childThreadsConfirmed: false }),
    });
    expect(del.status).toBe(200);

    const after = threadChildSummaryResponseSchema.parse(
      (await getJson(`/api/v1/threads/${parent.id}/child-summary`)).body,
    );
    expect(after.nonDeletedChildCount).toBe(1);
  });

  it("serves zero for a childless thread and 404s for an unknown one", async () => {
    const solo = await createThreadFixture();
    const empty = threadChildSummaryResponseSchema.parse(
      (await getJson(`/api/v1/threads/${solo.id}/child-summary`)).body,
    );
    expect(empty.nonDeletedChildCount).toBe(0);

    const missing = await getJson(`/api/v1/threads/thr_missing/child-summary`);
    expect(missing.status).toBe(404);
  });
});
