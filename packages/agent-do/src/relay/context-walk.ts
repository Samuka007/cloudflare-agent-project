import type {
  AsyncResultContribution,
  ImageContribution,
  ModelRequest,
  PriorModelCall,
  SteerContribution,
} from "../provider.js";

/**
 * Protocol-neutral context walk (#361 adaptor seam, #28 ruling ③ translation
 * layer). The single append-only walk over a ModelRequest's log projection —
 * omp §1.5 semantics: the log folds into wire-shaped segments in seq order,
 * nothing is reordered or re-serialized per call. Both protocol faces
 * (anthropicRequestBody, responsesRequestBody) render from these segments,
 * so the two wires cannot disagree on history assembly; only the renderer
 * differs.
 *
 * Roles strictly alternate at the segment level: consecutive user-side
 * material (input, steers, async results, tool results) merges into one user
 * segment, flushed exactly where the assistant boundary sits.
 */

/** Anthropic rejects empty tool_result content — omp fills a sentinel. */
export const EMPTY_OUTPUT_SENTINEL = "(empty output)";

/** Assembly invariant violation — a broken log projection, never a retry. */
export class WireAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireAssemblyError";
  }
}

/** Deterministic tool-call id derived from the log — never the wire's id. */
export function toolUseIdFor(executionId: string): string {
  return `toolu_${executionId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** acp degradation anchor (bridge/bridge.ts:1131-1153) for on-disk images. */
export function degradedImageText(image: ImageContribution): string {
  switch (image.kind) {
    case "path":
      return `[image attachment on disk: ${image.path}]`;
    case "url":
      return `[image attachment: ${image.url}]`;
    case "data":
      return `[image attachment: inline ${image.mediaType}]`;
  }
}

/**
 * A4 consumption dispatch resolved per image part (both faces share the
 * rule): a capable relay receives real image references for url/data kinds;
 * path-kind contributions and every image of a non-capable relay render as
 * the acp degradation text.
 */
export type WalkedImage =
  | { kind: "url"; url: string }
  | { kind: "base64"; mediaType: string; data: string }
  | { kind: "degraded"; text: string };

export type WalkUserPart =
  | { kind: "text"; text: string }
  | { kind: "image"; image: WalkedImage }
  | { kind: "tool-result"; callId: string; output: string; isError: boolean };

export interface WalkAssistantToolCall {
  /** Deterministic id derived from the log (toolUseIdFor) — never the wire's. */
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContextSegment =
  | { kind: "user"; parts: WalkUserPart[] }
  | { kind: "assistant"; text: string; toolCalls: WalkAssistantToolCall[] };

export interface WalkOptions {
  /** A4 verdict (WireCallOptions.supportsImageInput): absent/false degrades. */
  supportsImageInput?: boolean;
}

/**
 * Fold the request's append-only context into ordered segments. Pure and
 * deterministic: the same ModelRequest always produces identical segments —
 * ids derive from the log (executionId), never from the wire.
 */
export function walkModelRequestContext(
  request: ModelRequest,
  options: WalkOptions,
): ContextSegment[] {
  const segments: ContextSegment[] = [];
  /** User-side parts accumulated since the last assistant segment. */
  let pendingUserParts: WalkUserPart[] = [];

  const flushUser = (): void => {
    if (pendingUserParts.length === 0) return;
    segments.push({ kind: "user", parts: pendingUserParts });
    pendingUserParts = [];
  };

  const pushText = (text: string): void => {
    if (text !== "") pendingUserParts.push({ kind: "text", text });
  };

  const pushImages = (images: readonly ImageContribution[]): void => {
    for (const image of images) {
      if (options.supportsImageInput !== true || image.kind === "path") {
        pendingUserParts.push({
          kind: "image",
          image: { kind: "degraded", text: degradedImageText(image) },
        });
        continue;
      }
      pendingUserParts.push(
        image.kind === "url"
          ? { kind: "image", image: { kind: "url", url: image.url } }
          : {
              kind: "image",
              image: { kind: "base64", mediaType: image.mediaType, data: image.base64 },
            },
      );
    }
  };

  const appendSteers = (steers: readonly SteerContribution[]): void => {
    for (const steer of steers) {
      // An image-only steer carries no text — an empty text block would be
      // rejected upstream, so the images render alone.
      pushText(steer.text);
      pushImages(steer.images);
    }
  };

  /**
   * M1.5 T16 async-result follow-ups ride the same boundary position as
   * steers — the user-side material of the call they attribute to (omp
   * injects them as follow-up messages into the run; the boundary merge is
   * our alternation-safe shape). Each result renders as one tagged text
   * part, prefixed `[async-result]` for model-side recognition.
   */
  const appendAsyncResults = (results: readonly AsyncResultContribution[]): void => {
    for (const result of results) {
      pendingUserParts.push({ kind: "text", text: `[async-result] ${result.text}` });
    }
  };

  const assistantOf = (call: PriorModelCall): ContextSegment => {
    const toolCalls: WalkAssistantToolCall[] = [];
    call.toolCalls.forEach((call_, index) => {
      const executionId = call.toolResults[index]?.executionId;
      if (executionId === undefined) {
        throw new WireAssemblyError(
          `call ${call.modelCallId}: toolCall #${index} has no paired result executionId`,
        );
      }
      toolCalls.push({
        callId: toolUseIdFor(executionId),
        name: call_.name,
        arguments: call_.arguments,
      });
    });
    if (call.text === "" && toolCalls.length === 0) {
      throw new WireAssemblyError(`call ${call.modelCallId}: assistant message has no content`);
    }
    return { kind: "assistant", text: call.text, toolCalls };
  };

  // #147 completed-rewind branch cut: the summary replaces the hidden
  // exploration span — omp session-context.ts:339-343 emits the summary
  // first ("entry = compaction"), then the kept tail. It opens the request
  // as user-side material of the first user message ([async-result] tag
  // family: model-side recognition without a second message role).
  if (request.branchCut !== undefined) {
    pushText(`[branch-summary] ${request.branchCut.summary}`);
  }
  // Completed prior turns of the session (#228), oldest first: each turn's
  // input is the user-side material before its first call slice; trailing
  // tool results merge with whatever follows (roles strictly alternate).
  for (const turn of request.priorTurns ?? []) {
    pushText(turn.input);
    pushImages(turn.images);
    for (const call of turn.calls) {
      appendAsyncResults(call.asyncResults);
      // This call's boundary steers merge into the user message that the API
      // positionally places right before its assistant response.
      appendSteers(call.steers);
      flushUser();
      segments.push(assistantOf(call));
      // Terminal results answer this assistant's tool calls; they join the
      // pending user-side material of the next user segment.
      for (const result of call.toolResults) {
        pendingUserParts.push({
          kind: "tool-result",
          callId: toolUseIdFor(result.executionId),
          output: result.output === "" ? EMPTY_OUTPUT_SENTINEL : result.output,
          isError: result.status !== "ok",
        });
      }
    }
  }
  // The current turn's input follows the session history (merging into the
  // trailing user-side material when the last prior call ended with results).
  pushText(request.input);
  pushImages(request.inputImages);

  for (const call of request.priorCalls) {
    appendAsyncResults(call.asyncResults);
    // This call's boundary steers merge into the user message that the API
    // positionally places right before its assistant response.
    appendSteers(call.steers);
    flushUser();
    segments.push(assistantOf(call));
    for (const result of call.toolResults) {
      pendingUserParts.push({
        kind: "tool-result",
        callId: toolUseIdFor(result.executionId),
        output: result.output === "" ? EMPTY_OUTPUT_SENTINEL : result.output,
        isError: result.status !== "ok",
      });
    }
  }
  // The current call's boundary steers ride the trailing user message — the
  // positionally-last user turn the model reads before this response (a
  // steer placed earlier would retroactively re-context prior turns).
  appendSteers(request.steers);
  appendAsyncResults(request.asyncResults);
  flushUser();

  return segments;
}
