import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamChunk,
  type ModelToolCall,
  type ModelUsageReceipt,
  type TextCompletionRequest,
  type TextCompletionResult,
} from "../provider.js";
import type { RelayConfig } from "./anthropic-provider.js";
import { completionsRequestBody } from "./completions-wire.js";
import { parseSseStream } from "./sse.js";
import { estimateWireRequestTokens } from "./wire.js";

/**
 * Real-model OpenAI Chat Completions-protocol streaming client (#363 adaptor
 * face). The structural twin of ResponsesRelayProvider — same ModelProvider
 * seam, same failure taxonomy (§4.2): pre-first-byte transport/HTTP failures
 * carry `retryable` (bounded DO-side retry ≤2); anything after the stream
 * opened — SSE break, parse failure, incomplete tool arguments,
 * finish_reason length/content_filter (omp 续跑规则: length 必停), missing
 * `[DONE]` terminal frame (explicit-termination policy: omp's implicit EOF
 * drain is unavailable; the type-58/10-04 bifrost-bridge incident lost the
 * terminal frame on the wires that lack an explicit seal) — is
 * `afterFirstByte: true`, which the DO folds into the ruling-A seal (persist
 * prefix, never re-call, zero double billing).
 *
 * Reasoning: the selection-resolved rung rides `reasoning_effort` (official
 * chat-completions vocabulary = the Responses effort ladder verbatim; the
 * effort fold is the same `resolveResponsesEffort`). Thinking deltas map
 * from the OpenAI-compatible `delta.reasoning_content` extension (GLM/
 * DeepSeek/newapi shape; `reasoning` / `reasoning_text` variants covered
 * with a first-non-empty-field anchor so dual-field upstreams never
 * duplicate) onto the same `thinking-delta` chunk kind the DO journals as
 * `model.thinking`.
 *
 * Usage mapping: chat completions counts cached tokens IN `prompt_tokens`
 * (prompt_tokens_details.cached_tokens), so the receipt subtracts them —
 * identical to the responses face; the timeline percentage denominator must
 * not double-count cached context across faces.
 */

export type CompletionsRelayConfig = RelayConfig;

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/** The chat wire's terminal frame — the counterpart of `response.completed`. */
const DONE_SENTINEL = "[DONE]";

/** A tool_call being assembled from streamed argument fragments. */
interface OpenToolCall {
  name: string;
  id: string | undefined;
  json: string;
  /** Set when the accumulated arguments parsed cleanly. */
  parsed?: Record<string, unknown>;
}

