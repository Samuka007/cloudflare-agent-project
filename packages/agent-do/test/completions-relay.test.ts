import { describe, expect, test } from "vitest";
import { CompletionsRelayProvider } from "../src/relay/completions-provider.js";
import { completionsRequestBody } from "../src/relay/completions-wire.js";
import type { ModelRequest, ModelUsageReceipt } from "../src/provider.js";

/**
 * #363 openai-completions adaptor: wire SHAPE (messages / tools /
 * tool_choice / reasoning_effort) and the chat.completions SSE mapping back
 * onto the existing model.delta/call_completed/usage chunk semantics
 * (reasoning_content thinking channel, tool_calls fragments, [DONE]
 * explicit termination). The official current chat-completions schema is
 * the protocol canon; the responses/anthropic paths pin their own
 * zero-regression (responses-relay.test.ts / relay.test.ts).
 */

const CONFIG = {
  baseUrl: "https://newapi.test/v1",
  apiKey: "k-test",
  model: "glm-5.3-flash",
  maxTokens: 8192,
};

const REQUEST: ModelRequest = {
  threadId: "th-c",
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

/** One SSE data frame (`data: {...}\n\n`); chat wire carries no event: field. */
function sse(chunks: (Record<string, unknown> | "[DONE]")[]): string {
  return (
    chunks
      .map((payload) =>
        payload === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(payload)}\n\n`,
      )
      .join("") + "\n"
  );
}

function chunkWith(overrides: {
  content?: string | null;
  reasoning?: string;
  finish_reason?: string | null;
  toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[];
  refusal?: string;
}): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  if (overrides.content !== undefined) delta.content = overrides.content;
  if (overrides.reasoning !== undefined) delta.reasoning_content = overrides.reasoning;
  if (overrides.refusal !== undefined) delta.refusal = overrides.refusal;
  if (overrides.toolCalls !== undefined) {
    delta.tool_calls = overrides.toolCalls.map((entry) => ({
      index: entry.index,
      ...(entry.id === undefined ? {} : { id: entry.id, type: "function" }),
      function: {
        ...(entry.name === undefined ? {} : { name: entry.name }),
        ...(entry.arguments === undefined ? {} : { arguments: entry.arguments }),
      },
    }));
  }
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "glm-5.3-flash",
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: overrides.finish_reason ?? null,
      },
    ],
  };
}

function usageChunk(usage: Record<string, unknown> | null): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "glm-5.3-flash",
    choices: [],
    usage,
  };
}

async function collect(provider: CompletionsRelayProvider): Promise<{
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

describe("completions wire: request shape", () => {
  test("messages fold the walked history (system → user → assistant+tool_calls → tool)", () => {
    const body = completionsRequestBody(
      {
        ...REQUEST,
        input: "now summarize",
        priorCalls: [
          {
            modelCallId: 7,
            steers: [],
            text: "calling bash",
            toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }],
            toolResults: [{ executionId: "ex-1", tool: "bash", status: "ok", output: "hi\n" }],
            asyncResults: [],
          },
        ],
      },
      { model: "glm-5.3-flash", maxTokens: 2048, reasoningEffort: "none" },
    );
    expect(body.model).toBe("glm-5.3-flash");
    expect(body.stream).toBe(true);
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.reasoning_effort).toBe("none");
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toContain("agent-do（M0）的执行内核");
    expect(body.messages.slice(1)).toEqual([
      // The turn input rides the opening user segment (walk push order —
      // the responses face's identical semantics).
      { role: "user", content: [{ type: "text", text: "now summarize" }] },
      {
        role: "assistant",
        content: "calling bash",
        tool_calls: [
          {
            id: "toolu_ex-1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"echo hi"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_ex-1", content: "hi\n" },
    ]);
  });

  test("empty tool output rides the sentinel; empty assistant text rides null content", () => {
    const body = completionsRequestBody(
      {
        ...REQUEST,
        priorCalls: [
          {
            modelCallId: 3,
            steers: [],
            text: "",
            toolCalls: [{ name: "bash", arguments: {} }],
            toolResults: [{ executionId: "ex-e", tool: "bash", status: "error", output: "" }],
            asyncResults: [],
          },
        ],
      },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "low" },
    );
    expect(body.reasoning_effort).toBe("low");
    expect(body.messages[0]?.role).toBe("system");
    expect(typeof body.messages[0]?.content).toBe("string");
    expect(body.messages.slice(1)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "toolu_ex-e", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_ex-e", content: "(empty output)" },
    ]);
  });

  test("tools render as strict:false function tools; tool_choice forces the function shape", () => {
    const body = completionsRequestBody(
      { ...REQUEST, toolChoice: { name: "yield" } },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "medium" },
    );
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "yield" } });
    expect(body.tools).toBeDefined();
    const bash = body.tools?.find((tool) => tool.function.name === "bash");
    expect(bash).toMatchObject({ type: "function", function: { strict: false } });
    expect(bash?.function.parameters).toBeDefined();
  });

  test("compaction surface omits tools (no tool-use escape hatch from summarization)", () => {
    const body = completionsRequestBody(
      { ...REQUEST, toolSurface: "compaction" },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "none" },
    );
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  test("think tool renders or forceReasoningOff pins the effort to none (ToC pairing)", () => {
    const thinkCall = completionsRequestBody(
      { ...REQUEST, forceReasoningOff: true },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "high" },
    );
    expect(thinkCall.reasoning_effort).toBe("none");
    const thinkTool = completionsRequestBody(
      {
        ...REQUEST,
        experimentalGates: {
          externalThinking: true,
          contextNotes: false,
          checkpoint: false,
          generateImage: false,
        },
      },
      // A native-reasoning family (glm) filters the think tool at the
      // surface — the pin only fires on non-native families.
      { model: "qwen3", maxTokens: 100, reasoningEffort: "high" },
    );
    expect(thinkTool.reasoning_effort).toBe("none");
  });

  test("image dispatch (PM ②): capable rows project image_url parts; others degrade", () => {
    const images = [
      { kind: "url", url: "https://img.test/a.png" },
      { kind: "data", mediaType: "image/png", base64: "aGk=" },
      { kind: "path", path: "/tmp/x.png" },
    ] as const;
    const capable = completionsRequestBody(
      { ...REQUEST, input: "", inputImages: [...images] },
      {
        model: "glm-5.3-flash",
        maxTokens: 100,
        reasoningEffort: "none",
        supportsImageInput: true,
      },
    );
    expect(capable.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "https://img.test/a.png" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
        { type: "text", text: "[image attachment on disk: /tmp/x.png]" },
      ],
    });
    const degraded = completionsRequestBody(
      { ...REQUEST, input: "", inputImages: [...images] },
      { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "none" },
    );
    const degradedContent = degraded.messages[1]?.content;
    expect(Array.isArray(degradedContent)).toBe(true);
    if (Array.isArray(degradedContent)) {
      expect(degradedContent.every((part) => part.type === "text")).toBe(true);
    }
  });

  test("requests must open with a user message (walk invariant shared with the other faces)", () => {
    expect(() =>
      completionsRequestBody(
        { ...REQUEST, input: "", inputImages: [] },
        { model: "glm-5.3-flash", maxTokens: 100, reasoningEffort: "none" },
      ),
    ).toThrow(/must open with a user message/);
  });
});

describe("completions client: stream mapping", () => {
  test("the acceptance turn: reasoning + text + tool_calls fragments + usage + [DONE]", async () => {
    const sseText = sse([
      chunkWith({ reasoning: "let me " }),
      chunkWith({ reasoning: "check" }),
      chunkWith({ content: "run" }),
      chunkWith({ content: "ning" }),
      chunkWith({
        toolCalls: [{ index: 0, id: "call_9", name: "bash", arguments: '{"comm' }],
      }),
      chunkWith({ toolCalls: [{ index: 0, arguments: 'and":"echo hi"}' }] }),
      chunkWith({ finish_reason: "tool_calls", toolCalls: [] }),
      usageChunk({
        prompt_tokens: 100,
        completion_tokens: 42,
        total_tokens: 142,
        prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 12 },
      }),
      "[DONE]",
    ]);
    const provider = new CompletionsRelayProvider({
      ...CONFIG,
      contextWindow: 200_000,
      fetchImpl: () => Promise.resolve(streamResponse(sseText, 120)),
    });
    const { texts, thinking, usage, toolCalls } = await collect(provider);
    expect(texts).toEqual(["run", "ning"]);
    // The reasoning_content channel is the thinking block stream; the
    // first-non-empty-field anchor keeps `reasoning` echo upstreams from
    // duplicating it.
    expect(thinking).toEqual(["let me ", "check"]);
    // #308 receipt: prompt MINUS cached (openai counts cached inside
    // prompt_tokens), cacheRead = cached, cacheCreation = cache_write.
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

  test("interleaved parallel tool_calls accumulate by index; ids stay first-seen", async () => {
    const sseText = sse([
      chunkWith({
        toolCalls: [{ index: 0, id: "call_A", name: "bash", arguments: '{"command":' }],
      }),
      chunkWith({
        toolCalls: [{ index: 1, id: "call_B", name: "echo", arguments: '{"text":' }],
      }),
      chunkWith({ toolCalls: [{ index: 0, arguments: '"echo hi"}' }] }),
      chunkWith({ toolCalls: [{ index: 1, arguments: '"hi"}' }] }),
      chunkWith({ finish_reason: "tool_calls" }),
      usageChunk({
        prompt_tokens: 50,
        completion_tokens: 20,
        total_tokens: 70,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
      "[DONE]",
    ]);
    const provider = new CompletionsRelayProvider({
      ...CONFIG,
      contextWindow: 200_000,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    const { toolCalls, usage } = await collect(provider);
    expect(usage[0]).toMatchObject({ inputTokens: 50, outputTokens: 20 });
    expect(toolCalls).toEqual([
      [
        { name: "bash", arguments: { command: "echo hi" } },
        { name: "echo", arguments: { text: "hi" } },
      ],
    ]);
  });

  test("dual reasoning fields (reasoning_content + reasoning echo) yield one thinking stream", async () => {
    const sseText = sse([
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "A", reasoning: "A-echo" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { reasoning_content: "B", reasoning: "B-echo" }, finish_reason: null },
        ],
      },
      chunkWith({ finish_reason: "stop" }),
      usageChunk({ prompt_tokens: 10, completion_tokens: 5 }),
      "[DONE]",
    ]);
    const provider = new CompletionsRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    const { thinking, texts } = await collect(provider);
    expect(thinking).toEqual(["A", "B"]);
    expect(texts).toEqual([]);
  });

  test("refusal deltas surface as answer text (official refusal channel)", async () => {
    const sseText = sse([
      chunkWith({ refusal: "cannot" }),
      chunkWith({ finish_reason: "stop" }),
      usageChunk(null),
      "[DONE]",
    ]);
    const provider = new CompletionsRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    const { texts, toolCalls } = await collect(provider);
    expect(texts).toEqual(["cannot"]);
    expect(toolCalls).toEqual([]);
  });

  test("no usage frame → bytes/4 estimate over the exact wire body, estimated: true", async () => {
    const sseText = sse([
      chunkWith({ content: "hi" }),
      chunkWith({ finish_reason: "stop" }),
      "[DONE]",
    ]);
    const provider = new CompletionsRelayProvider({
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

describe("completions client: seal semantics (type-58 analog)", () => {
  test("EOF without [DONE] is a break, never an implicit completion", async () => {
    const sseText = sse([chunkWith({ content: "partial" })]);
    const provider = new CompletionsRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: "relay stream ended without [DONE]",
      afterFirstByte: true,
      retryable: false,
    });
  });

  test("finish_reason length seals (length 必停) before any usage chunk", async () => {
    const sseText = sse([
      chunkWith({ content: "truncat" }),
      chunkWith({ finish_reason: "length" }),
      usageChunk({ prompt_tokens: 10, completion_tokens: 99 }),
      "[DONE]",
    ]);
    const provider = new CompletionsRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message:
        "relay response truncated: finish_reason length (max_completion_tokens — never continued)",
      afterFirstByte: true,
    });
  });

  test("finish_reason content_filter seals afterFirstByte", async () => {
    const sseText = sse([
      chunkWith({ content: "I cant" }),
      chunkWith({ finish_reason: "content_filter" }),
      "[DONE]",
    ]);
    const provider = new CompletionsRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: "relay response stopped: finish_reason content_filter",
      afterFirstByte: true,
    });
  });

  test("truncated tool arguments (stream cut mid-JSON) seal loudly at [DONE]", async () => {
    const sseText = sse([
      chunkWith({ toolCalls: [{ index: 0, id: "call_9", name: "bash", arguments: '{"comm' }] }),
      chunkWith({ finish_reason: "tool_calls" }),
      "[DONE]",
    ]);
    const provider = new CompletionsRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sseText)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: /incomplete arguments \(stream truncated mid-JSON\)/,
      afterFirstByte: true,
    });
  });

  test("malformed SSE JSON seals afterFirstByte", async () => {
    const provider = new CompletionsRelayProvider({
      ...CONFIG,
      fetchImpl: () =>
        Promise.resolve(streamResponse('data: {"choices":broken\n\n' + "data: [DONE]\n\n")),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: /malformed SSE JSON/,
      afterFirstByte: true,
    });
  });
});

describe("completions client: pre-first-byte classification", () => {
  function statusProvider(status: number, body: string): CompletionsRelayProvider {
    return new CompletionsRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(new Response(body, { status })),
    });
  }

  test("429 → retryable pre-first-byte", async () => {
    const provider = statusProvider(429, '{"error":{"message":"rate limited"}}');
    await expect(collect(provider)).rejects.toMatchObject({
      retryable: true,
      afterFirstByte: false,
    });
  });

  test("400 → non-retryable pre-first-byte", async () => {
    const provider = statusProvider(400, '{"error":{"message":"bad shape"}}');
    await expect(collect(provider)).rejects.toMatchObject({
      retryable: false,
      afterFirstByte: false,
    });
  });

  test("connect failure → retryable, pre-first-byte", async () => {
    const provider = new CompletionsRelayProvider({
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

  test("the URL is {base}/chat/completions with Bearer auth (omp models.yml posture)", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const provider = new CompletionsRelayProvider({
      ...CONFIG,
      fetchImpl: (input, init) => {
        seenUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seenAuth = String(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          streamResponse(
            sse([chunkWith({ content: "ok" }), chunkWith({ finish_reason: "stop" }), "[DONE]"]),
          ),
        );
      },
    });
    await collect(provider);
    expect(seenUrl).toBe("https://newapi.test/v1/chat/completions");
    expect(seenAuth).toBe("Bearer k-test");
  });
});
