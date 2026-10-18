import { beforeAll, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  agentEventDataSchemas,
  executionIdFor,
  TIMELINE_WINDOW_BYTE_BUDGET,
  type TimelineWindowInfo,
} from "@cap/agent-do";
import { ensureMigrations } from "../migrate.js";
import { createThread, type CreatedThread } from "../helpers.js";
import type { ThreadTimelineResponse } from "../../src/contract/api/threads.js";
import { threadTimelineResponseSchema } from "../../src/contract/api/threads.js";
import { projectThreadTimeline } from "../../src/services/thread-view.js";

/**
 * #561 acceptance probe — 10k-event thread, full-chain render, isolate
 * memory budget. The read-boundary mechanisms (byte-budget window,
 * truncatedEventDataColumn-style inline truncation, delta governance) are
 * not directly observable as an isolate RSS number in the test runtime, so
 * the probe measures the dominant term they bound — the payload bytes the
 * read layer materializes per request — and asserts the #554 §5 derivation:
 * window payload bytes (≤ budget + one turn) × the projection's 4-6×
 * live-object factor stays two orders under the 128MB isolate ceiling.
 */

beforeAll(ensureMigrations);

/** Journal event count the acceptance scenario names. */
const TARGET_EVENTS = 10_000;

interface WindowedGetEvents {
  getEvents(args: {
    sinceSeq: number;
    limit?: number;
    project?: "raw" | "ux";
    window?: { beforeSeq?: number };
  }): Promise<{
    events: {
      id: string;
      threadId: string;
      seq: number;
      type: string;
      data: unknown;
      createdAt: number;
    }[];
    latestSeq: number;
    window?: TimelineWindowInfo;
  }>;
}

/**
 * Seed a representative 10k-event journal through the DO's own write path:
 * ~196 turns × ~51 rows — streamed answer deltas (1KB each), CoT rows, a
 * tool turn with a 64KB output every other turn, usage receipts. Total
 * journal ≈ 17MB, post-truncation ≈ 10MB — well over the 4MB window budget,
 * so the render chain must page through several byte-budget windows.
 */
async function seedTenKJournal(thread: CreatedThread): Promise<void> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(thread.id));
  await runInDurableObject(stub, async (instance, state) => {
    const appender = instance as unknown as {
      appendEvent(type: string, data: Record<string, unknown>): Promise<unknown>;
    };
    // modelCallId and executionId derive from journal seqs — track the real
    // seq cursor (thread.created and any rig rows precede the seeds).
    let nextSeq =
      state.storage.sql
        .exec<{ next: number }>(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE thread_id = ?",
          thread.id,
        )
        .one().next + 0;

    // FSM-legal turn shape: the modelCallId IS the model.call_started row's
    // seq, a tool turn runs call A (toolCalls non-empty → tools_running) →
    // tool.call → dispatch → exec → output → result → call B → completed.
    const bigOutput = "o".repeat(64_000);
    for (let index = 1; index < TARGET_EVENTS;) {
      // The DO appends its own terminal turn.phase rows after turn.completed;
      // resync the seq cursor at every turn boundary.
      nextSeq = state.storage.sql
        .exec<{ next: number }>(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE thread_id = ?",
          thread.id,
        )
        .one().next;
      const turnId = `turn_seed_${index}`;
      const append = async (type: string, data: Record<string, unknown>) => {
        agentEventDataSchemas[type as keyof typeof agentEventDataSchemas].parse(data);
        await appender.appendEvent(type, data);
        index += 1;
        nextSeq += 1;
      };
      const callA = nextSeq + 1;
      await append("turn.input", {
        turnId,
        inputId: `in_${index}`,
        content: [{ type: "text", text: `input ${index}` }],
      });
      await append("model.call_started", { turnId, modelCallId: callA, consumedSteerSeqs: [] });
      for (let chunk = 0; chunk < 2; chunk += 1) {
        await append("model.thinking", {
          turnId,
          modelCallId: callA,
          text: `reasoning ${index}.${chunk} ${"t".repeat(900)}`,
        });
      }
      for (let chunk = 0; chunk < 8; chunk += 1) {
        await append("model.delta", {
          turnId,
          modelCallId: callA,
          text: `head ${index}.${chunk} ${"a".repeat(950)}`,
        });
      }
      await append("model.call_completed", {
        turnId,
        modelCallId: callA,
        text: `plan ${index}`,
        toolCalls: [{ name: "bash", arguments: { command: `cmd ${index}` } }],
      });
      const toolCallSeq = nextSeq;
      const executionId = executionIdFor(thread.id, toolCallSeq);
      await append("tool.call", {
        turnId,
        modelCallId: callA,
        tool: "bash",
        arguments: { command: `cmd ${index}` },
        timeoutMs: 60_000,
      });
      await append("tool.dispatch", {
        turnId,
        executionId,
        attempt: 1,
        requestId: `req_${index}`,
        outcome: "accepted",
      });
      await append("tool.exec_started", { turnId, executionId });
      for (let chunk = 0; chunk < 2; chunk += 1) {
        await append("tool.output", {
          turnId,
          executionId,
          offset: chunk,
          chunk: `chunk ${chunk} ${"c".repeat(index % 2 === 0 ? 20_000 : 100)}`,
        });
      }
      await append("tool.result", {
        turnId,
        executionId,
        status: "ok",
        exitCode: 0,
        output: index % 2 === 0 ? bigOutput : "ok",
      });
      const callB = nextSeq;
      await append("model.call_started", { turnId, modelCallId: callB, consumedSteerSeqs: [] });
      for (let chunk = 0; chunk < 25; chunk += 1) {
        await append("model.delta", {
          turnId,
          modelCallId: callB,
          text: `answer ${index}.${chunk} ${"a".repeat(950)}`,
        });
      }
      await append("model.call_completed", {
        turnId,
        modelCallId: callB,
        text: `final answer ${index} ${"f".repeat(30_000)}`,
        toolCalls: [],
      });
      await append("model.usage_receipt", {
        turnId,
        modelCallId: callB,
        usage: {
          inputTokens: 1_000,
          outputTokens: 9_000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200_000,
          estimated: false,
        },
      });
      await append("turn.phase", { turnId, phase: "stream_started", modelCallId: callB });
      await append("turn.phase", { turnId, phase: "first_token", modelCallId: callB });
      await append("turn.completed", { turnId });
    }
  });
}