export class CompletionsRelayProvider implements ModelProvider {
  /** Recorded for smoke/replay assertions (mock-provider parity). */
  readonly requests: ModelRequest[] = [];
  /** Serialized request bodies, one per attempt — the replay proof artifacts. */
  readonly bodies: string[] = [];

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: CompletionsRelayConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  }

  async *streamTurn(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request);
    const body = completionsRequestBody(request, {
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      reasoningEffort: this.config.reasoningEffort,
      supportsImageInput: this.config.supportsImageInput,
    });
    const serialized = JSON.stringify(body);
    this.bodies.push(serialized);

    // omp models.yml posture: the base carries the version segment
    // (`https://newapi.samuka007.top/v1` → POST /v1/chat/completions).
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: serialized,
        signal: options.signal,
      });
    } catch (error) {
      throw new ModelProviderError({
        message: `relay connect failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: !options.signal.aborted,
        afterFirstByte: false,
      });
    }

    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new ModelProviderError({
        message: `relay http ${response.status}: ${detail}`,
        retryable: RETRYABLE_STATUS.has(response.status),
        afterFirstByte: false,
      });
    }
    if (response.body === null) {
      throw new ModelProviderError({
        message: "relay returned an empty body",
        retryable: true,
        afterFirstByte: false,
      });
    }
    // The platform types the body element-generically; on the wire it is the
    // UTF-8 SSE byte stream — re-typed at this one boundary.
    const bodyStream = response.body as unknown as ReadableStream<Uint8Array>;

    let sawStreamBytes = false;
    let sawDone = false;
    /**
     * #308 receipt accumulator: the `stream_options.include_usage` final
     * chunk carries the call's cumulative usage (choices empty).
     */
    let usageFrame: CompletionsUsageFrame | null = null;
    /** Insertion order = first delta order (Map iterates insertion); keyed by index. */
    const callsByIndex = new Map<number, OpenToolCall>();
    /**
     * The first non-empty reasoning field names the thinking channel for the
     * whole stream (pi-ai anchor: some compat endpoints emit BOTH
     * `reasoning_content` and `reasoning` with identical content — anchored
     * once, never duplicated).
     */
    let reasoningField: "reasoning_content" | "reasoning" | "reasoning_text" | null = null;
    let streamError: ModelProviderError | null = null;

    try {
      // HTTP 200 with a body is the commitment point: any failure from here
      // on is post-first-byte (upstream accepted — and billed — the call).
      sawStreamBytes = true;
      for await (const message of parseSseStream(bodyStream)) {
        if (message.data === DONE_SENTINEL) {
          sawDone = true;
          break;
        }
        let chunk: CompletionsChunk;
        try {
          chunk = JSON.parse(message.data) as CompletionsChunk;
        } catch {
          throw new ModelProviderError({
            message: `relay sent malformed SSE JSON (event ${message.event})`,
            retryable: false,
            afterFirstByte: true,
          });
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          usageFrame = chunk.usage;
        }
        const choice = chunk.choices?.[0];
        if (choice === undefined) continue;
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          // The final content choice's seal: length truncation is never
          // continued (length 必停), content_filter is never answered.
          if (choice.finish_reason === "length") {
            throw new ModelProviderError({
              message:
                "relay response truncated: finish_reason length (max_completion_tokens — never continued)",
              retryable: false,
              afterFirstByte: true,
            });
          }
          if (choice.finish_reason === "content_filter") {
            throw new ModelProviderError({
              message: "relay response stopped: finish_reason content_filter",
              retryable: false,
              afterFirstByte: true,
            });
          }
          // "stop" | "tool_calls" | "function_call" (deprecated twin) — the
          // stream continues to [DONE].
        }
        const delta = choice.delta;
        if (delta === undefined) continue;
        if (typeof delta.content === "string" && delta.content !== "") {
          yield { kind: "text-delta", text: delta.content };
        }
        if (typeof delta.refusal === "string" && delta.refusal !== "") {
          // Safety-refusal text is answer text (the responses face's same
          // pi-ai anchor: refusal rides the text face).
          yield { kind: "text-delta", text: delta.refusal };
        }
        if (reasoningField === null) {
          for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
            const value = delta[field];
            if (typeof value === "string" && value !== "") {
              // #257 CoT stream: the reasoning half of the call, surfaced as
              // its own chunk kind (never answer text) — the chunk the
              // responses face emits for reasoning deltas.
              reasoningField = field;
              yield { kind: "thinking-delta", text: value };
              break;
            }
          }
        } else {
          const value = delta[reasoningField];
          if (typeof value === "string" && value !== "") {
            yield { kind: "thinking-delta", text: value };
          }
        }
        if (delta.tool_calls !== undefined) {
          for (const fragment of delta.tool_calls) {
            const index = fragment.index ?? 0;
            let call = callsByIndex.get(index);
            if (call === undefined) {
              call = { name: "", id: undefined, json: "" };
              callsByIndex.set(index, call);
            }
            if (fragment.id !== undefined) call.id = fragment.id;
            if (fragment.function?.name !== undefined) call.name = fragment.function.name;
            if (fragment.function?.arguments !== undefined) {
              call.json += fragment.function.arguments;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof ModelProviderError) {
        streamError = error;
      } else if (options.signal.aborted) {
        streamError = new ModelProviderError({
          message: "relay stream aborted",
          retryable: false,
          afterFirstByte: true,
        });
      } else {
        streamError = new ModelProviderError({
          message: `relay stream broke: ${error instanceof Error ? error.message : String(error)}`,
          retryable: false,
          afterFirstByte: sawStreamBytes,
        });
      }
    }

    if (streamError !== null) throw streamError;
    if (!sawDone) {
      // Explicit termination policy (the type-58 lesson): a stream that
      // merely ends (proxy cut, EOF) is a break, never an implicit
      // completion — the chat wire's seal is the [DONE] frame.
      throw new ModelProviderError({
        message: `relay stream ended without ${DONE_SENTINEL}`,
        retryable: false,
        afterFirstByte: true,
      });
    }
    // The chat wire has no authoritative final-arguments frame (the
    // responses face's output_item.done) — the accumulated fragments are ALL
    // the wire expresses, parsed exactly once at the [DONE] seal.
    for (const [, call] of callsByIndex) {
      if (call.name !== "") call.parsed = parseToolArguments(call);
    }

    // #308: emit the receipt before the terminal tool-calls chunk (the DO's
    // loop stops at tool-calls). A receipt without usage (degenerate upstream)
    // is discarded — a percentage built from output alone would read as
    // near-zero fill.
    const usage: ModelUsageReceipt =
      usageFrame !== null
        ? {
            // OpenAI counts cached tokens inside prompt_tokens; subtract so
            // the context-fill denominator matches the other faces' semantics.
            inputTokens: Math.max(
              0,
              (usageFrame.prompt_tokens ?? 0) -
                (usageFrame.prompt_tokens_details?.cached_tokens ?? 0),
            ),
            outputTokens: usageFrame.completion_tokens ?? 0,
            cacheReadInputTokens: usageFrame.prompt_tokens_details?.cached_tokens ?? 0,
            cacheCreationInputTokens: usageFrame.prompt_tokens_details?.cache_write_tokens ?? 0,
            contextWindow: this.config.contextWindow ?? null,
            estimated: false,
          }
        : {
            inputTokens: estimateWireRequestTokens(serialized),
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: this.config.contextWindow ?? null,
            estimated: true,
          };
    yield { kind: "usage", usage };

    const toolCalls: ModelToolCall[] = [];
    for (const [, call] of [...callsByIndex.entries()].sort((a, b) => a[0] - b[0])) {
      if (call.parsed === undefined) {
        throw new ModelProviderError({
          message: `relay tool_calls[${call.name === "" ? "(unnamed)" : call.name}]: incomplete arguments (stream truncated mid-JSON)`,
          retryable: false,
          afterFirstByte: true,
        });
      }
      toolCalls.push({ name: call.name, arguments: call.parsed });
    }
    if (toolCalls.length > 0) {
      yield { kind: "tool-calls", toolCalls };
    }
  }

  /**
   * #523 judge leg: ONE non-streaming chat completion, system + user, no
   * tools, no agent prompt. Same failure taxonomy as streamTurn (connect →
   * retryable, HTTP status classes, [DONE] not applicable — a JSON body is
   * its own seal). #529: the reasoning pin rides explicitly at "none" — a
   * reasoning row otherwise runs its DEFAULT thinking budget into the
   * judge's reply budget and the folded answer never parses (CT142: 601
   * tokens, judged 0). Same always-present posture the wire sends.
   */
  async completeText(
    request: TextCompletionRequest,
    options: { signal: AbortSignal },
  ): Promise<TextCompletionResult> {
    const body = {
      model: this.config.model,
      stream: false,
      // #529 judge posture: non-reasoning, explicitly — see the doc comment.
      reasoning_effort: "none",
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      max_completion_tokens: request.maxTokens ?? this.config.maxTokens,
    };
    const serialized = JSON.stringify(body);
    this.bodies.push(serialized);
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: serialized,
        signal: options.signal,
      });
    } catch (error) {
      throw new ModelProviderError({
        message: `relay connect failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: !options.signal.aborted,
        afterFirstByte: false,
      });
    }
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new ModelProviderError({
        message: `relay http ${response.status}: ${detail}`,
        retryable: RETRYABLE_STATUS.has(response.status),
        afterFirstByte: false,
      });
    }
    interface CompletionBody {
      choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
      usage?: CompletionsUsageFrame | null;
    }
    let payload: CompletionBody;
    try {
      const body: unknown = await response.json();
      payload = body as CompletionBody;
    } catch {
      throw new ModelProviderError({
        message: "relay sent malformed completion JSON",
        retryable: false,
        afterFirstByte: true,
      });
    }
    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? "";
    const usageFrame = payload.usage ?? null;
    const usage: ModelUsageReceipt =
      usageFrame !== null
        ? {
            inputTokens: Math.max(
              0,
              (usageFrame.prompt_tokens ?? 0) -
                (usageFrame.prompt_tokens_details?.cached_tokens ?? 0),
            ),
            outputTokens: usageFrame.completion_tokens ?? 0,
            cacheReadInputTokens: usageFrame.prompt_tokens_details?.cached_tokens ?? 0,
            cacheCreationInputTokens: usageFrame.prompt_tokens_details?.cache_write_tokens ?? 0,
            contextWindow: this.config.contextWindow ?? null,
            estimated: false,
          }
        : {
            inputTokens: estimateWireRequestTokens(serialized),
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: this.config.contextWindow ?? null,
            estimated: true,
          };
    return { text, usage };
  }
}

