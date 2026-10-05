import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamChunk,
  type ModelToolCall,
} from "../provider.js";
import { anthropicRequestBody, type ThinkingConfig } from "./wire.js";
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
  /** Anthropic-protocol base, e.g. `https://open.bigmodel.cn/api/anthropic`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  thinking?: ThinkingConfig;
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
}

interface SseEventPayload {
  type: string;
  index?: number;
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
