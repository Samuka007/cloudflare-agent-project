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

/** One completed model call of the turn — its slice of the replayed history. */
export interface PriorModelCall {
  /** The call's `model.call_started` seq. */
  modelCallId: number;
  /** Steers consumed at this call's boundary (§2.3), in steer seq order. */
  steers: SteerContribution[];
  /** Terminal assistant text (`model.call_completed.text`). */
  text: string;
  /** Complete tool calls of this call, in call order. */
  toolCalls: ModelToolCall[];
  /**
   * Terminal results of this call's executions, in `tool.call` seq order.
   * Pairing invariant (§2.2, #28 ruling ③): `toolResults.length` must equal
   * `toolCalls.length` once the call is prior history — no tool_use without
   * its tool_result ever reaches the wire.
   */
  toolResults: ToolResultContribution[];
  /** Async results that rode this call's boundary (permanent history). */
  asyncResults: AsyncResultContribution[];
}

export interface ToolResultContribution {
  executionId: string;
  tool: string;
  status: "ok" | "error" | "timeout" | "cancelled" | "outcome_unknown";
  output: string;
}

/**
 * One background-task completion injected at a call boundary (M1.5 T16
 * async-result follow-up, omp ASYNC_RESULT_MESSAGE_TYPE "async-result").
 * `text` is the delivery-formatted rendering ("Background task <id>
 * complete/failed." + summary-capped output).
 */
export interface AsyncResultContribution {
  /** The `task.async_result` journal seq — boundary attribution key. */
  seq: number;
  spawnId: string;
  agentId: string;
  status: "ok" | "error";
  text: string;
}

export interface ModelRequest {
  threadId: string;
  turnId: string;
  /** This call's `model.call_started` seq — billable-attempt identity. */
  modelCallId: number;
  /** User input text of the turn. */
  input: string;
  /**
   * Steers this call's boundary consumes (the `consumedSteerSeqs` of this
   * call's `model.call_started`, already persisted) — they enter the context
   * now and stay in every later call's history via the prior-call slices.
   */
  steers: SteerContribution[];
  /**
   * Completed calls of this turn before this one, in call order — the
   * append-only history (omp §1.5). A full rebuild from the log per call is
   * the structural replay-consistency guarantee: the same log always
   * projects the same request.
   */
  priorCalls: PriorModelCall[];
  /**
   * Wire surface (M1.5 T16): the Main thread renders MAIN_WIRE_TOOLS; a
   * subagent renders the subagent surface (hidden `yield` included). Absent
   * = Main. Purely additive — the mock provider and tests may ignore it.
   */
  toolSurface?: "main" | "subagent";
  /**
   * Subagent-only: the spawning DO's depth verdict (canSpawnAtDepth) — the
   * wire strips `task` past the recursion cap. Ignored off the subagent
   * surface.
   */
  spawnPolicyBlocked?: boolean;
  /**
   * Async results riding THIS call's boundary — the pending follow-ups that
   * landed after the previous call started. They enter the context here and
   * stay in every later call's history via the prior-call slices.
   */
  asyncResults: AsyncResultContribution[];
  /**
   * Forced tool choice (M1.5 T17 reminder ladder, attempt 3): the subagent
   * run's final reminder forces `yield` as the only permitted next call.
   * Derived from the journal fold (translate projects the reminder marker
   * bound to this turn); absent everywhere else. Providers that cannot force
   * a tool may ignore it — the mock and tests assert it directly.
   */
  toolChoice?: { name: string };
}

export type ModelStreamChunk =
  { kind: "text-delta"; text: string } | { kind: "tool-calls"; toolCalls: ModelToolCall[] };

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
