import { describe, expect, it } from "vitest";
import {
  apiError,
  buildThreadEvent,
  eventRowId,
  FIRST_SEQ,
  httpStatusForCode,
  isSeqContiguous,
  parseThreadEvent,
  realtimeClientMessageSchema,
  realtimeThreadChangedSchema,
  threadEventsResponseSchema,
  timelineResponseSchema,
  type ThreadEventEnvelope,
} from "../src/index.js";

/** A complete canned turn as fake-edge emits it, seq-contiguous. */
function cannedTurnEnvelopes(threadId: string): ThreadEventEnvelope[] {
  const base = { threadId, createdAt: 1_000 };
  const raw: Array<[string, Record<string, unknown>]> = [
    ["client/thread/start", { title: "hello" }],
    [
      "client/turn/requested",
      {
        turnId: "turn_1",
        clientRequestId: "req_1",
        initiator: "user",
        input: [{ type: "text", text: "hi" }],
      },
    ],
    ["turn/started", { turnId: "turn_1" }],
    [
      "item/started",
      {
        turnId: "turn_1",
        item: {
          type: "userMessage",
          id: "itm_u",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ],
    [
      "item/started",
      { turnId: "turn_1", item: { type: "agentMessage", id: "itm_a", text: "" } },
    ],
    ["item/agentMessage/delta", { turnId: "turn_1", itemId: "itm_a", delta: "he" }],
    ["item/agentMessage/delta", { turnId: "turn_1", itemId: "itm_a", delta: "llo" }],
    [
      "item/completed",
      { turnId: "turn_1", item: { type: "agentMessage", id: "itm_a", text: "hello" } },
    ],
    ["turn/completed", { turnId: "turn_1", status: "completed", error: null }],
  ];
  return raw.map(([type, data], index) => ({
    ...base,
    id: eventRowId(threadId, index + FIRST_SEQ),
    seq: index + FIRST_SEQ,
    type,
    data,
  }));
}

describe("event log schema", () => {
  it("parses a complete canned turn with typed data", () => {
    const events = cannedTurnEnvelopes("thr_t").map(parseThreadEvent);
    expect(events).toHaveLength(9);
    expect(events[1]?.type).toBe("client/turn/requested");
    if (events[1]?.type === "client/turn/requested") {
      expect(events[1].data.clientRequestId).toBe("req_1");
    }
    const last = events.at(-1);
    expect(last?.type).toBe("turn/completed");
    if (last?.type === "turn/completed") {
      expect(last.data.status).toBe("completed");
      expect(last.data.error).toBeNull();
    }
  });

  it("rejects a server-owned seq violation and malformed data", () => {
    const [first] = cannedTurnEnvelopes("thr_t");
    expect(first).toBeDefined();
    const badSeq = { ...first, seq: 0 };
    expect(() => parseThreadEvent(badSeq)).toThrow();
    const badData = {
      ...cannedTurnEnvelopes("thr_t")[1],
      data: { turnId: "turn_1" },
    };
    expect(() => parseThreadEvent(badData)).toThrow();
  });

  it("rejects unknown event types", () => {
    const envelope = cannedTurnEnvelopes("thr_t")[0];
    expect(() => parseThreadEvent({ ...envelope, type: "future/thing" })).toThrow();
  });

  it("buildThreadEvent round-trips through parseThreadEvent", () => {
    const built = buildThreadEvent({
      id: eventRowId("thr_x", 1),
      threadId: "thr_x",
      seq: 1,
      type: "system/error",
      data: { message: "machine went away", category: "machine_disconnected" },
      createdAt: 5,
    });
    expect(parseThreadEvent(built)).toEqual(built);
  });
});

describe("seq/replay semantics", () => {
  it("contiguity helper accepts full logs and suffix replays", () => {
    const events = cannedTurnEnvelopes("thr_t");
    expect(isSeqContiguous(events)).toBe(true);
    expect(isSeqContiguous(events.slice(4), 5)).toBe(true);
    const withGap = [events[0], events[2]].filter(
      (envelope) => envelope !== undefined,
    );
    expect(isSeqContiguous(withGap)).toBe(false);
  });

  it("events response schema validates a replay page", () => {
    const events = cannedTurnEnvelopes("thr_t");
    const parsed = threadEventsResponseSchema.parse({
      threadId: "thr_t",
      events,
      latestSeq: events.length,
      hasMore: false,
    });
    expect(parsed.events).toHaveLength(events.length);
  });
});

describe("timeline schema", () => {
  it("accepts conversation, work and system rows", () => {
    const parsed = timelineResponseSchema.parse({
      threadId: "thr_t",
      latestSeq: 9,
      rows: [
        {
          kind: "conversation",
          id: "row:2",
          threadId: "thr_t",
          turnId: "turn_1",
          sourceSeqStart: 2,
          sourceSeqEnd: 4,
          startedAt: 1,
          createdAt: 1,
          status: "completed",
          role: "user",
          text: "hi",
        },
        {
          kind: "work",
          id: "row:5",
          threadId: "thr_t",
          turnId: "turn_1",
          sourceSeqStart: 5,
          sourceSeqEnd: 6,
          startedAt: 1,
          createdAt: 1,
          status: "completed",
          workKind: "command",
          callId: "call_1",
          command: "echo hi",
          toolName: null,
          output: "hi\n",
          exitCode: 0,
          completedAt: 2,
        },
        {
          kind: "system",
          id: "row:9",
          threadId: "thr_t",
          turnId: null,
          sourceSeqStart: 9,
          sourceSeqEnd: 9,
          startedAt: 1,
          createdAt: 1,
          status: "error",
          systemKind: "error",
          title: "machine_disconnected",
          detail: null,
        },
      ],
    });
    expect(parsed.rows).toHaveLength(3);
  });
});

describe("realtime ws contract", () => {
  it("round-trips subscribe and changed messages", () => {
    const subscribe = realtimeClientMessageSchema.parse({
      type: "subscribe",
      target: { kind: "thread-detail", threadId: "thr_t" },
    });
    expect(subscribe.type).toBe("subscribe");
    const changed = realtimeThreadChangedSchema.parse({
      type: "changed",
      entity: "thread",
      id: "thr_t",
      changes: ["events-appended"],
      metadata: { latestSeq: 9 },
    });
    expect(changed.changes).toEqual(["events-appended"]);
  });
});

describe("errors", () => {
  it("maps codes to http status and retryability", () => {
    expect(httpStatusForCode("not_found")).toBe(404);
    expect(httpStatusForCode("machine_unavailable")).toBe(503);
    const err = apiError("conflict", "turn already active", { reason: "turn-active" });
    expect(err.retryable).toBe(false);
  });
});
