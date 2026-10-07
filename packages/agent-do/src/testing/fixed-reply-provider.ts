import type { RelayApi, ResponsesEffort } from "../provider-catalog.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamChunk,
} from "../provider.js";
import {
  anthropicRequestBody,
  completionsRequestBody,
  estimateWireRequestTokens,
  responsesRequestBody,
  type ThinkingConfig,
} from "../relay/index.js";

/**
 * The harness fixed-reply mock (#28), retired from the production surface by
 * #496 (the deployment channel no longer synthesizes a provider — turns
 * dispatch only through the fail-closed registry) and kept here as the wire
 * test fixture: it renders the EXACT wire body the real provider would send
 * and records calls for billing-parity probes. It is a product mode NOWHERE;
 * tests construct it directly.
 */
export class FixedReplyProvider implements ModelProvider {
  readonly calls: ModelRequest[] = [];

  private readonly reply: string;
  /** The relay resolution this mock stands in for (wire options + window). */
  private readonly relay: {
    model: string;
    maxTokens: number;
    thinking: ThinkingConfig;
    contextWindow: number;
    supportsImageInput?: boolean;
    api?: RelayApi;
    reasoningEffort?: ResponsesEffort;
  };

  constructor(
    reply: string,
    relay?: {
      model: string;
      maxTokens: number;
      thinking: ThinkingConfig;
      contextWindow: number;
      supportsImageInput?: boolean;
      api?: RelayApi;
      reasoningEffort?: ResponsesEffort;
    },
  ) {
    this.reply = reply;
    this.relay = relay ?? {
      model: "glm-5.3",
      maxTokens: 8192,
      thinking: { type: "disabled" },
      contextWindow: 200_000,
    };
  }

  streamTurn(
    request: ModelRequest,
    _options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamChunk> {
    // Hand-rolled iterator: the ModelProvider signature demands AsyncIterable,
    // but `async *` with no await trips require-await. Frame order: the #308
    // usage estimate (bytes/4 over the exact wire body — the mock's
    // "receipt"), then the fixed reply as the terminal answer text.
    this.calls.push(request);
    const body =
      this.relay.api === "openai-responses"
        ? JSON.stringify(
            responsesRequestBody(request, {
              model: this.relay.model,
              maxTokens: this.relay.maxTokens,
              reasoningEffort: this.relay.reasoningEffort ?? "none",
              supportsImageInput: this.relay.supportsImageInput,
            }),
          )
      : this.relay.api === "openai-completions"
        ? JSON.stringify(
            completionsRequestBody(request, {
              model: this.relay.model,
              maxTokens: this.relay.maxTokens,
              reasoningEffort: this.relay.reasoningEffort,
              supportsImageInput: this.relay.supportsImageInput,
            }),
          )
        : JSON.stringify(anthropicRequestBody(request, this.relay));
    const usage = {
      inputTokens: estimateWireRequestTokens(body),
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: this.relay.contextWindow,
      estimated: true,
    };
    const frames: ModelStreamChunk[] = [
      { kind: "usage", usage },
      { kind: "text-delta", text: this.reply },
    ];
    let frame = 0;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ModelStreamChunk> {
        return {
          next: (): Promise<IteratorResult<ModelStreamChunk>> => {
            const current = frames[frame];
            frame += 1;
            if (current === undefined) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return Promise.resolve({ done: false, value: current });
          },
        };
      },
    };
  }
}
