import { describe, expect, test } from "vitest";
import { ResponsesRelayProvider } from "../src/relay/responses-provider.js";
import { responsesRequestBody } from "../src/relay/responses-wire.js";
import type { RelayConfig } from "../src/relay/anthropic-provider.js";
import type { ModelRequest, ModelUsageReceipt } from "../src/provider.js";

/**
 * #361 openai-responses adaptor: wire SHAPE (input items / function tools /
 * reasoning effort / max_output_tokens) and the SSE event mapping back onto
 * the existing model.delta/call_completed/usage chunk semantics (thinking
 * blocks, tool_calls, explicit termination). The official current Responses
 * schema is the protocol canon; the anthropic path (relay.test.ts) pins the
 * shared walk's zero-regression.
 */

const CONFIG: RelayConfig = {
  baseUrl: "https://newapi.test/v1",
  apiKey: "k-test",
  model: "glm-5.3-flash",
  maxTokens: 8192,
};

const REQUEST: ModelRequest = {
  threadId: "th-r",
  turnId: "t1",
  modelCallId: 1,
  input: "hi",
  inputImages: [],
  steers: [],
  priorCalls: [],
  asyncResults: [],
};

function streamResponse(text: string, chunkAt = Math.ceil(text.length / 2)): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, chunkAt)));
      controller.enqueue(encoder.encode(text.slice(chunkAt)));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** One SSE frame: `event:`/`data:` pair (Responses payloads carry `type`). */
function sse(events: Record<string, unknown>[]): string {
  return (
    events.map((payload) => `event: ${payload.type as string}\ndata: ${JSON.stringify(payload)}\n\n`).join("") +
    "\n"
  );
}

function completed(overrides: {
  usage?: Record<string, unknown>;
  status?: string;
}): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: overrides.status ?? "completed",
      error: null,
      incomplete_details: null,
      usage: overrides.usage ?? null,
    },
  };
}

async function collect(provider: ResponsesRelayProvider): Promise<{
  texts: string[];
  thinking: string[];
  usage: ModelUsageReceipt[];
  toolCalls: { name: string; arguments: Record<string, unknown> }[][];
}> {
  const texts: string[] = [];
  const thinking: string[] = [];
  const usage: ModelUsageReceipt[] = [];
  const toolCalls: { name: string; arguments: Record<string, unknown> }[][] = [];
  for await (const chunk of provider.streamTurn(REQUEST, {
    signal: new AbortController().signal,
  })) {
    if (chunk.kind === "text-delta") texts.push(chunk.text);
    else if (chunk.kind === "thinking-delta") thinking.push(chunk.text);
    else if (chunk.kind === "usage") usage.push(chunk.usage);
    else toolCalls.push(chunk.toolCalls);
  }
  return { texts, thinking, usage, toolCalls };
}

