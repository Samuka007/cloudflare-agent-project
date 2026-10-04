import { DurableObject } from "cloudflare:workers";
import type { RealtimeThreadDelta } from "@cap/protocol";

/**
 * #197 test fixture: stands in for NotificationHubDO as the `HUB` binding of
 * the agent-DO vitest rig. Records every push-RPC call (L2 e2e: journal
 * append → hub frame) instead of fanning out to sockets — the assertions
 * read the frames the agent DO produced, in arrival order.
 */

export interface RecordedHubCall {
  kind: "delta" | "changed";
  /** delta frames, verbatim. */
  frame?: RealtimeThreadDelta;
  /** changed calls, verbatim. */
  threadId?: string;
  changes?: string[];
  metadata?: Record<string, unknown>;
}

export class RecordingHubDO extends DurableObject {
  private calls: RecordedHubCall[] = [];

  notifyThreadDelta(frame: RealtimeThreadDelta): { delivered: number } {
    this.calls.push({ kind: "delta", frame });
    return { delivered: 0 };
  }

  notifyThread(
    threadId: string,
    changes: string[],
    metadata?: Record<string, unknown>,
  ): { delivered: number } {
    this.calls.push({ kind: "changed", threadId, changes, metadata });
    return { delivered: 0 };
  }

  /** Non-destructive view — poll targets use this: deliveries that landed
   * before the poll started stay visible (take/reset would swallow them). */
  peekCalls(): RecordedHubCall[] {
    return [...this.calls];
  }

  /** All recorded calls in arrival order, then reset (per-test isolation). */
  takeCalls(): RecordedHubCall[] {
    const out = this.calls;
    this.calls = [];
    return out;
  }
}
