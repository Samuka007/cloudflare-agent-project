import type { ToolResultErrorCode } from "@cap/protocol";

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
  /**
   * Image parts of the steer content (#317 union, A4), in journal order.
   * Empty for text-only steers — the historical shape before the image face.
   */
  images: ImageContribution[];
}

/**
 * One user-side image part projected onto the model seam (#317 union, A4).
 *
 * - `url`: an http(s) reference — the Anthropic `url` source renders it
 *   directly, no byte access.
 * - `data`: an inline base64 image already decoded from a `data:` URI
 *   (media type restricted to the Anthropic-accepted set).
 * - `path`: a disk reference (staged attachment, `file:` URI, or any value
 *   the DO cannot express as an Anthropic source) — there is no byte channel
 *   from the DO to the staging host, so it renders as the acp degradation
 *   text regardless of the image-input capability (acp
 *   bridge/bridge.ts:1131-1153 anchor: `[image attachment on disk: path]`).
 */
export type ImageContribution =
  | { kind: "url"; url: string }
  | { kind: "data"; mediaType: string; base64: string }
  | { kind: "path"; path: string };

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
  /** #454: structured refusal code when the tool never executed. */
  errorCode?: ToolResultErrorCode;
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

/**
 * One completed PRIOR turn of the same session (#228): omp §1.5 rebuilds the
 * context from the whole log, so a multi-turn session — child reminder
 * turns, follow-up user messages — must carry every earlier turn's input and
 * call history, not only the current turn's. Ordered oldest → newest; the
 * wire folds each turn's input as the user-side material before its first
 * call. Prior turns hidden by an armed rewind cut are excluded (the branch
 * summary replaces them, #147).
 */
export interface PriorTurnHistory {
  /** The prior turn's user input text. */
  input: string;
  /** The prior turn's image parts (#317 union, A4), in journal order. */
  images: ImageContribution[];
  /** Completed calls of the prior turn, in call order. */
  calls: PriorModelCall[];
}

export interface ModelRequest {
  threadId: string;
  turnId: string;
  /** This call's `model.call_started` seq — billable-attempt identity. */
  modelCallId: number;
  /** User input text of the turn. */
  input: string;
  /**
   * Image parts of the turn input (#317 union, A4), in journal order — the
   * wire renders them as Anthropic image blocks next to the input text when
   * the deployment declares image input, else as the degradation texts.
   * An image-only turn (empty text, non-empty here) is a legal turn.
   */
  inputImages: ImageContribution[];
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
   * Completed turns of the same session before this one, oldest first
   * (#228). Absent = single-turn session (every request built before the
   * multi-turn fold landed). The wire renders each prior turn's input as
   * user-side material followed by its assistant slices — one contiguous
   * append-only history.
   */
  priorTurns?: PriorTurnHistory[];
  /**
   * Wire surface (M1.5 T16): the Main thread renders MAIN_WIRE_TOOLS; a
   * subagent renders the subagent surface (hidden `yield` included). Absent
   * = Main. Purely additive — the mock provider and tests may ignore it.
   * `compaction` (#309) renders NO tools: the compact turn's single call is a
   * summarization request, not an agent step — a tool-use answer would be a
   * compaction failure, so the surface never offers one.
   */
  toolSurface?: "main" | "subagent" | "compaction";
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
   * Completed-rewind context overlay (#147): the assembly consumed the
   * checkpoint boundary — the summary replaces the hidden exploration span
   * (omp branchWithSummary: "intermediate checkpoint messages removed from
   * active context; replaced by report"). The wire renders it as the first
   * user-side block of the opening user message (omp session-context.ts
   * emits the summary first). Absent = no armed rewind cut for this turn.
   */
  branchCut?: {
    checkpointResultSeq: number | null;
    rewindResultSeq: number;
    summary: string;
  };
  /**
   * Forced tool choice (M1.5 T17 reminder ladder, attempt 3): the subagent
   * run's final reminder forces `yield` as the only permitted next call.
   * Derived from the journal fold (translate projects the reminder marker
   * bound to this turn); absent everywhere else. Providers that cannot force
   * a tool may ignore it — the mock and tests assert it directly.
   */
  toolChoice?: { name: string };
  /**
   * Deployment-time experimental tool gates (#150): the wire assembly filters
   * think/context_notes/new_context/checkpoint/rewind off the surface unless
   * their env gate is on (config.ts ExperimentalToolConfig, all default
   * false); `generateImage` folds from the 产图源 seat's presence (#448 —
   * no selected source, no row; #450 zero env fallback).
   * Absent = the ungated default surfaces (mock/test passthrough).
   */
  experimentalGates?: {
    externalThinking: boolean;
    contextNotes: boolean;
    checkpoint: boolean;
    generateImage: boolean;
  };
  /**
   * Discovered MCP server tools (matrix C2, #327): the `mcp__<server>__<tool>`
   * surface, projected by the DO's McpToolSurface from the deployment's
   * AGENT_DO_MCP_SERVERS config. Appended after the registry rows at wire
   * assembly; absent = no MCP servers configured (the surface is exactly as
   * before this field). Deployment-time input — never a runtime setting
   * (control-plane §1.2), same posture as `experimentalGates`.
   */
  mcpTools?: McpWireTool[];
  /**
   * omp sdk.ts:4275-4282 forceReasoningOff pairing: when external thinking
   * (the `think` tool) is on the wire, native provider reasoning is forced
   * OFF — external CoT and native reasoning must never coexist (ToC risk).
   */
  forceReasoningOff?: boolean;
}

/**
 * Model-facing projection of one discovered MCP tool (tools/mcp.ts). Owned
 * here because ModelRequest crosses the package boundary while the
 * projecting module sits behind the relay (import direction: relay →
 * provider; tools → relay — defining it in tools/ would cycle).
 */
export interface McpWireTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * One provider-side token accounting of a completed model call (#308).
 *
 * Receipt path (`estimated: false`): the numbers are the provider's own
 * count from the Anthropic-protocol SSE frames — `message_start.message.usage`
 * for the input side (input + cache read + cache creation, the request
 * context as the provider saw it) and the final cumulative
 * `message_delta.usage.output_tokens` for the output side.
 *
 * Estimate path (`estimated: true`): the provider had no receipt (fixed-reply
 * mock, degenerate upstream); `inputTokens` is a bytes/4 estimate over the
 * exact wire body, `outputTokens` the bytes/4 estimate of what the provider
 * streamed. The bb indicator labels estimated rows "Estimated context".
 *
 * `contextWindow` is the deployment-configured window for the model
 * (`MODEL_RELAY_CONTEXT_WINDOW`); null when the deployment doesn't know one —
 * consumers must not fabricate a percentage without it.
 */
export interface ModelUsageReceipt {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number | null;
  estimated: boolean;
}

export type ModelStreamChunk =
  | { kind: "text-delta"; text: string }
  | { kind: "thinking-delta"; text: string }
  | { kind: "usage"; usage: ModelUsageReceipt }
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
   * Stream one model call attempt. Chunks: zero or more `text-delta` /
   * `thinking-delta`, at most one `usage` receipt (#308, before any terminal
   * chunk), then at most one terminal `tool-calls` chunk carrying *complete*
   * calls only (§2.2: stream fragments are deltas, never tool.call events).
   * Iteration must stop when `signal` aborts; preferred abort shape is
   * throwing `ModelProviderError({retryable: false, afterFirstByte: true})`.
   */
  streamTurn(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamChunk>;
}
