import { describe, expect, it } from "vitest";
import {
  apiError,
  buildThreadEvent,
  createThreadRequestSchema,
  eventRowId,
  FIRST_SEQ,
  httpStatusForCode,
  isSeqContiguous,
  parseThreadEvent,
  promptContentSchema,
  realtimeClientMessageSchema,
  realtimeThreadChangedSchema,
  sendMessageRequestSchema,
  threadEventsResponseSchema,
  timelineResponseSchema,
  type ThreadEventEnvelope,
} from "../src/index.js";

/** A complete canned turn as fake-edge emits it, seq-contiguous. */
function cannedTurnEnvelopes(threadId: string): ThreadEventEnvelope[] {
  const base = { threadId, createdAt: 1_000 };
  const raw: [string, Record<string, unknown>][] = [
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
    ["item/started", { turnId: "turn_1", item: { type: "agentMessage", id: "itm_a", text: "" } }],
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
    const withGap = [events[0], events[2]].filter((envelope) => envelope !== undefined);
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

describe("delegation attribution (#274 J1 parentToolCallId)", () => {
  const envelope = (type: string, data: Record<string, unknown>, seq: number) => ({
    threadId: "thr_d",
    id: eventRowId("thr_d", seq),
    seq,
    type,
    data,
    createdAt: 2_000,
  });

  it("parses items and deltas carrying parentToolCallId", () => {
    const delegation = "thr_parent:5";
    const rows = [
      envelope(
        "item/started",
        {
          turnId: "turn_1",
          item: {
            type: "toolCall",
            id: "thr_child:3",
            tool: "read",
            arguments: { path: "a.ts" },
            status: "pending",
            output: "",
            completedAt: null,
            parentToolCallId: delegation,
          },
        },
        1,
      ),
      envelope(
        "item/agentMessage/delta",
        { turnId: "turn_1", itemId: "itm_a", delta: "hi", parentToolCallId: delegation },
        2,
      ),
      envelope(
        "item/reasoning/textDelta",
        { turnId: "turn_1", itemId: "itm_r", delta: "th", parentToolCallId: delegation },
        3,
      ),
      envelope(
        "item/completed",
        {
          turnId: "turn_1",
          item: {
            type: "agentMessage",
            id: "itm_a",
            text: "hi",
            parentToolCallId: delegation,
          },
        },
        4,
      ),
      envelope(
        "item/completed",
        {
          turnId: "turn_1",
          item: {
            type: "reasoning",
            id: "itm_r",
            summary: [],
            content: ["thought"],
            parentToolCallId: delegation,
          },
        },
        5,
      ),
    ].map(parseThreadEvent);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      // Deltas carry the field on the data payload; item events on the item.
      if (row.type === "item/agentMessage/delta" || row.type === "item/reasoning/textDelta") {
        expect(row.data.parentToolCallId).toBe(delegation);
      }
      if (row.type === "item/started" || row.type === "item/completed") {
        const { item } = row.data;
        if (item.type === "toolCall" || item.type === "agentMessage" || item.type === "reasoning") {
          expect(item.parentToolCallId).toBe(delegation);
        }
      }
    }
  });

  it("buildThreadEvent round-trips the field and rejects an empty id", () => {
    const built = buildThreadEvent({
      id: eventRowId("thr_d", 6),
      threadId: "thr_d",
      seq: 6,
      type: "item/started",
      data: {
        turnId: "turn_1",
        item: {
          type: "toolCall",
          id: "thr_child:3",
          tool: "task",
          arguments: {},
          status: "pending",
          output: "",
          completedAt: null,
          parentToolCallId: "thr_root:5",
        },
      },
      createdAt: 2_000,
    });
    expect(parseThreadEvent(built)).toEqual(built);
    const started = parseThreadEvent(built);
    if (started.type !== "item/started") throw new Error("unreachable");
    const empty = {
      ...built,
      data: {
        ...started.data,
        item: { ...started.data.item, parentToolCallId: "" },
      },
    };
    expect(() => parseThreadEvent(empty)).toThrow();
  });

  it("legacy rows without the field still parse (additive, scheme A)", () => {
    const legacy = envelope(
      "item/started",
      {
        turnId: "turn_1",
        item: {
          type: "toolCall",
          id: "thr_x:1",
          tool: "bash",
          arguments: {},
          status: "completed",
          output: "ok",
          completedAt: 3,
        },
      },
      7,
    );
    const parsed = parseThreadEvent(legacy);
    expect(parsed.data.parentToolCallId).toBeUndefined();
  });
});

describe("backgroundTask thread-scoped family (#275 J3)", () => {
  const envelope = (type: string, data: Record<string, unknown>, seq: number) => ({
    threadId: "thr_bt",
    id: eventRowId("thr_bt", seq),
    seq,
    type,
    data,
    createdAt: 3_000,
  });

  const item = {
    type: "backgroundTask" as const,
    id: "task:sp_1#0",
    taskType: "local_subagent",
    description: "Report the answer",
    status: "pending",
    taskStatus: "running",
    skipTranscript: false,
    parentToolCallId: "thr_root:5",
  };

  it("parses the backgroundTask item through the item union", () => {
    const row = parseThreadEvent(envelope("item/started", { turnId: "turn_1", item }, 1));
    if (row.type !== "item/started") throw new Error("unreachable");
    expect(row.data.item.type).toBe("backgroundTask");
    if (row.data.item.type !== "backgroundTask") throw new Error("unreachable");
    expect(row.data.item.taskStatus).toBe("running");
    expect(row.data.item.parentToolCallId).toBe("thr_root:5");
  });

  it("round-trips progress and completed events without a turnId (thread scope)", () => {
    for (const type of ["item/backgroundTask/progress", "item/backgroundTask/completed"] as const) {
      const built = buildThreadEvent({
        id: eventRowId("thr_bt", 2),
        threadId: "thr_bt",
        seq: 2,
        type,
        data: {
          item: { ...item, status: "completed", taskStatus: "completed", summary: "42" },
        },
        createdAt: 3_000,
      });
      const parsed = parseThreadEvent(built);
      expect(parsed).toEqual(built);
      expect(parsed.data).not.toHaveProperty("turnId");
      if (parsed.type !== type) throw new Error("unreachable");
      expect(parsed.data.item.summary).toBe("42");
    }
  });

  it("rejects an unknown taskStatus and a legacy ux stream still parses", () => {
    const bad = envelope(
      "item/backgroundTask/completed",
      { item: { ...item, taskStatus: "nope" } },
      3,
    );
    expect(() => parseThreadEvent(bad)).toThrow();
    // The canned pre-J3 turn (no backgroundTask rows anywhere) is untouched.
    const events = cannedTurnEnvelopes("thr_legacy").map(parseThreadEvent);
    expect(events).toHaveLength(9);
  });
});

describe("contextWindowUsage event (#308)", () => {
  const envelope = (data: unknown, seq = 7) => ({
    threadId: "thr_cw",
    id: eventRowId("thr_cw", seq),
    seq,
    type: "thread/contextWindowUsage/updated",
    data,
    createdAt: 4_000,
  });

  it("round-trips a complete usage row", () => {
    const built = envelope({
      contextWindowUsage: { usedTokens: 9342, modelContextWindow: 200_000, estimated: false },
    });
    const parsed = parseThreadEvent(built);
    expect(parsed).toEqual(built);
    if (parsed.type !== "thread/contextWindowUsage/updated") throw new Error("unreachable");
    expect(parsed.data.contextWindowUsage.usedTokens).toBe(9342);
  });

  it("rejects a guessed row: unknown window, negative fill, non-boolean estimated", () => {
    for (const bad of [
      envelope({ contextWindowUsage: { usedTokens: 10, modelContextWindow: null, estimated: false } }),
      envelope({ contextWindowUsage: { usedTokens: -1, modelContextWindow: 200_000, estimated: false } }),
      envelope({ contextWindowUsage: { usedTokens: 10, modelContextWindow: 200_000 } }),
    ]) {
      expect(() => parseThreadEvent(bad)).toThrow();
    }
  });
});

describe("prompt content image union (#317)", () => {
  const imageInput = [
    { type: "image", url: "https://example.com/cat.png" },
    { type: "localImage", path: "9f86d081884c7d659a2feaa0c55ad015.png" },
    {
      type: "localFile",
      path: "5f2b3c....pdf",
      name: "doc.pdf",
      sizeBytes: 8,
      mimeType: "application/pdf",
    },
  ] as const;

  it("parses every member on the create/send request input", () => {
    for (const member of imageInput) {
      expect(promptContentSchema.parse(member)).toEqual(member);
    }
    expect(sendMessageRequestSchema.parse({ input: [...imageInput] }).input).toEqual([
      ...imageInput,
    ]);
    expect(createThreadRequestSchema.parse({ input: [...imageInput] }).input).toEqual([
      ...imageInput,
    ]);
  });

  it("keeps the localFile presentation fields optional", () => {
    expect(promptContentSchema.parse({ type: "localFile", path: "a.bin" })).toEqual({
      type: "localFile",
      path: "a.bin",
    });
  });

  it("rejects a non-URL image member and an unknown type", () => {
    expect(promptContentSchema.safeParse({ type: "image", url: "not a url" }).success).toBe(false);
    expect(promptContentSchema.safeParse({ type: "localImage" }).success).toBe(false);
    expect(promptContentSchema.safeParse({ type: "video", url: "https://x.test/v.mp4" }).success)
      .toBe(false);
  });
});