interface CompletionsChoiceDelta {
  content?: string | null;
  /** The OpenAI-compatible reasoning extension (GLM/DeepSeek/newapi shape). */
  reasoning_content?: string | null;
  /** OpenRouter-style variant of the same channel. */
  reasoning?: string | null;
  /** llama.cpp-style variant of the same channel. */
  reasoning_text?: string | null;
  /** Safety-refusal channel (official; rides the text face). */
  refusal?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface CompletionsChunk {
  choices?:
    | {
        index?: number;
        delta?: CompletionsChoiceDelta;
        /** "stop" | "length" | "tool_calls" | "content_filter" | "function_call" (deprecated). */
        finish_reason?: string | null;
      }[]
    | null;
  /** The include_usage final chunk — null everywhere else. */
  usage?: CompletionsUsageFrame | null;
}

function parseToolArguments(call: OpenToolCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.json === "" ? "{}" : call.json);
  } catch {
    throw new ModelProviderError({
      message: `relay tool_calls ${call.name}: incomplete arguments (stream truncated mid-JSON)`,
      retryable: false,
      afterFirstByte: true,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ModelProviderError({
      message: `relay tool_calls ${call.name}: arguments are not an object`,
      retryable: false,
      afterFirstByte: true,
    });
  }
  return parsed as Record<string, unknown>;
}

/** Chat completions usage frame (prompt_tokens INCLUDES the cached subset). */
interface CompletionsUsageFrame {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** Bounded error-body read for non-2xx classification. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "(body unreadable)";
  }
}
