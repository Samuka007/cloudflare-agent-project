import type { DaemonThreadEventInput, ThreadEventEnvelope } from "@cap/protocol";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  ConversationId,
  EntryId,
  EntryRecord,
  TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { PiEventBridge, type ThreadEventSink } from "../src/events";

class MemorySink implements ThreadEventSink {
  readonly envelopes: ThreadEventEnvelope[] = [];
  readonly #byId = new Map<string, ThreadEventEnvelope>();
  #seq = 0;

  append(input: DaemonThreadEventInput): Promise<ThreadEventEnvelope> {
    const existing = this.#byId.get(input.id);
    if (existing !== undefined) return Promise.resolve(existing);
    const envelope = { ...input, seq: ++this.#seq };
    this.#byId.set(input.id, envelope);
    this.envelopes.push(envelope);
    return Promise.resolve(envelope);
  }

  findSeq(id: string): Promise<number | undefined> {
    return Promise.resolve(this.#byId.get(id)?.seq);
  }
}

const conversationId = 1 as ConversationId;

const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Hello" }],
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
  stopReason: "stop",
  timestamp: 1,
} as unknown as AssistantMessage;

const toolResult: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "bash",
  content: [{ type: "text", text: "out" }],
  isError: false,
  timestamp: 2,
} as unknown as ToolResultMessage;

function entry(id: number, kind: string, model?: EntryRecord["model"]): EntryRecord {
  return {
    id,
    conversationId,
    kind,
    ...(model === undefined ? {} : { model }),
  } as EntryRecord;
}

