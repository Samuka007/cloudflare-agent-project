import { describe, expect, it } from "vitest";
import { beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { threadTimelineResponseSchema } from "../../src/contract/api/threads.js";
import { createThread, send } from "../helpers.js";
import { ensureMigrations } from "../migrate.js";
import { buildContextWindowUsage } from "../../src/services/timeline.js";
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

const noise = (seq: number): UxThreadEvent => ({
  id: `thr_u:${seq}`,
  threadId: "thr_u",
  seq,
  type: "item/agentMessage/delta",
  data: { turnId: "turn_1", itemId: "itm-am-turn_1:1", delta: "x" },
  createdAt: 1_000 + seq,
});

describe("buildContextWindowUsage (#308)", () => {
  it("returns null for a thread with no usage rows (no indicator, no guess)", () => {
    expect(buildContextWindowUsage([noise(1), noise(2)])).toBeNull();
    expect(buildContextWindowUsage([])).toBeNull();
  });

  it("newest row wins regardless of input order", () => {
    const events = [usageRow(9, 300), noise(10), usageRow(5, 100), usageRow(7, 200)];
    expect(buildContextWindowUsage(events)).toEqual({
      usedTokens: 300,
      modelContextWindow: 200_000,
      estimated: false,
    });
  });

  it("ignores malformed rows instead of surfacing a partial percentage", () => {
    const events: UxThreadEvent[] = [
      usageRow(5, 100),
      { ...usageRow(6, 999), data: { contextWindowUsage: { usedTokens: -5, modelContextWindow: 1 } } },
    ];
    expect(buildContextWindowUsage(events)).toEqual({
      usedTokens: 100,
      modelContextWindow: 200_000,
      estimated: false,
    });
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
