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
import type { RelayApi, ResponsesEffort } from "../provider-catalog.js";
import {
  anthropicRequestBody,
  estimateWireRequestTokens,
  type RelayOutputConfig,
  type ThinkingConfig,
} from "./wire.js";
import { parseSseStream } from "./sse.js";

/**
 * Real-model Anthropic-protocol streaming client (ticket #34 loop half).
 *
 * Failure taxonomy maps onto the provider seam (§4.2): pre-first-byte
 * transport/HTTP failures carry `retryable` (bounded DO-side retry ≤2);
 * anything after the stream opened — SSE break, parse failure, incomplete
 * tool arguments, `stop_reason=max_tokens` (omp 续跑规则: length 必停),
 * missing `message_stop` (explicit-termination policy: omp's implicit EOF
 * drain is unavailable here) — is `afterFirstByte: true`, which the DO folds
 * into the ruling-A seal (persist prefix, never re-call, zero double billing).
 *
 * Reasoning budget (probe 2026-10-04, bigmodel Anthropic-compat): glm-5.3
 * reasons by default via standard `thinking` content blocks and the probe
 * confirmed `thinking:{type:"disabled"}` is honored (74→8 output tokens on a
 * trivial prompt) — so M0 defaults reasoning OFF for a deterministic budget;
 * callers may re-enable with an explicit `budget_tokens`.
 */

export interface RelayConfig {
  /**
   * Protocol base. Shape is api-face-specific (#361): the anthropic face
   * appends `/v1/messages` (base WITHOUT the version segment,
   * `https://open.bigmodel.cn/api/anthropic`); the openai-responses face
   * appends `/responses` (base WITH the version segment, omp models.yml
   * posture: `https://newapi.samuka007.top/v1`).
   */
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  /**
   * #308 context window for the usage percentage (the #500 row field /
   * wire-safety fallback). Null when the deployment doesn't know one — the
   * journaled receipt then carries null and the timeline omits the indicator
   * instead of guessing.
   */
  contextWindow?: number;
  thinking?: ThinkingConfig;
  /**
   * #534: the adaptive-effort seat for rows declaring pi's anthropic
   * adaptive transports (registry fold through relayAnthropicThinking).
   * Absent = the request carries no output_config.
   */
  outputConfig?: RelayOutputConfig;
  /**
   * A4: the deployment's verdict on whether the relay model accepts image
   * input — rides every call as the wire's consumption dispatch gate.
   * Absent = not declared → image parts degrade to text (safe default).
   */
  supportsImageInput?: boolean;
  /**
   * #361: the protocol face this config speaks. Consumed by the DISPATCH
   * layer (harness relayProviderFrom / RelayProviderRegistry.providerFor —
   * which provider class to construct); AnthropicRelayProvider itself
   * ignores it. Absent = the incumbent anthropic face.
   */
  api?: RelayApi;
  /**
   * #361: the selection-resolved reasoning rung for the openai-responses
   * face (registry fold through resolveResponsesEffort — already mapped to
   * an official effort before construction). Consumed only by
   * ResponsesRelayProvider; absent = effort "none".
   */
  reasoningEffort?: ResponsesEffort;
  /** Test seam; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/** A tool_use block being assembled from `input_json_delta` fragments. */
interface OpenToolBlock {
  name: string;
  json: string;
  /** Set at content_block_stop when the JSON parsed cleanly. */
  parsed?: Record<string, unknown>;
}

export class AnthropicRelayProvider implements ModelProvider {
  /** Recorded for smoke/replay assertions (mock-provider parity). */
  readonly requests: ModelRequest[] = [];
  /** Serialized request bodies, one per attempt — the replay proof artifacts. */
  readonly bodies: string[] = [];

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: RelayConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  }

