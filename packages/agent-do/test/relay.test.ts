import { describe, expect, test } from "vitest";
import { AnthropicRelayProvider, type RelayConfig } from "../src/relay/anthropic-provider.js";
import { parseFindNoulReply, splitFindAnswerLines } from "../src/tools/find-protocol.js";
import type { ModelRequest, ModelStreamChunk, ModelUsageReceipt } from "../src/provider.js";

/**
 * Real-client behavior against scripted SSE streams: happy path assembly,
 * thinking-block containment, seal semantics (break/EOF/length/bad args),
 * pre-first-byte retryability classes, and abort shape.
 */

const CONFIG: RelayConfig = {
  baseUrl: "https://relay.test/api/anthropic",
  apiKey: "k-test",
  model: "glm-5.3",
  maxTokens: 8192,
  thinking: { type: "disabled" },
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

/** Build a Response whose body streams the given text in two chunks. */
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

function sseLines(events: [string, unknown][]): string {
  return events
    .map(([name, payload]) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
    .join("");
}

function messageStart(): [string, unknown] {
  return ["message_start", { type: "message_start", message: { id: "m1", usage: {} } }];
}

function messageStop(): [string, unknown] {
  return ["message_stop", { type: "message_stop" }];
}

async function collect(provider: AnthropicRelayProvider): Promise<{
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

describe("relay client: happy paths", () => {
  test("text deltas stream through; tool_use assembles into one terminal chunk", async () => {
    const sse =
      sseLines([
        messageStart(),
        [
          "content_block_start",
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
        ],
        [
          "content_block_delta",
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        ],
        [
          "content_block_delta",
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "call_1", name: "bash" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"comm' },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: 'and":"echo hi"}' },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }],
        messageStop(),
      ]) + "\n";
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sse, 40)),
    });
    const { texts, toolCalls } = await collect(provider);
    expect(texts).toEqual(["Hel", "lo"]);
    expect(toolCalls).toEqual([[{ name: "bash", arguments: { command: "echo hi" } }]]);
    const recordedBody = provider.bodies[0];
    if (recordedBody === undefined) throw new Error("provider recorded no request body");
    const body = JSON.parse(recordedBody) as {
      stream: unknown;
      thinking: unknown;
      model: unknown;
      tools: { name: unknown }[];
      messages: { content: { text: unknown }[] }[];
    };
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.model).toBe("glm-5.3");
    // #257 wire verdict: the native-reasoning glm family never renders the
    // external-CoT tool even with gates on.
    expect(body.tools.some((tool) => tool.name === "think")).toBe(false);
    expect(body.tools[0]?.name).toBe("bash");
    expect(body.messages[0]?.content[0]?.text).toBe("hi");
  });

  test("thinking deltas surface as their own chunk kind, never as answer text (#257)", async () => {
    const sse =
      sseLines([
        messageStart(),
        [
          "content_block_start",
          { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "let me think" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig" },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "content_block_start",
          { type: "content_block_start", index: 1, content_block: { type: "text" } },
        ],
        [
          "content_block_delta",
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }],
        messageStop(),
      ]) + "\n";
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sse)),
    });
    const { texts, thinking } = await collect(provider);
    expect(texts).toEqual(["answer"]);
    expect(thinking).toEqual(["let me think"]);
  });
});

