import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamChunk,
  type ModelToolCall,
  type ModelUsageReceipt,
} from "../provider.js";
import type { RelayConfig } from "./anthropic-provider.js";
import { responsesRequestBody } from "./responses-wire.js";
import { parseSseStream } from "./sse.js";
import { estimateWireRequestTokens } from "./wire.js";

/**
 * Real-model OpenAI Responses-protocol streaming client (#361 adaptor face).
 * The structural twin of AnthropicRelayProvider — same ModelProvider seam,
 * same failure taxonomy (§4.2): pre-first-byte transport/HTTP failures carry
 * `retryable` (bounded DO-side retry ≤2); anything after the stream opened —
 * SSE break, parse failure, incomplete tool arguments, `incomplete/
 * max_output_tokens` (omp 续跑规则: length 必停), missing `response.completed`
 * (explicit-termination policy: omp's implicit EOF drain is unavailable here,
 * and the 10-04 type-58 bifrost-bridge incident lost exactly this terminal
 * frame on the anthropic face) — is `afterFirstByte: true`, which the DO
 * folds into the ruling-A seal (persist prefix, never re-call, zero double
 * billing).
 *
 * Reasoning: the selection-resolved rung rides `reasoning.effort`
 * (ResponsesRelayConfig.reasoningEffort); effort "none" is the explicit off.
 * Thinking-block deltas (`reasoning_summary_text` / `reasoning_text`) map to
 * the same `thinking-delta` chunk kind the DO journals as `model.thinking`.
 *
 * Usage mapping: OpenAI includes cached tokens IN `input_tokens`, so the
 * receipt subtracts them (pi-ai openai-responses-shared anchor) — the
 * anthropic face's `input_tokens` excludes its cache fields, and the timeline
 * percentage denominator must not double-count cached context across faces.
 */

export type ResponsesRelayConfig = RelayConfig;

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/** A function_call item being assembled from arguments deltas. */
interface OpenFunctionCall {
  name: string;
  callId: string | undefined;
  json: string;
  /** Authoritative arguments from arguments.done / output_item.done. */
  finalJson?: string;
  /** Set at output_item.done when the arguments parsed cleanly. */
  parsed?: Record<string, unknown>;
}