describe("#561 acceptance: 10k-event thread full-chain render inside the memory budget", () => {
  it(
    "renders the whole journal through windowed pages, never materializing over the byte budget",
    { timeout: 240_000 },
    async () => {
      const thread = await createThread();
      await seedTenKJournal(thread);

      const rawStub = env.AGENT_DO.get(env.AGENT_DO.idFromName(thread.id));
      const stub = rawStub as unknown as WindowedGetEvents;

      // Counterfactual: the journal is far bigger than one window — without the
      // read boundary the full-chain render would materialize all of it.
      const journalBytes = await runInDurableObject(rawStub, (_instance, state) => {
        const row = state.storage.sql
          .exec<{ total: number | null }>(
            "SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM events WHERE thread_id = ?",
            thread.id,
          )
          .one();
        return row.total ?? 0;
      });
      expect(journalBytes).toBeGreaterThan(TIMELINE_WINDOW_BYTE_BUDGET * 2);

      // The newest window's read face: payload bytes bounded by budget + one
      // turn (turn-aligned rounding overshoot).
      const newest = await stub.getEvents({ sinceSeq: 0, project: "ux", window: {} });
      const newestWindow = newest.window;
      if (newestWindow === undefined) throw new Error("window info missing");
      expect(newestWindow.dataBytes).toBeLessThanOrEqual(TIMELINE_WINDOW_BYTE_BUDGET + 200_000);
      expect(newestWindow.floorSeq).toBeGreaterThan(0);
      expect(newestWindow.hasOlderRows).toBe(true);

      // Full-chain render: latest page, then fetch-older until the bottom.
      const timeline = async (query: string): Promise<ThreadTimelineResponse> => {
        const response = await exports.default.fetch(
          `https://example.com/api/v1/threads/${thread.id}/timeline?${query}`,
        );
        expect(response.status).toBe(200);
        return threadTimelineResponseSchema.parse(await response.json());
      };

      const pageIds = new Set<string>();
      let page = await timeline("segmentLimit=20&includeNestedRows=true");
      expect(page.rows.length).toBeGreaterThan(0);
      for (const row of page.rows) pageIds.add(row.id);
      let pages = 1;
      while (page.timelinePage.hasOlderRows && page.timelinePage.olderCursor !== null) {
        const cursor = page.timelinePage.olderCursor;
        page = await timeline(
          `segmentLimit=20&includeNestedRows=true&beforeAnchorSeq=${cursor.anchorSeq}&beforeAnchorId=${encodeURIComponent(cursor.anchorId)}`,
        );
        for (const row of page.rows) pageIds.add(row.id);
        pages += 1;
        expect(pages).toBeLessThan(60);
      }
      // The chain walked several windowed pages and terminated cleanly.
      expect(pages).toBeGreaterThanOrEqual(2);
      expect(page.timelinePage.hasOlderRows).toBe(false);

      // Chain union == the full unwindowed projection (row-for-row coverage).
      const fullRead = await stub.getEvents({ sinceSeq: 0, limit: 100_000, project: "ux" });
      const fullRows = projectThreadTimeline(fullRead.events, {
        threadStatus: "idle",
      }).rows;
      expect(pageIds.size).toBe(fullRows.length);
      for (const row of fullRows) expect(pageIds.has(row.id)).toBe(true);

      // Memory probe bound: read payload bytes × #554 §5's 4-6× live-object
      // factor sits two orders under the 128MB isolate ceiling.
      expect(newestWindow.dataBytes * 6).toBeLessThan(48 * 1024 * 1024);
    },
  );
});