  async *streamTurn(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request);
    const body = anthropicRequestBody(request, {
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      thinking: this.config.thinking,
      outputConfig: this.config.outputConfig,
      supportsImageInput: this.config.supportsImageInput,
    });
    const serialized = JSON.stringify(body);
    this.bodies.push(serialized);

    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: serialized,
        signal: options.signal,
      });
    } catch (error) {
      throw new ModelProviderError({
        message: `relay connect failed: ${describeError(error)}`,
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
    let sawMessageStop = false;
    let stopReason: string | null = null;
    /**
     * #308 receipt accumulator: `message_start` seeds the input side, the
     * final `message_delta` carries the cumulative output total.
     */
    let inputSide: {
      inputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    } | null = null;
    let outputTokens = 0;
    /** Insertion order = content_block_start order (Map iterates insertion). */
    const blocksByIndex = new Map<number, OpenToolBlock>();
    let streamError: ModelProviderError | null = null;

    try {
      // HTTP 200 with a body is the commitment point: any failure from here
      // on is post-first-byte (upstream accepted — and billed — the call).
      sawStreamBytes = true;
      for await (const message of parseSseStream(bodyStream)) {
        let payload: SseEventPayload;
        try {
          payload = JSON.parse(message.data) as SseEventPayload;
        } catch {
          throw new ModelProviderError({
            message: `relay sent malformed SSE JSON (event ${message.event})`,
            retryable: false,
            afterFirstByte: true,
          });
        }
        switch (payload.type) {
          case "message_start": {
            const usage = payload.message?.usage;
            // A frame with no recognized field at all (test fixtures, broken
            // upstreams) is not a receipt — fall through to the estimate.
            if (
              usage !== undefined &&
              (usage.input_tokens !== undefined ||
                usage.cache_read_input_tokens !== undefined ||
                usage.cache_creation_input_tokens !== undefined)
            ) {
              inputSide = {
                inputTokens: usage.input_tokens ?? 0,
                cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
                cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
              };
            }
            break;
          }
          case "error": {
            throw new ModelProviderError({
              message:
                `relay stream error: ${payload.error?.type ?? "unknown"} ${payload.error?.message ?? ""}`.trim(),
              retryable: false,
              afterFirstByte: true,
            });
          }
          case "message_delta": {
            stopReason = payload.delta?.stop_reason ?? null;
            // Anthropic message_delta usage.output_tokens is cumulative; the
            // last frame before message_stop is the call's final total.
            if (payload.usage?.output_tokens !== undefined) {
              outputTokens = payload.usage.output_tokens;
            }
            if (stopReason === "max_tokens") {
              throw new ModelProviderError({
                message: "relay stop_reason=max_tokens (length truncation — never continued)",
                retryable: false,
                afterFirstByte: true,
              });
            }
            break;
          }
          case "message_stop": {
            sawMessageStop = true;
            break;
          }
          case "content_block_start": {
            const block = payload.content_block;
            if (block?.type === "tool_use" && block.name !== undefined) {
              blocksByIndex.set(payload.index ?? -1, { name: block.name, json: "" });
            }
            break;
          }
          case "content_block_delta": {
            const delta = payload.delta;
            if (delta?.type === "text_delta" && delta.text !== undefined) {
              yield { kind: "text-delta", text: delta.text };
            } else if (delta?.type === "input_json_delta" && delta.partial_json !== undefined) {
              const block = blocksByIndex.get(payload.index ?? -1);
              if (block !== undefined) block.json += delta.partial_json;
            } else if (delta?.type === "thinking_delta" && delta.thinking !== undefined) {
              // #257 CoT stream: the reasoning half of the call, surfaced as
              // its own chunk kind (never answer text) — the DO journals it
              // as `model.thinking` rows and the ux projection renders the
              // `item/reasoning/textDelta` stream the SPA folds into
              // activeThinking. With the harness thinking budget unset these
              // blocks never arrive (M0 disables), so this only fires for
              // re-enabled deployments.
              yield { kind: "thinking-delta", text: delta.thinking };
            }
            // `signature_delta` stays swallowed: opaque verification
            // material with no UX face, and replaying thinking blocks is
            // deliberately out of scope (#257 note in wire.ts — the M0 wire
            // rebuilds assistant slices from text+tool_use only).
            break;
          }
          case "content_block_stop": {
            const block = blocksByIndex.get(payload.index ?? -1);
            if (block !== undefined) {
              block.parsed = parseToolArguments(block);
            }
            break;
          }
          default:
            // message_start / ping / unknown — ignore (forward compatible).
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
          message: `relay stream broke: ${describeError(error)}`,
          retryable: false,
          afterFirstByte: sawStreamBytes,
        });
      }
    }

    if (streamError !== null) throw streamError;
    if (!sawMessageStop) {
      // Explicit termination policy: a stream that merely ends (proxy cut,
      // EOF) is a break, never an implicit completion.
      throw new ModelProviderError({
        message: "relay stream ended without message_stop",
        retryable: false,
        afterFirstByte: true,
      });
    }
    if (stopReason === "max_tokens") {
      throw new ModelProviderError({
        message: "relay stop_reason=max_tokens (length truncation — never continued)",
        retryable: false,
        afterFirstByte: true,
      });
    }

    // #308: emit the receipt before the terminal tool-calls chunk (the DO's
    // loop stops at tool-calls). A receipt without an input side (degenerate
    // upstream that never sent message_start usage) is discarded — a
    // percentage built from output alone would read as near-zero fill.
    const usage: ModelUsageReceipt =
      inputSide !== null
        ? {
            inputTokens: inputSide.inputTokens,
            outputTokens,
            cacheReadInputTokens: inputSide.cacheReadInputTokens,
            cacheCreationInputTokens: inputSide.cacheCreationInputTokens,
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
    for (const [, block] of [...blocksByIndex.entries()].sort((a, b) => a[0] - b[0])) {
      if (block.parsed === undefined) {
        throw new ModelProviderError({
          message: `relay tool_use ${block.name}: block never completed (missing content_block_stop)`,
          retryable: false,
          afterFirstByte: true,
        });
      }
      toolCalls.push({ name: block.name, arguments: block.parsed });
    }
    if (toolCalls.length > 0) {
      yield { kind: "tool-calls", toolCalls };
    }
  }

  /**
   * #523 judge leg: ONE non-streaming Messages call — system top-level, one
   * user message, no tools. Same failure taxonomy as streamTurn; `max_tokens`
   * stop reason fails (length 必停). #529: the thinking pin rides explicitly
   * — a `reasoning:true` row (glm) otherwise runs its DEFAULT thinking budget
   * into the judge's reply budget and the folded answer never parses (the
   * CT142 walkthrough: 601 tokens burned, judged 0, no failure row). Same
   * disabled-by-default posture the wire sends (anthropicRequestBody).
   */
  async completeText(
    request: TextCompletionRequest,
    options: { signal: AbortSignal },
  ): Promise<TextCompletionResult> {
    const body = {
      model: this.config.model,
      max_tokens: request.maxTokens ?? this.config.maxTokens,
      // #529 judge posture: non-reasoning, explicitly — see the doc comment.
      thinking: { type: "disabled" },
      system: request.system,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.user }],
        },
      ],
    };
    const serialized = JSON.stringify(body);
    this.bodies.push(serialized);
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: serialized,
        signal: options.signal,
      });
    } catch (error) {
      throw new ModelProviderError({
        message: `relay connect failed: ${describeError(error)}`,
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
      stop_reason?: string | null;
      content?: { type?: string; text?: string }[];
      usage?: MessageUsageFrame | null;
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
    if (payload.stop_reason === "max_tokens") {
      throw new ModelProviderError({
        message: "relay stop_reason=max_tokens (length truncation — never continued)",
        retryable: false,
        afterFirstByte: true,
      });
    }
    const text = (payload.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    const usageFrame = payload.usage ?? null;
    const usage: ModelUsageReceipt =
      usageFrame !== null
        ? {
            inputTokens: usageFrame.input_tokens ?? 0,
            outputTokens: usageFrame.output_tokens ?? 0,
            cacheReadInputTokens: usageFrame.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: usageFrame.cache_creation_input_tokens ?? 0,
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

interface SseEventPayload {
  type: string;
  index?: number;
  /** `message_start`: the response header carries the input-side usage. */
  message?: { usage?: MessageUsageFrame };
  /** `message_delta`: cumulative output usage, final total before stop. */
  usage?: MessageUsageFrame;
  error?: { type?: string; message?: string };
  delta?: {
    stop_reason?: string | null;
    type?: string;
    text?: string;
    partial_json?: string;
    /** thinking content blocks: `thinking_delta` carries the reasoning text. */
    thinking?: string;
  };
  content_block?: { type: string; id?: string; name?: string };
}

/** Anthropic usage frame (input_tokens excludes the two cache fields). */
interface MessageUsageFrame {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function parseToolArguments(block: OpenToolBlock): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.json === "" ? "{}" : block.json);
  } catch {
    throw new ModelProviderError({
      message: `relay tool_use ${block.name}: incomplete arguments (stream truncated mid-JSON)`,
      retryable: false,
      afterFirstByte: true,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ModelProviderError({
      message: `relay tool_use ${block.name}: arguments are not an object`,
      retryable: false,
      afterFirstByte: true,
    });
  }
  return parsed as Record<string, unknown>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