export class ResponsesRelayProvider implements ModelProvider {
  /** Recorded for smoke/replay assertions (mock-provider parity). */
  readonly requests: ModelRequest[] = [];
  /** Serialized request bodies, one per attempt — the replay proof artifacts. */
  readonly bodies: string[] = [];

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ResponsesRelayConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  }

  async *streamTurn(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request);
    const body = responsesRequestBody(request, {
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      reasoningEffort: this.config.reasoningEffort ?? "none",
      supportsImageInput: this.config.supportsImageInput,
    });
    const serialized = JSON.stringify(body);
    this.bodies.push(serialized);

    // omp models.yml posture: the base carries the version segment
    // (`https://newapi.samuka007.top/v1` → POST /v1/responses).
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/responses`;
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
    let sawCompleted = false;
    /**
     * #308 receipt accumulator: `response.completed` carries the call's
     * cumulative usage (input + output + details).
     */
    let completedUsage: ResponsesUsageFrame | null = null;
    /** Insertion order = output_item.added order (Map iterates insertion). */
    const callsByIndex = new Map<number, OpenFunctionCall>();
    let streamError: ModelProviderError | null = null;

    try {
      // HTTP 200 with a body is the commitment point: any failure from here
      // on is post-first-byte (upstream accepted — and billed — the call).
      sawStreamBytes = true;
      for await (const message of parseSseStream(bodyStream)) {
        let payload: ResponsesSsePayload;
        try {
          payload = JSON.parse(message.data) as ResponsesSsePayload;
        } catch {
          throw new ModelProviderError({
            message: `relay sent malformed SSE JSON (event ${message.event})`,
            retryable: false,
            afterFirstByte: true,
          });
        }
        switch (payload.type) {
          case "response.output_item.added": {
            const item = payload.item;
            if (item?.type === "function_call" && item.name !== undefined) {
              callsByIndex.set(payload.output_index ?? -1, {
                name: item.name,
                callId: item.call_id,
                json: "",
              });
            }
            break;
          }
          case "response.output_text.delta": {
            if (payload.delta !== undefined) yield { kind: "text-delta", text: payload.delta };
            break;
          }
          case "response.refusal.delta": {
            // Safety-refusal text is answer text (pi-ai anchor: refusal rides
            // the text face) — the DO renders it as the assistant reply.
            if (payload.delta !== undefined) yield { kind: "text-delta", text: payload.delta };
            break;
          }
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": {
            // #257 CoT stream: the reasoning half of the call, surfaced as
            // its own chunk kind (never answer text) — same chunk the
            // anthropic face emits for thinking_delta.
            if (payload.delta !== undefined) yield { kind: "thinking-delta", text: payload.delta };
            break;
          }
          case "response.reasoning_summary_part.done": {
            // pi-ai anchor: summary parts would otherwise concatenate
            // mid-sentence — one blank line between parts.
            yield { kind: "thinking-delta", text: "\n\n" };
            break;
          }
          case "response.function_call_arguments.delta": {
            const call = callsByIndex.get(payload.output_index ?? -1);
            if (call !== undefined && payload.delta !== undefined) call.json += payload.delta;
            break;
          }
          case "response.function_call_arguments.done": {
            const call = callsByIndex.get(payload.output_index ?? -1);
            if (call !== undefined && payload.arguments !== undefined) {
              call.finalJson = payload.arguments;
            }
            break;
          }
          case "response.output_item.done": {
            const item = payload.item;
            if (item?.type === "function_call") {
              const call = callsByIndex.get(payload.output_index ?? -1);
              if (call !== undefined) {
                if (item.call_id !== undefined) call.callId = item.call_id;
                if (item.arguments !== undefined) call.finalJson = item.arguments;
                call.parsed = parseToolArguments(call);
              }
            }
            break;
          }
          case "response.incomplete": {
            // Truncated completion — the max_tokens seal rule (length 必停):
            // a length-truncated call is never continued, and no incomplete
            // response is ever an implicit success.
            const reason = payload.response?.incomplete_details?.reason ?? "unknown";
            throw new ModelProviderError({
              message:
                reason === "max_output_tokens"
                  ? "relay response incomplete: max_output_tokens (length truncation — never continued)"
                  : `relay response incomplete: ${reason}`,
              retryable: false,
              afterFirstByte: true,
            });
          }
          case "response.failed": {
            const error = payload.response?.error;
            throw new ModelProviderError({
              message: `relay response failed: ${error?.code ?? "unknown"} ${error?.message ?? ""}`.trim(),
              retryable: false,
              afterFirstByte: true,
            });
          }
          case "error": {
            throw new ModelProviderError({
              message:
                `relay stream error: ${payload.code ?? "unknown"} ${payload.message ?? ""}`.trim(),
              retryable: false,
              afterFirstByte: true,
            });
          }
          case "response.completed": {
            sawCompleted = true;
            completedUsage = payload.response?.usage ?? null;
            // Defensive: the terminal frame carries the authoritative status.
            const status = payload.response?.status;
            if (status === "failed") {
              const error = payload.response?.error;
              throw new ModelProviderError({
                message: `relay response failed: ${error?.code ?? "unknown"} ${error?.message ?? ""}`.trim(),
                retryable: false,
                afterFirstByte: true,
              });
            }
            if (status === "incomplete") {
              const reason = payload.response?.incomplete_details?.reason ?? "unknown";
              throw new ModelProviderError({
                message: `relay response incomplete: ${reason}`,
                retryable: false,
                afterFirstByte: true,
              });
            }
            break;
          }
          default:
            // response.created / in_progress / content_part.* / ping / unknown
            // — ignore (forward compatible).
            break;
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
    if (!sawCompleted) {
      // Explicit termination policy (the type-58 lesson): a stream that
      // merely ends (proxy cut, EOF) is a break, never an implicit completion.
      throw new ModelProviderError({
        message: "relay stream ended without response.completed",
        retryable: false,
        afterFirstByte: true,
      });
    }

    // #308: emit the receipt before the terminal tool-calls chunk (the DO's
    // loop stops at tool-calls). A receipt without usage (degenerate upstream)
    // is discarded — a percentage built from output alone would read as
    // near-zero fill.
    const usage: ModelUsageReceipt =
      completedUsage !== null
        ? {
            // OpenAI counts cached tokens inside input_tokens; subtract so the
            // context-fill denominator matches the anthropic face's semantics.
            inputTokens: Math.max(
              0,
              (completedUsage.input_tokens ?? 0) -
                (completedUsage.input_tokens_details?.cached_tokens ?? 0),
            ),
            outputTokens: completedUsage.output_tokens ?? 0,
            cacheReadInputTokens: completedUsage.input_tokens_details?.cached_tokens ?? 0,
            cacheCreationInputTokens: completedUsage.input_tokens_details?.cache_write_tokens ?? 0,
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
          message: `relay function_call ${call.name}: item never completed (missing output_item.done)`,
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
}

interface ResponsesSsePayload {
  type: string;
  output_index?: number;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  /** Delta events: the incremental text/arguments fragment. */
  delta?: string;
  /** `response.function_call_arguments.done`: the complete arguments string. */
  arguments?: string;
  /** Top-level `error` event. */
  code?: string;
  message?: string;
  response?: {
    status?: string;
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
    usage?: ResponsesUsageFrame | null;
  };
}

/** Responses usage frame (input_tokens INCLUDES the cached subset). */
interface ResponsesUsageFrame {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

function parseToolArguments(call: OpenFunctionCall): Record<string, unknown> {
  // The done frame's arguments are authoritative over delta accumulation.
  const source = call.finalJson ?? call.json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source === "" ? "{}" : source);
  } catch {
    throw new ModelProviderError({
      message: `relay function_call ${call.name}: incomplete arguments (stream truncated mid-JSON)`,
      retryable: false,
      afterFirstByte: true,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ModelProviderError({
      message: `relay function_call ${call.name}: arguments are not an object`,
      retryable: false,
      afterFirstByte: true,
    });
  }
  return parsed as Record<string, unknown>;
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
