import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { threadSearchResponseSchema } from "../../src/contract/api/threads.js";
import { projectTimelineRows } from "../../src/services/timeline.js";
import type { UxThreadEvent } from "../../src/seam/agent-do.js";
import { createThread } from "../helpers.js";
import { env, exports } from "cloudflare:workers";

/**
 * M1 UX quick-fix batch (#72 matrix bucket, #76 ruling): B4 search route
 * shadowing, F8 titleFallback derivation, C6 thread prompt-history empty
 * route, D7 sealed-error row detail, E9/A6 provider-cli-status. B6 draft
 * residue resolves bb-equivalent with no server surface (PR evidence note).
 */
beforeAll(ensureMigrations);

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

async function getThread(
  id: string,
): Promise<{ title: string | null; titleFallback: string | null }> {
  const response = await exports.default.fetch(`https://example.com/api/v1/threads/${id}`);
  expect(response.status).toBe(200);
  return response.json();
}

describe("B4: GET /threads/search is not shadowed by /threads/:id", () => {
  it("matches a thread by title tokens and serves the bb search shape", async () => {
    const created = await createThread({ title: "Needle In Haystack Title" });
    const response = await exports.default.fetch(
      "https://example.com/api/v1/threads/search?query=needle",
    );
    expect(response.status).toBe(200);
    const body = threadSearchResponseSchema.parse(await response.json());
    const match = body.active.results.find((result) => result.thread.id === created.id);
    expect(match).toBeDefined();
    expect(body.active.total).toBeGreaterThanOrEqual(1);
    expect(match?.matches[0]?.sourceKind).toBe("title");
    expect(match?.matches[0]?.text).toBe("Needle In Haystack Title");
    expect(match?.matches[0]?.highlightRanges[0]).toEqual({ start: 0, end: 6 });
    expect(match?.matches[0]?.sourceSeq).toBeNull();
  });

  it("matches the title_fallback segment for untitled threads", async () => {
    const created = await createThread({
      input: [{ type: "text", text: "Fallback searchable prompt" }],
    });
    const response = await exports.default.fetch(
      "https://example.com/api/v1/threads/search?query=searchable",
    );
    expect(response.status).toBe(200);
    const body = threadSearchResponseSchema.parse(await response.json());
    const match = body.active.results.find((result) => result.thread.id === created.id);
    expect(match?.matches[0]?.sourceKind).toBe("title_fallback");
  });

  it("serves an empty bb-shaped response instead of thread_not_found", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/v1/threads/search?query=zznomatchzz",
    );
    expect(response.status).toBe(200);
    const body = threadSearchResponseSchema.parse(await response.json());
    expect(body.active).toEqual({ total: 0, results: [] });
    expect(body.archived).toEqual({ total: 0, results: [] });
  });

  it("rejects short queries and out-of-range limits like bb", async () => {
    const short = await exports.default.fetch("https://example.com/api/v1/threads/search?query=a");
    expect([400, 422]).toContain(short.status);

    const zero = await exports.default.fetch(
      "https://example.com/api/v1/threads/search?query=valid&limitPerGroup=0",
    );
    expect(zero.status).toBe(400);
    expect((await zero.json<{ code: string }>()).code).toBe("invalid_request");

    const over = await exports.default.fetch(
      "https://example.com/api/v1/threads/search?query=valid&limitPerGroup=51",
    );
    expect(over.status).toBe(400);
  });

  it("files an archived thread under the archived group", async () => {
    const created = await createThread({ title: "ArchivedSearchNeedle" });
    await exports.default.fetch(`https://example.com/api/v1/threads/${created.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await exports.default.fetch(
      "https://example.com/api/v1/threads/search?query=archivedsearchneedle",
    );
    const body = threadSearchResponseSchema.parse(await response.json());
    expect(body.archived.results.some((result) => result.thread.id === created.id)).toBe(true);
    expect(body.active.results.some((result) => result.thread.id === created.id)).toBe(false);
  });
});

describe("F8: server derives titleFallback from the first prompt", () => {
  it("stores the cleaned first-prompt text as titleFallback", async () => {
    const created = await createThread({
      input: [{ type: "text", text: "  Fix   the\nsearch route  " }],
    });
    const body = await getThread(created.id);
    expect(body.titleFallback).toBe("Fix the search route");
  });

  it("truncates past 80 chars to 77 + ellipsis", async () => {
    const long = "x".repeat(120);
    const created = await createThread({ input: [{ type: "text", text: long }] });
    const body = await getThread(created.id);
    expect(body.titleFallback).toBe(`${"x".repeat(77)}...`);
    expect(body.titleFallback?.length).toBe(80);
  });

  it("leaves titleFallback null for programmatic no-input creates", async () => {
    const created = await createThread();
    const body = await getThread(created.id);
    expect(body.titleFallback).toBeNull();
  });
});

describe("C6: thread prompt-history serves the bb empty list", () => {
  it("returns [] for a live thread", async () => {
    const created = await createThread({ title: "prompt-history" });
    const response = await exports.default.fetch(
      `https://example.com/api/v1/threads/${created.id}/prompt-history`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("404s on an unknown thread and validates the limit like bb", async () => {
    const missing = await exports.default.fetch(
      "https://example.com/api/v1/threads/thr_missing/prompt-history",
    );
    expect(missing.status).toBe(404);
    expect((await missing.json<{ code: string }>()).code).toBe("thread_not_found");

    // bb validates the limit after the thread lookup (data.ts:462-470), so
    // the garbage-limit 400 needs a live thread.
    const garbage = await exports.default.fetch(
      `https://example.com/api/v1/threads/${(await createThread({ title: "prompt-history-limit" })).id}/prompt-history?limit=abc`,
    );
    expect(garbage.status).toBe(400);
    expect((await garbage.json<{ code: string }>()).code).toBe("invalid_request");
  });
});

