import { describe, expect, it } from "vitest";
import {
  activeThinkingSchema,
  type ActiveThinking,
} from "../../src/contract/domain/active-thinking.js";
import { projectThreadTimeline } from "../../src/services/thread-view.js";
import type { ThreadStatus } from "../../src/contract/domain/thread-status.js";
import type { UxThreadEvent } from "../../src/seam/agent-do.js";

/**
 * #257 CoT surface: the ux stream folds into the response's `activeThinking`
 * tail field — bb reasoning-lifecycle semantics (seq-latest open lifecycle,
 * reasoning completion closes — #543, thread-status gate). Since the #554
 * roadmap step ⑤ retirement these pins target the LIVE face: the
 * materializer + bb thread-view projection (services/thread-view.ts), not
 * the deleted porting-layer fold.
 *
 * bb identity (the D1 namespace the #560 diff harness pinned): the lifecycle
 * id is bb's operation id `${threadId}:op:reasoning:${messageKey}` with
 * messageKey `kind:reasoning|turn:<turnId>|parent:<parent>|item:<itemId>`;
 * the ux itemId is the `item:` tail.
 */

function uxEvent(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  createdAt = 1_000,
): UxThreadEvent {
  return { id: `evt-${seq}`, threadId: "thr_t", seq, type, data, createdAt };
}

function thinkingId(itemId: string, turnId = "t1"): string {
  return `thr_t:op:reasoning:kind:reasoning|turn:${turnId}|parent:root|item:${itemId}`;
}

const turnStarted = (): UxThreadEvent => uxEvent(0, "turn/started", { turnId: "t1" });

function activeThinkingOf(
  events: readonly UxThreadEvent[],
  threadStatus: ThreadStatus,
): ActiveThinking | null {
  return projectThreadTimeline(events, { threadStatus }).activeThinking;
}

describe("#257 — activeThinking (bb parity, live face)", () => {
  it("keeps the latest open lifecycle by seq while the thread is active", () => {
    const events = [
      turnStarted(),
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "call-1 thinking\n",
      }),
      uxEvent(2, "item/agentMessage/delta", {
        turnId: "t1",
        itemId: "itm-am-t1:1",
        delta: "answer",
      }),
      uxEvent(3, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:2",
        delta: "call-2 thinking\n",
      }),
      uxEvent(4, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:2",
        delta: " more\n",
      }),
    ];
    const active: ActiveThinking | null = activeThinkingOf(events, "active");
    expect(active).toEqual({
      id: thinkingId("itm-rs-t1:2"),
      // bb line-buffers the stream (visible-text-buffer): complete lines
      // only, with each delta's own newline kept.
      text: "call-2 thinking\n more\n",
      startedAt: 1_000,
      updatedAt: 1_000,
    });
    expect(activeThinkingSchema.parse(active)).toEqual(active);
  });

  // bb has no answer-delta sweep (assistant-event-projection.ts finalizes
  // open lifecycles only at the reasoning item's completion and at turn
  // completion) — an answer delta alone leaves the indicator live.
  it("keeps the lifecycle open across its own answer delta", () => {
    const events = [
      turnStarted(),
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "reasoning\n",
      }),
      uxEvent(2, "item/agentMessage/delta", {
        turnId: "t1",
        itemId: "itm-am-t1:1",
        delta: "answer",
      }),
    ];
    expect(activeThinkingOf(events, "active")?.text).toBe("reasoning\n");
  });

  // #543: bb's close point is the reasoning item's completion (thread-view
  // assistant-event-projection.ts:174-187), not the first answer delta. The
  // old answer-delta-only close double-showed the completed text (durable
  // Thought row + live indicator) in the completion→first-delta window and
  // stuck the stale thinking on the indicator for tool-call-only calls.
  it("closes the call's lifecycle at its own reasoning completion", () => {
    const events = [
      turnStarted(),
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
    expect(activeThinkingOf(events, "active")).toBeNull();
  });

  it("keeps a later open lifecycle while earlier ones complete (multi-call turn)", () => {
    const events = [
      turnStarted(),
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
    expect(activeThinkingOf(events, "active")?.id).toBe(thinkingId("itm-rs-t1:2"));
  });

  it("drops non-reasoning completions without touching lifecycles", () => {
    const events = [
      turnStarted(),
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "reasoning\n",
      }),
      uxEvent(2, "item/completed", {
        turnId: "t1",
        item: { type: "toolCall", id: "call_x", tool: "read", arguments: {}, status: "completed", output: "x", completedAt: 1_000 },
      }),
    ];
    expect(activeThinkingOf(events, "active")?.text).toBe("reasoning\n");
  });

  it("returns null when the thread is not active and when nothing streams", () => {
    const thinking = [
      turnStarted(),
      uxEvent(1, "item/reasoning/textDelta", {
        turnId: "t1",
        itemId: "itm-rs-t1:1",
        delta: "reasoning",
      }),
    ];
    for (const status of ["idle", "starting", "stopping", "error"] as const) {
      expect(activeThinkingOf(thinking, status)).toBeNull();
    }
    const answerOnly = [
      turnStarted(),
      uxEvent(1, "item/agentMessage/delta", { turnId: "t1", itemId: "a", delta: "x" }),
    ];
    expect(activeThinkingOf(answerOnly, "active")).toBeNull();
  });

  it("skips malformed delta rows without throwing", () => {
    expect(
      activeThinkingOf([uxEvent(1, "item/reasoning/textDelta", { turnId: 4 })], "active"),
    ).toBeNull();
  });
});