describe("relay client: seal semantics (post-first-byte, never re-called)", () => {
  test("mid-stream break → afterFirstByte seal error", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseLines([
              messageStart(),
              [
                "content_block_start",
                { type: "content_block_start", index: 0, content_block: { type: "text" } },
              ],
              [
                "content_block_delta",
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "par" },
                },
              ],
            ]),
          ),
        );
        controller.error(new TypeError("network reset"));
      },
    });
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(new Response(body, { status: 200 })),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      name: "ModelProviderError",
      retryable: false,
      afterFirstByte: true,
    });
  });

  test("EOF without message_stop is a break, never an implicit completion", async () => {
    const sse = sseLines([
      messageStart(),
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut" } },
      ],
    ]);
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sse)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: expect.stringContaining("without message_stop"),
      afterFirstByte: true,
      retryable: false,
    } satisfies Record<string, unknown>);
  });

  test("stop_reason=max_tokens seals (length truncation never continues)", async () => {
    const sse =
      sseLines([
        messageStart(),
        [
          "content_block_start",
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
        ],
        [
          "content_block_delta",
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: {} },
        ],
        messageStop(),
      ]) + "\n";
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sse)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: expect.stringContaining("max_tokens"),
      afterFirstByte: true,
    } satisfies Record<string, unknown>);
  });

  test("truncated tool arguments seal at content_block_stop", async () => {
    const sse =
      sseLines([
        messageStart(),
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "call_1", name: "bash" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"command": "echo' },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }],
        messageStop(),
      ]) + "\n";
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sse)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: expect.stringContaining("incomplete arguments"),
      afterFirstByte: true,
    } satisfies Record<string, unknown>);
  });

  test("in-band SSE error event seals", async () => {
    const sse =
      sseLines([
        messageStart(),
        ["error", { type: "error", error: { type: "overloaded_error", message: "boom" } }],
      ]) + "\n";
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(streamResponse(sse)),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: expect.stringContaining("overloaded_error"),
      afterFirstByte: true,
    } satisfies Record<string, unknown>);
  });
});

describe("relay client: pre-first-byte classification", () => {
  function statusProvider(status: number, payload: unknown): AnthropicRelayProvider {
    return new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(payload), { status })),
    });
  }

  test("429 → retryable, pre-first-byte", async () => {
    const provider = statusProvider(429, { type: "error", error: { type: "rate_limit_error" } });
    await expect(collect(provider)).rejects.toMatchObject({
      name: "ModelProviderError",
      retryable: true,
      afterFirstByte: false,
    });
  });

  test("401 → non-retryable auth failure", async () => {
    const provider = statusProvider(401, {
      type: "error",
      error: { type: "authentication_error" },
    });
    await expect(collect(provider)).rejects.toMatchObject({
      retryable: false,
      afterFirstByte: false,
      message: expect.stringContaining("401"),
    } satisfies Record<string, unknown>);
  });

  test("5xx → retryable", async () => {
    const provider = statusProvider(503, { error: "upstream" });
    await expect(collect(provider)).rejects.toMatchObject({ retryable: true });
  });

  test("connect failure → retryable, pre-first-byte", async () => {
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(collect(provider)).rejects.toMatchObject({
      retryable: true,
      afterFirstByte: false,
    });
  });
});

describe("relay client: abort", () => {
  test("abort mid-stream throws the preferred abort shape", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(
          encoder.encode(
            sseLines([
              messageStart(),
              [
                "content_block_delta",
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
              ],
            ]),
          ),
        );
        // fake fetch bodies must honor the signal the way real ones do:
        // abort breaks the pending read with an AbortError.
        controller.signal.addEventListener(
          "abort",
          () => {
            stream.error(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true },
        );
      },
    });
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () => Promise.resolve(new Response(body, { status: 200 })),
    });
    const iterator = provider
      .streamTurn(REQUEST, { signal: controller.signal })
      [Symbol.asyncIterator]() as AsyncIterator<ModelStreamChunk, undefined>;
    const first = await iterator.next();
    if (first.done) throw new Error("expected a first chunk before abort");
    expect(first.value.kind).toBe("text-delta");
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({
      message: expect.stringContaining("abort"),
      retryable: false,
      afterFirstByte: true,
    } satisfies Record<string, unknown>);
  });
});

