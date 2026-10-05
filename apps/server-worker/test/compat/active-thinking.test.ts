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
 * the M0 fold (seq-latest open lifecycle, answer delta closes, thread-status
 * gate). The pinned SPA renders it through the expandable Thinking indicator.
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