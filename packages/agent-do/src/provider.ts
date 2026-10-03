/**
 * Model relay seam. The agent DO owns when a model call happens (every call
 * attempt is a persisted `model.call_started` event — no event, no call, no
 * billing); the provider owns how the wire is spoken. M0 ships only the
 * deterministic mock (see `testing`); the real relay client plugs in here.
 *
 * Intentionally plain TS: this interface crosses the package boundary
 * (injected by the deploying worker via `injection.ts`).
 */

export interface ModelToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface SteerContribution {
  seq: number;
  text: string;
}

export interface ToolResultContribution {
  executionId: string;
  tool: string;
  status: "ok" | "error" | "timeout" | "cancelled" | "outcome_unknown";
  output: string;
}

export interface ModelRequest {
  threadId: string;
  turnId: string;
  /** This call's `model.call_started` seq — billable-attempt identity. */
  modelCallId: number;
  /** User input text of the turn. */
  input: string;
  /** Unconsumed steers routed into this call (already persisted). */
  steers: SteerContribution[];
  /** Prior assistant text in this turn (recovered prefix included). */
  priorAssistantText: string;
  /** Terminal tool results since the previous model call. */
  toolResults: ToolResultContribution[];
}

export type ModelStreamChunk =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-calls"; toolCalls: ModelToolCall[] };

export interface ModelCallFailure {
  message: string;
  /** Pre-first-byte transport-class failures may retry (§4.2, at most 2). */
  retryable: boolean;
  /** True once any byte reached the DO: after this, seal — never re-call. */
  afterFirstByte: boolean;
}

export class ModelProviderError extends Error implements ModelCallFailure {
  readonly retryable: boolean;
  readonly afterFirstByte: boolean;

  constructor(failure: ModelCallFailure) {
    super(failure.message);
    this.name = "ModelProviderError";
    this.retryable = failure.retryable;
    this.afterFirstByte = failure.afterFirstByte;
  }
}

export interface ModelProvider {
  /**
   * Stream one model call attempt. Chunks: zero or more `text-delta`, then at
   * most one terminal `tool-calls` chunk carrying *complete* calls only
   * (§2.2: stream fragments are deltas, never tool.call events). Iteration
   * must stop when `signal` aborts; preferred abort shape is throwing
   * `ModelProviderError({retryable: false, afterFirstByte: true})`.
   */
  streamTurn(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamChunk>;
}
