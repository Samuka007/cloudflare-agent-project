import { describe, expect, it } from "vitest";
import {
  activeThinkingSchema,
  type ActiveThinking,
} from "../../src/contract/domain/active-thinking.js";
import { buildActiveThinking } from "../../src/services/timeline.js";
import type { UxThreadEvent } from "../../src/seam/agent-do.js";

/**
 * #257 CoT surface (timeline half): the ux stream folds into the response's
 * `activeThinking` tail field — bb reasoning-lifecycle semantics ported to
 * the M0 fold (seq-latest open lifecycle, reasoning completion closes — #543,
 * answer delta kept as the unfinished-stream sweep, thread-status gate).
 * Since #303 (upstream #3250 port, J6 档 2) the SPA renders it through
 * the reasoning-styled working indicator — same live face, canonical id shared
 * with the persistent Thought rows (test/compat/reasoning-rows.test.ts).
 */

function uxEvent(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  createdAt = 1_000,
): UxThreadEvent {
  return { id: `evt-${seq}`, threadId: "thr_t", seq, type, data, createdAt };
}

describe("#257 — buildActiveThinking (bb parity)", () => {
  it("keeps the latest open lifecycle by seq while the thread is active", () => {
    const events = [
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "call-1 thinking",
      }),
      uxEvent(2, "item/agentMessage/delta", {
        turnId: "t1",
        itemId: "itm-am-t1:1",
        delta: "answer",
      }),
      uxEvent(3, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:2",
        delta: "call-2 thinking",
      }),
      uxEvent(4, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:2",
        delta: " more",
      }),
    ];
    const active: ActiveThinking | null = buildActiveThinking(events, "active");
    expect(active).toEqual({
      id: "itm-rs-t1:2",
      text: "call-2 thinking more",
      startedAt: 1_000,
      updatedAt: 1_000,
    });
    expect(activeThinkingSchema.parse(active)).toEqual(active);
  });

  it("closes the call's lifecycle when its own answer delta arrives", () => {
    const events = [
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "reasoning",
      }),
      uxEvent(2, "item/agentMessage/delta", {
        turnId: "t1",
        itemId: "itm-am-t1:1",
        delta: "answer",
      }),
    ];
    expect(buildActiveThinking(events, "active")).toBeNull();
  });

  // #543: bb's close point is the reasoning item's completion (thread-view
  // assistant-event-projection.ts:174-187), not the first answer delta. The
  // old answer-delta-only close double-showed the completed text (durable
  // Thought row + live indicator) in the completion→first-delta window and
  // stuck the stale thinking on the indicator for tool-call-only calls.
  it("closes the call's lifecycle at its own reasoning completion", () => {
    const events = [
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "reasoning",
      }),
      uxEvent(2, "item/completed", {
        turnId: "t1",
        item: { type: "reasoning", id: "itm-rs-t1:1", summary: [], content: ["reasoning"] },
      }),
    ];
    expect(buildActiveThinking(events, "active")).toBeNull();
  });

  it("keeps a later open lifecycle while earlier ones complete (multi-call turn)", () => {
    const events = [
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "call-1",
      }),
      uxEvent(2, "item/completed", {
        turnId: "t1",
        item: { type: "reasoning", id: "itm-rs-t1:1", summary: [], content: ["call-1"] },
      }),
      uxEvent(3, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:2",
        delta: "call-2",
      }),
    ];
    expect(buildActiveThinking(events, "active")?.id).toBe("itm-rs-t1:2");
  });

  it("drops non-reasoning completions without touching lifecycles", () => {
    const events = [
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "reasoning",
      }),
      uxEvent(2, "item/completed", {
        turnId: "t1",
        item: { type: "toolCall", id: "call_x", tool: "read", arguments: {}, status: "completed", output: "x", completedAt: 1_000 },
      }),
    ];
    expect(buildActiveThinking(events, "active")?.text).toBe("reasoning");
  });

  it("returns null when the thread is not active and when nothing streams", () => {
    const thinking = [
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "reasoning",
      }),
    ];
    for (const status of ["idle", "starting", "stopping", "error"]) {
      expect(buildActiveThinking(thinking, status)).toBeNull();
    }
    const answerOnly = [
      uxEvent(1, "item/agentMessage/delta", { turnId: "t1", itemId: "a", delta: "x" }),
    ];
    expect(buildActiveThinking(answerOnly, "active")).toBeNull();
  });

  it("skips malformed delta rows without throwing", () => {
    expect(buildActiveThinking([uxEvent(1, "item/reasoning/textDelta", { turnId: 4 })], "active")).toBeNull();
  });
});