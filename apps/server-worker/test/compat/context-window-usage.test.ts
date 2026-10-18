import { describe, expect, it } from "vitest";
import { beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { threadTimelineResponseSchema } from "../../src/contract/api/threads.js";
import { threadEventDataSchemas } from "@cap/protocol";
import { createThread, send } from "../helpers.js";
import { ensureMigrations } from "../migrate.js";
import { projectThreadTimeline } from "../../src/services/thread-view.js";
import type { UxThreadEvent } from "../../src/seam/agent-do.js";

/**
 * #308 server 投影 half: the timeline response's tail-only
 * `contextWindowUsage` field folds newest-row-wins over the ux projection's
 * `thread/contextWindowUsage/updated` rows (bb
 * extractThreadContextWindowUsage semantics; our producer only emits complete
 * rows, so the fold is last-wins). The route half (response field + SPA
 * consumption) is exercised end-to-end below: #450 the composed stack's
 * turn dispatches through the rig's D1 provider row, so the receipt is the
 * relay wire's REAL usage (harness default window 200K), which the SPA's
 * ThreadContextWindowIndicator renders once the timeline response carries
 * the field.
 */

beforeAll(ensureMigrations);

const usageRow = (seq: number, usedTokens: number, modelContextWindow = 200_000): UxThreadEvent => ({
  id: `thr_u:${seq}`,
  threadId: "thr_u",
  seq,
  type: "thread/contextWindowUsage/updated",
  data: { contextWindowUsage: { usedTokens, modelContextWindow, estimated: false } },
  createdAt: 1_000 + seq,
});

const turnStarted = (seq: number): UxThreadEvent => ({
  id: `thr_u:${seq}`,
  threadId: "thr_u",
  seq,
  type: "turn/started",
  data: { turnId: "turn_1" },
  createdAt: 1_000 + seq,
});

const noise = (seq: number): UxThreadEvent => ({
  id: `thr_u:${seq}`,
  threadId: "thr_u",
  seq,
  type: "item/agentMessage/delta",
  data: { turnId: "turn_1", itemId: "itm-am-turn_1:1", delta: "x" },
  createdAt: 1_000 + seq,
});

/**
 * The fold itself retired with the porting layer (#554 roadmap step ⑤);
 * these pins target the live face — the materializer + bb thread-view
 * projection's tail state (services/thread-view.ts projectThreadTimeline).
 */
function contextWindowUsageOf(events: readonly UxThreadEvent[]) {
  return projectThreadTimeline(events, { threadStatus: "active" }).contextWindowUsage;
}

describe("contextWindowUsage tail state (#308, live face)", () => {
  it("returns null for a thread with no usage rows (no indicator, no guess)", () => {
    expect(contextWindowUsageOf([turnStarted(0), noise(1), noise(2)])).toBeNull();
    expect(contextWindowUsageOf([])).toBeNull();
  });

  it("newest row wins regardless of input order", () => {
    const events = [turnStarted(0), usageRow(9, 300), noise(10), usageRow(5, 100), usageRow(7, 200)];
    expect(contextWindowUsageOf(events)).toEqual({
      usedTokens: 300,
      modelContextWindow: 200_000,
      estimated: false,
    });
  });

  it("a partial usage row cannot reach the projection (producer schema gate)", () => {
    // The porting layer safe-parsed rows and skipped malformed ones; the live
    // face (bb decode) throws on them instead — the guarantee that no partial
    // percentage can surface moved upstream to the producer schema: the ux
    // journal only ever stores schema-valid envelopes, so an incomplete
    // contextWindowUsage row is unreachable in production.
    const events: UxThreadEvent[] = [
      usageRow(5, 100),
      { ...usageRow(6, 999), data: { contextWindowUsage: { usedTokens: -5, modelContextWindow: 1 } } },
    ];
    const malformed = events[1];
    if (malformed === undefined) throw new Error("expected the malformed row");
    expect(
      threadEventDataSchemas["thread/contextWindowUsage/updated"].safeParse(malformed.data).success,
    ).toBe(false);
    expect(
      threadEventDataSchemas["thread/contextWindowUsage/updated"].safeParse(
        (events[0] ?? malformed).data,
      ).success,
    ).toBe(true);
  });
});

describe("#308 end-to-end: timeline response carries the indicator value", () => {
  it("a completed turn lands contextWindowUsage (real receipt, 200K window)", async () => {
    const thread = await createThread();
    await send(thread.id);
    const response = await exports.default.fetch(
      `https://example.com/api/v1/threads/${thread.id}/timeline?segmentLimit=20`,
    );
    expect(response.status).toBe(200);
    const parsed = threadTimelineResponseSchema.parse(await response.json());
    expect(parsed.contextWindowUsage).toBeDefined();
    // #450: turns dispatch through the D1 rig row, so the receipt is the
    // relay wire's real usage — the estimated flag is a deployment-mock
    // artifact no longer reachable on any dispatched turn.
    expect(parsed.contextWindowUsage?.estimated).toBe(false);
    expect(parsed.contextWindowUsage?.modelContextWindow).toBe(200_000);
    expect(parsed.contextWindowUsage?.usedTokens).toBeGreaterThan(0);
  });

  it("a thread with no model call has no indicator field at all", async () => {
    const thread = await createThread();
    const response = await exports.default.fetch(
      `https://example.com/api/v1/threads/${thread.id}/timeline?segmentLimit=20`,
    );
    const parsed = threadTimelineResponseSchema.parse(await response.json());
    expect(parsed.contextWindowUsage).toBeUndefined();
  });
});