describe("relay client: usage receipt (#308)", () => {
  test("message_start input side + final message_delta output total ride one usage chunk", async () => {
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      contextWindow: 200_000,
      fetchImpl: () =>
        Promise.resolve(
          streamResponse(
            sseLines([
              [
                "message_start",
                {
                  type: "message_start",
                  message: {
                    id: "m1",
                    usage: { input_tokens: 1200, cache_read_input_tokens: 8000 },
                  },
                },
              ],
              [
                "content_block_delta",
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "ok" },
                },
              ],
              // An earlier output total is superseded by the final frame.
              ["message_delta", { type: "message_delta", delta: {}, usage: { output_tokens: 3 } }],
              [
                "message_delta",
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { output_tokens: 42 },
                },
              ],
              messageStop(),
            ]),
          ),
        ),
    });
    const { usage, texts } = await collect(provider);
    expect(texts).toEqual(["ok"]);
    expect(usage).toEqual([
      {
        inputTokens: 1200,
        outputTokens: 42,
        cacheReadInputTokens: 8000,
        cacheCreationInputTokens: 0,
        contextWindow: 200_000,
        estimated: false,
      },
    ]);
  });

  test("no usage frames → bytes/4 estimate over the exact wire body, estimated: true", async () => {
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      contextWindow: 200_000,
      fetchImpl: () =>
        Promise.resolve(
          streamResponse(
            sseLines([
              messageStart(),
              [
                "content_block_delta",
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "hello" },
                },
              ],
              [
                "message_delta",
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
              ],
              messageStop(),
            ]),
          ),
        ),
    });
    const { usage } = await collect(provider);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      estimated: true,
      contextWindow: 200_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(usage[0]?.inputTokens).toBeGreaterThan(0);
  });

  test("window unset → contextWindow null (no percentage denominator, no guess)", async () => {
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () =>
        Promise.resolve(
          streamResponse(
            sseLines([
              messageStart(),
              [
                "message_delta",
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
              ],
              messageStop(),
            ]),
          ),
        ),
    });
    const { usage } = await collect(provider);
    expect(usage[0]?.contextWindow).toBeNull();
    expect(usage[0]?.estimated).toBe(true);
  });

  test("max_tokens seal throws before any usage chunk", async () => {
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () =>
        Promise.resolve(
          streamResponse(
            sseLines([
              [
                "message_start",
                { type: "message_start", message: { id: "m1", usage: { input_tokens: 5 } } },
              ],
              [
                "message_delta",
                {
                  type: "message_delta",
                  delta: { stop_reason: "max_tokens" },
                  usage: { output_tokens: 9 },
                },
              ],
              messageStop(),
            ]),
          ),
        ),
    });
    await expect(collect(provider)).rejects.toMatchObject({
      message: expect.stringContaining("max_tokens"),
    } satisfies Record<string, unknown>);
  });
});

// ---------------------------------------------------------------------------
// #529 judge-leg completeText: the wire must carry the explicit thinking-off
// pin. The CT142 real-machine walkthrough (thr_8zbxvti5ep) showed the pinless
// judge call letting a reasoning:true glm row run its DEFAULT thinking budget
// inside the judge's 1024-token reply budget — 601 tokens burned, judged 0,
// no failure row (the reply folded to nothing parseable, not a thrown error).
// ---------------------------------------------------------------------------

describe("judge leg completeText (#529 thinking pin)", () => {
  test("wire pins thinking off; reply folds through the #523 parse contract", async () => {
    const provider = new AnthropicRelayProvider({
      ...CONFIG,
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "p00: yes" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        ),
    });
    const result = await provider.completeText(
      { system: "noul judge", user: "p00 passage", maxTokens: 1024 },
      { signal: new AbortController().signal },
    );
    expect(result.text).toBe("p00: yes");
    // End-to-end judged shape: the answer folds to a verdict, not undefined.
    const answers = splitFindAnswerLines(result.text, ["p00"]);
    expect(parseFindNoulReply(answers.get("p00") ?? "")).toBe(true);

    const recorded = provider.bodies[0];
    if (recorded === undefined) throw new Error("provider recorded no completion body");
    const wire = JSON.parse(recorded) as {
      thinking?: { type?: string };
      max_tokens?: number;
    };
    expect(wire.thinking).toEqual({ type: "disabled" });
    expect(wire.max_tokens).toBe(1024);
  });
});