const deltaEvent: AgentEvent = {
  type: "message_update",
  usage: {} as never,
  changes: [
    { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
    { type: "text_delta", contentIndex: 0, delta: "Hello" },
  ],
};

describe("pi event bridge", () => {
  it("translates one turn into cap envelopes", async () => {
    const sink = new MemorySink();
    const bridge = new PiEventBridge({ threadId: "thread-1", sink, now: () => 10 });
    const envelopes = await bridge.ingest([
      { type: "turn_start" },
      { type: "message_start", message: assistant },
      deltaEvent,
      { type: "message_end", entry: entry(1, "pi.assistant", [assistant]) },
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "echo hi" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        entry: entry(2, "pi.tool-result", [toolResult]),
      },
      { type: "turn_end" },
    ]);
    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      "turn/started",
      "item/agentMessage/delta",
      "item/completed",
      "item/started",
      "item/completed",
      "turn/completed",
    ]);
    expect(envelopes[1]?.data).toMatchObject({
      turnId: "turn-thread-1-1",
      itemId: "itm-am-turn-thread-1-1:mc-1",
      delta: "Hello",
    });
    expect(envelopes[2]?.data).toMatchObject({
      item: { type: "agentMessage", text: "Hello" },
    });
    expect(envelopes[4]?.data).toMatchObject({
      item: { type: "toolCall", status: "completed", output: "out" },
    });
    expect(envelopes[5]?.data).toMatchObject({ status: "completed", error: null });
  });

  it("deduplicates a replayed delta batch by source id", async () => {
    const sink = new MemorySink();
    const bridge = new PiEventBridge({ threadId: "thread-1", sink, now: () => 10 });
    const first = await bridge.ingest([
      { type: "turn_start" },
      { type: "message_start", message: assistant },
      deltaEvent,
    ]);
    const again = await bridge.ingest([deltaEvent]);
    expect(again.map((envelope) => envelope.seq)).toEqual([first[first.length - 1]?.seq]);
    expect(sink.envelopes).toHaveLength(2);
  });

  it("maps thinking deltas to reasoning rows", async () => {
    const sink = new MemorySink();
    const bridge = new PiEventBridge({ threadId: "thread-1", sink, now: () => 10 });
    const envelopes = await bridge.ingest([
      { type: "turn_start" },
      {
        type: "message_update",
        usage: {} as never,
        changes: [
          { type: "thinking_start", contentIndex: 1, block: { type: "thinking", thinking: "" } },
          { type: "thinking_delta", contentIndex: 1, delta: "plan" },
        ],
      },
    ]);
    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      "turn/started",
      "item/reasoning/textDelta",
    ]);
    expect(envelopes[1]?.data).toMatchObject({ delta: "plan" });
  });

  it("marks a tool without a result entry as interrupted", async () => {
    const sink = new MemorySink();
    const bridge = new PiEventBridge({ threadId: "thread-1", sink, now: () => 10 });
    const envelopes = await bridge.ingest([
      { type: "turn_start" },
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash" },
    ]);
    expect(envelopes[1]?.data).toMatchObject({
      item: { type: "toolCall", status: "interrupted", output: "" },
    });
  });

  it("maps task_failed to system/error and a failed turn", async () => {
    const sink = new MemorySink();
    const bridge = new PiEventBridge({ threadId: "thread-1", sink, now: () => 10 });
    const envelopes = await bridge.ingest([
      { type: "turn_start" },
      { type: "task_failed", taskId: 1 as TaskId, kind: "generation", message: "boom" },
      { type: "turn_end" },
    ]);
    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      "turn/started",
      "system/error",
      "turn/completed",
    ]);
    expect(envelopes[1]?.data).toEqual({ message: "boom", category: "internal" });
    expect(envelopes[2]?.data).toMatchObject({
      status: "failed",
      error: { category: "internal", message: "boom" },
    });
  });

  it("surfaces a provider stream error instead of an empty bubble (#619)", async () => {
    const sink = new MemorySink();
    const bridge = new PiEventBridge({ threadId: "thread-1", sink, now: () => 10 });
    const failed: AssistantMessage = {
      ...assistant,
      content: [],
      stopReason: "error",
      errorMessage: "Connection error.",
    };
    const envelopes = await bridge.ingest([
      { type: "turn_start" },
      { type: "message_start", message: failed },
      { type: "message_end", entry: entry(1, "pi.assistant", [failed]) },
      { type: "turn_end" },
    ]);
    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      "turn/started",
      "system/error",
      "turn/completed",
    ]);
    expect(envelopes[1]?.data).toEqual({
      message: "Connection error.",
      category: "internal",
    });
    expect(envelopes[2]?.data).toMatchObject({
      status: "failed",
      error: { category: "internal", message: "Connection error." },
    });
    expect(sink.envelopes.some((envelope) => envelope.type === "item/completed")).toBe(false);
  });

  it("deduplicates repeated provider errors from auto-retry attempts", async () => {
    const sink = new MemorySink();
    const bridge = new PiEventBridge({ threadId: "thread-1", sink, now: () => 10 });
    const failed: AssistantMessage = {
      ...assistant,
      content: [],
      stopReason: "error",
      errorMessage: "model_not_found",
    };
    await bridge.ingest([
      { type: "turn_start" },
      { type: "message_start", message: failed },
      { type: "message_end", entry: entry(1, "pi.assistant", [failed]) },
      { type: "message_start", message: failed },
      { type: "message_end", entry: entry(2, "pi.assistant", [failed]) },
    ]);
    const errors = sink.envelopes.filter((envelope) => envelope.type === "system/error");
    expect(errors).toHaveLength(1);
  });

  it("maps a compaction entry to thread/compacted with the head seq", async () => {
    const sink = new MemorySink();
    await sink.append({
      id: "pi-entry-5",
      threadId: "thread-1",
      type: "system/error",
      data: { message: "placeholder", category: "internal" },
      createdAt: 1,
    });
    const bridge = new PiEventBridge({ threadId: "thread-1", sink, now: () => 10 });
    const envelopes = await bridge.ingest([
      { type: "turn_start" },
      {
        type: "compaction_start",
        taskId: 2 as TaskId,
        reason: "manual",
        blocking: true,
      },
      {
        type: "entry_appended",
        entry: { ...entry(9, "pi.compaction"), head: 5 as EntryId, byTaskId: 2 as TaskId },
      },
    ]);
    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      "turn/started",
      "thread/compacted",
    ]);
    expect(envelopes[1]?.data).toMatchObject({
      hideThroughSeq: 1,
      method: "manual",
      tokensBefore: null,
    });
  });
});