describe("responses wire: request shape", () => {
  test("input items fold the walked history (message → function_call → function_call_output)", () => {
    const body = responsesRequestBody(
      {
        ...REQUEST,
        input: "now summarize",
        priorCalls: [
          {
            modelCallId: 7,
            steers: [],
            text: "calling bash",
            toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }],
            toolResults: [
              { executionId: "ex-1", tool: "bash", status: "ok", output: "hi\n" },
            ],
            asyncResults: [],
          },
        ],
      },
      { model: "glm-5.3-flash", maxTokens: 2048, reasoningEffort: "none" },
    );
    expect(body.model).toBe("glm-5.3-flash");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(2048);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.instructions).toContain("agent-do（M0）的执行内核");
    expect(body.input).toEqual([
      // The turn input rides the opening user segment (walk push order —
      // the anthropic face's identical semantics).
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "now summarize" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "calling bash", annotations: [] }],
        status: "completed",
      },
      {
        type: "function_call",
        call_id: "toolu_ex-1",
        name: "bash",
        arguments: '{"command":"echo hi"}',
      },
      { type: "function_call_output", call_id: "toolu_ex-1", output: "hi\n" },
    ]);
  });

  test("empty tool output rides the sentinel; error results keep text only (no is_error seat)", () => {
    const body = responsesRequestBody(
      {
        ...REQUEST,
        priorCalls: [
          {
            modelCallId: 3,
            steers: [],
            text: "",
            toolCalls: [{ name: "bash", arguments: {} }],
            toolResults: [
              { executionId: "ex-e", tool: "bash", status: "error", output: "" },
            ],
            asyncResults: [],
          },
        ],
      },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "low" },
    );
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "function_call",
        call_id: "toolu_ex-e",
        name: "bash",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "toolu_ex-e", output: "(empty output)" },
    ]);
  });

  test("tools render as strict:false function tools; tool_choice forces the yield shape", () => {
    const body = responsesRequestBody(
      { ...REQUEST, toolChoice: { name: "yield" } },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "medium" },
    );
    expect(body.tool_choice).toEqual({ type: "function", name: "yield" });
    expect(body.tools).toBeDefined();
    const bash = body.tools?.find((tool) => tool.name === "bash");
    expect(bash).toMatchObject({ type: "function", strict: false });
    expect(bash?.parameters).toBeDefined();
  });

  test("compaction surface omits tools (no tool-use escape hatch from summarization)", () => {
    const body = responsesRequestBody(
      { ...REQUEST, toolSurface: "compaction" },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "none" },
    );
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  test("image dispatch (PM ②): capable rows project input_image parts; others degrade", () => {
    const images = [
      { kind: "url", url: "https://img.test/a.png" },
      { kind: "data", mediaType: "image/png", base64: "aGk=" },
      { kind: "path", path: "/tmp/x.png" },
    ] as const;
    const capable = responsesRequestBody(
      { ...REQUEST, input: "", inputImages: [...images] },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "none", supportsImageInput: true },
    );
    expect(capable.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_image", detail: "auto", image_url: "https://img.test/a.png" },
        { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGk=" },
        { type: "input_text", text: "[image attachment on disk: /tmp/x.png]" },
      ],
    });
    const degraded = responsesRequestBody(
      { ...REQUEST, input: "", inputImages: [...images] },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "none" },
    );
    const firstItem = degraded.input[0];
    expect(firstItem?.type).toBe("message");
    if (firstItem?.type !== "message") throw new Error("unreachable");
    const degradedParts = firstItem.content;
    expect(degradedParts.every((part) => part.type === "input_text")).toBe(true);
  });

  test("effort mapping (PM ①): the registry-resolved effort rides verbatim; xhigh→max via map", () => {
    const mapped = responsesRequestBody(
      { ...REQUEST },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "max" },
    );
    expect(mapped.reasoning).toEqual({ effort: "max" });
  });

  test("requests must open with a user message (walk invariant shared with the anthropic face)", () => {
    expect(() =>
      responsesRequestBody(
        { ...REQUEST, input: "", inputImages: [] },
        { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "none" },
      ),
    ).toThrow(/must open with a user message/);
  });
});

describe("responses client: stream mapping", () => {
  test("the acceptance turn: thinking + text + function_call map to the chunk semantics", async () => {
    const sseText = sse([
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "let me " },
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "check" },
      { type: "response.reasoning_summary_part.done", output_index: 0, part: { text: "check" } },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_1", role: "assistant" },
      },
      { type: "response.output_text.delta", output_index: 1, delta: "run" },
      { type: "response.output_text.delta", output_index: 1, delta: "ning" },
      { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1" } },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "bash", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        delta: '{"comm',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        delta: 'and":"echo hi"}',
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 2,
        arguments: '{"command":"echo hi"}',
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_9",
          name: "bash",
          arguments: '{"command":"echo hi"}',
        },
      },
      completed({
        usage: {
          input_tokens: 100,
          output_tokens: 42,
          total_tokens: 142,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 12 },
        },
      }),
    ]);
    const provider = new ResponsesRelayProvider({
      ...CONFIG,
      contextWindow: 200_000,
      fetchImpl: () => Promise.resolve(streamResponse(sseText, 120)),
    });
    const { texts, thinking, usage, toolCalls } = await collect(provider);
    expect(texts).toEqual(["run", "ning"]);
    // The reasoning_summary channel is the thinking block stream (PM's
    // glm-5.3-flash anchor); the part separator rides the same kind.
    expect(thinking).toEqual(["let me ", "check", "\n\n"]);
    // #308 receipt: input MINUS cached (openai counts cached inside input),
    // cacheRead = cached, cacheCreation = cache_write.
    expect(usage).toEqual([
      {
        inputTokens: 80,
        outputTokens: 42,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 5,
        contextWindow: 200_000,
        estimated: false,
      },
    ]);
    // One terminal tool-calls chunk, assembled complete (§2.2).
    expect(toolCalls).toEqual([[{ name: "bash", arguments: { command: "echo hi" } }]]);
    // The wire recorded the exact body (replay proof artifact).
    expect(provider.bodies).toHaveLength(1);
    const firstWire: unknown = JSON.parse(provider.bodies[0] ?? "{}");
    expect(firstWire).toMatchObject({ model: "glm-5.3-flash" });
  });

  test("refusal deltas surface as answer text (pi-ai anchor)", async () => {
    const sseText = sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant" },
      },
      { type: "response.refusal.delta", output_index: 0, delta: "cannot" },
      completed({}),
    ]);
    const provider = new ResponsesRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    const { texts, toolCalls } = await collect(provider);
    expect(texts).toEqual(["cannot"]);
    expect(toolCalls).toEqual([]);
  });

  test("no usage frame → bytes/4 estimate over the exact wire body, estimated: true", async () => {
    const sseText = sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant" },
      },
      { type: "response.output_text.delta", output_index: 0, delta: "hi" },
      completed({}),
    ]);
    const provider = new ResponsesRelayProvider({
      ...CONFIG,
      contextWindow: 200_000,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    const { usage } = await collect(provider);
    expect(usage[0]?.estimated).toBe(true);
    expect(usage[0]?.outputTokens).toBe(0);
    expect(usage[0]?.inputTokens).toBeGreaterThan(0);
  });
});