describe("D7: sealed-error rows carry the message text with error status", () => {
  it("titles the row with the event message, detail null, status error", () => {
    const rows = projectTimelineRows([
      uxEvent("system/error", {
        message: "model stream interrupted mid-call; turn sealed",
        category: "internal",
      }),
    ]);
    const row = rows.find((candidate) => candidate.kind === "system");
    expect(row).toMatchObject({
      kind: "system",
      systemKind: "error",
      title: "model stream interrupted mid-call; turn sealed",
      detail: null,
      status: "error",
    });
  });

  it("falls back to the System error label past 80 chars with the text in detail", () => {
    const long = "d".repeat(120);
    const rows = projectTimelineRows([
      uxEvent("system/error", { message: long, category: "internal" }),
    ]);
    const row = rows.find((candidate) => candidate.kind === "system");
    expect(row).toMatchObject({
      title: "System error",
      detail: long,
      status: "error",
    });
  });
});

describe("E9/A6: provider-clis/status answers the E8 crop as an empty state (#302 re-ruling)", () => {
  it("404s an unknown host and answers the empty record for a known one", async () => {
    const missing = await exports.default.fetch(
      "https://example.com/api/v1/hosts/host_missing/provider-clis/status",
    );
    expect(missing.status).toBe(404);
    expect((await missing.json<{ code: string }>()).code).toBe("host_not_found");

    await env.DB.prepare(
      `INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at,
                          last_seen_at, last_rejected_protocol_version, created_at, updated_at)
       VALUES ('host_cli_status', 'cli-status-host', 'persistent', NULL, 'full', NULL, NULL, NULL, ?, ?)`,
    )
      .bind(Date.now(), Date.now())
      .run();
    const known = await exports.default.fetch(
      "https://example.com/api/v1/hosts/host_cli_status/provider-clis/status",
    );
    // #302: the compose page polls this in the Add-project flow and the
    // machine page rendered a permanent "Status unavailable" error row for
    // what is really an empty state. The empty record is schema-valid
    // (ProviderCliStatusResponse is a record) and renders "None installed".
    expect(known.status).toBe(200);
    expect(await known.json<Record<string, never>>()).toEqual({});
  });
});