describe("responses client: seal semantics (type-58 lessons)", () => {
  test("EOF without response.completed is a break, never an implicit completion", async () => {
    const sseText = sse([
      { type: "response.output_text.delta", output_index: 0, delta: "partial" },
    ]).replace("\n\n", "");
    const provider = new ResponsesRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: "relay stream ended without response.completed",
      afterFirstByte: true,
      retryable: false,
    });
  });

  test("incomplete max_output_tokens seals (length 必停) before any usage chunk", async () => {
    const sseText = sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant" },
      },
      { type: "response.output_text.delta", output_index: 0, delta: "truncat" },
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      },
      completed({ status: "incomplete", usage: { input_tokens: 10, output_tokens: 99 } }),
    ]);
    const provider = new ResponsesRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: "relay response incomplete: max_output_tokens (length truncation — never continued)",
      afterFirstByte: true,
    });
  });

  test("response.failed carries the upstream error code and message", async () => {
    const sseText = sse([
      {
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "server_error", message: "upstream exploded" },
        },
      },
    ]);
    const provider = new ResponsesRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: "relay response failed: server_error upstream exploded",
      afterFirstByte: true,
    });
  });

  test("top-level error event seals afterFirstByte", async () => {
    const sseText = sse([{ type: "error", code: "rate_limit_exceeded", message: "slow down" }]);
    const provider = new ResponsesRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: "relay stream error: rate_limit_exceeded slow down",
      afterFirstByte: true,
    });
  });

  test("truncated tool arguments (no output_item.done) seal loudly", async () => {
    const sseText = sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "bash", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"comm' },
      completed({}),
    ]);
    const provider = new ResponsesRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: /incomplete arguments \(stream truncated mid-JSON\)/,
      afterFirstByte: true,
    });
  });
});

describe("responses client: pre-first-byte classification", () => {
  function statusProvider(status: number, payload: unknown): ResponsesRelayProvider {
    return new ResponsesRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(payload), { status })),
    });
  }

  test("429 → retryable pre-first-byte", async () => {
    const provider = statusProvider(429, { error: { message: "rate limited" } });
    await expect(collect(provider)).rejects.toMatchObject({
      retryable: true,
      afterFirstByte: false,
    });
  });

  test("400 → non-retryable pre-first-byte", async () => {
    const provider = statusProvider(400, { error: { message: "bad shape" } });
    await expect(collect(provider)).rejects.toMatchObject({
      retryable: false,
      afterFirstByte: false,
    });
  });

  test("connect failure → retryable, pre-first-byte", async () => {
    const provider = new ResponsesRelayProvider({
      ...CONFIG,
      fetchImpl: () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: "relay connect failed: fetch failed",
      retryable: true,
      afterFirstByte: false,
    });
  });

  test("the URL is {base}/responses with Bearer auth (omp models.yml posture)", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const provider = new ResponsesRelayProvider({
      ...CONFIG,
      fetchImpl: (input, init) => {
        seenUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seenAuth = String(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(streamResponse(sse([completed({})])));
      },
    });
    await collect(provider);
    expect(seenUrl).toBe("https://newapi.test/v1/responses");
    expect(seenAuth).toBe("Bearer k-test");
  });
});
