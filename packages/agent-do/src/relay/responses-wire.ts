import type { ModelRequest } from "../provider.js";
import type { ResponsesEffort } from "../provider-catalog.js";
import { M0_RENDER_FLAGS, wireToolSet } from "../tools/registry.js";
import { walkModelRequestContext, WireAssemblyError, type ContextSegment } from "./context-walk.js";
import { resolveWireToolNames, SYSTEM_PROMPT_BLOCKS } from "./wire.js";

/**
 * OpenAI Responses wire assembly (#361 adaptor face, #28 ruling ③
 * translation layer). Renders the SAME protocol-neutral context walk as the
 * anthropic face (context-walk.ts) into the Responses `input` item list, per
 * the official current schema (POST /v1/responses — the protocol canon, not
 * memory; pi-ai openai-responses provider factory is the working G1/G3
 * reference shape).
 *
 * Shape map (Anthropic → Responses):
 * - `system` blocks           → `instructions` (static prefix string)
 * - user text/image blocks    → `message` item, `input_text`/`input_image` parts
 * - assistant text            → `message` item (assistant), `output_text` part
 * - assistant tool_use        → `function_call` item (call_id = toolUseIdFor)
 * - tool_result               → `function_call_output` item (call_id pairing)
 * - `thinking` budget config  → `reasoning.effort` (rung-resolved; "none" =
 *   explicit off, the pi-ai thinkingLevelMap.off ?? "none" anchor)
 * - `max_tokens`              → `max_output_tokens`
 * - forced `tool_choice{name}` → `tool_choice {type:"function", name}`
 *
 * Deterministic like the anthropic face: the same ModelRequest serializes to
 * byte-identical JSON. Statelessness is explicit (`store: false`) — history
 * rebuilds from the log every call; no `previous_response_id`, and reasoning
 * items are deliberately NOT replayed (the anthropic face's text+tool_use
 * rebuild parity, #257 note: thinking blocks stay stream-only).
 */

export interface ResponsesInputTextPart {
  type: "input_text";
  text: string;
}

export interface ResponsesInputImagePart {
  type: "input_image";
  detail: "auto";
  image_url: string;
}

export type ResponsesInputContentPart = ResponsesInputTextPart | ResponsesInputImagePart;

export interface ResponsesInputMessageItem {
  type: "message";
  role: "user" | "assistant";
  content: ResponsesInputContentPart[] | { type: "output_text"; text: string; annotations: [] }[];
  status?: "completed";
}

export interface ResponsesFunctionCallItem {
  type: "function_call";
  /** Deterministic pairing id (toolUseIdFor) — answered by function_call_output. */
  call_id: string;
  name: string;
  /** JSON.stringify'd arguments — the wire carries the string form. */
  arguments: string;
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponsesInputItem =
  | ResponsesInputMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Registry schemas are JSON-schema but not strict-mode audited — pin off. */
  strict: false;
}

export interface ResponsesRequestBody {
  model: string;
  stream: true;
  /** Stateless posture: history rebuilds from the log; no server retention. */
  store: false;
  instructions: string;
  max_output_tokens: number;
  /** Effort-pinned reasoning: "none" when the think tool renders (ToC rule). */
  reasoning: { effort: ResponsesEffort };
  /** Omitted on the #309 `compaction` surface — a summary call offers no tools. */
  tools?: ResponsesFunctionTool[];
  /** Present only on the T17 forced-yield attempt (reminder ladder, 3/3). */
  tool_choice?: { type: "function"; name: string };
  input: ResponsesInputItem[];
}

export interface ResponsesWireCallOptions {
  model: string;
  /** Per-call completion budget — rides `max_output_tokens` verbatim. */
  maxTokens: number;
  /**
   * The selection-resolved reasoning rung mapped to an official effort
   * (registry/harness fold through resolveResponsesEffort). Required — the
   * wire never guesses a rung, so an unmappable rung fails at selection
   * (422), never here.
   */
  reasoningEffort: ResponsesEffort;
  /** A4 verdict (PM ②): image-capable rows project image parts, else degrade. */
  supportsImageInput?: boolean;
}

/** Registry/MCP tool definition → Responses function tool (strict off). */
function toFunctionTool(definition: {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}): ResponsesFunctionTool {
  return {
    type: "function",
    name: definition.name,
    description: definition.description,
    parameters: definition.input_schema,
    strict: false,
  };
}

function renderUserContentParts(segment: Extract<ContextSegment, { kind: "user" }>): {
  contentParts: ResponsesInputContentPart[];
  toolOutputs: ResponsesFunctionCallOutputItem[];
} {
  const contentParts: ResponsesInputContentPart[] = [];
  const toolOutputs: ResponsesFunctionCallOutputItem[] = [];
  for (const part of segment.parts) {
    if (part.kind === "text") {
      contentParts.push({ type: "input_text", text: part.text });
    } else if (part.kind === "image") {
      if (part.image.kind === "degraded") {
        contentParts.push({ type: "input_text", text: part.image.text });
      } else if (part.image.kind === "url") {
        contentParts.push({ type: "input_image", detail: "auto", image_url: part.image.url });
      } else {
        contentParts.push({
          type: "input_image",
          detail: "auto",
          image_url: `data:${part.image.mediaType};base64,${part.image.data}`,
        });
      }
    } else {
      // function_call_output items are standalone entries answering the
      // prior assistant; they always lead the message parts of their
      // segment (canonical history order: call → output → later user text).
      toolOutputs.push({ type: "function_call_output", call_id: part.callId, output: part.output });
    }
  }
  return { contentParts, toolOutputs };
}

function renderSegment(segment: ContextSegment): ResponsesInputItem[] {
  if (segment.kind === "assistant") {
    const items: ResponsesInputItem[] = [];
    if (segment.text !== "") {
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: segment.text, annotations: [] }],
        status: "completed",
      });
    }
    for (const call of segment.toolCalls) {
      items.push({
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
    return items;
  }
  const { contentParts, toolOutputs } = renderUserContentParts(segment);
  // Outputs first (they answer the segment-opening prior assistant), then
  // the merged user message. Image-only turns render image parts alone —
  // an empty input_text part is an upstream 400 (same rule as the
  // anthropic face's empty text blocks).
  const items: ResponsesInputItem[] = toolOutputs;
  if (contentParts.length > 0) {
    items.push({ type: "message", role: "user", content: contentParts });
  }
  return items;
}

export function responsesRequestBody(
  request: ModelRequest,
  options: ResponsesWireCallOptions,
): ResponsesRequestBody {
  const segments = walkModelRequestContext(request, {
    supportsImageInput: options.supportsImageInput,
  });
  const first = segments[0];
  if (first?.kind !== "user") {
    throw new WireAssemblyError("request must open with a user message");
  }
  const input: ResponsesInputItem[] = [];
  for (const segment of segments) {
    input.push(...renderSegment(segment));
  }

  // The think-tool pairing rule mirrors the anthropic face: when external
  // CoT renders (or forceReasoningOff pins), native reasoning goes off —
  // effort "none" is the official off value (pi-ai thinkingLevelMap.off ?? "none").
  const finalNames = resolveWireToolNames(request, options.model);
  const effort: ResponsesEffort =
    finalNames.includes("think") || request.forceReasoningOff === true
      ? "none"
      : options.reasoningEffort;

  return {
    model: options.model,
    stream: true,
    store: false,
    instructions: SYSTEM_PROMPT_BLOCKS.join("\n\n"),
    max_output_tokens: options.maxTokens,
    reasoning: { effort },
    ...(finalNames.length === 0
      ? {}
      : {
          tools: [
            ...wireToolSet(M0_RENDER_FLAGS, finalNames).map(toFunctionTool),
            ...(request.mcpTools ?? []).map(toFunctionTool),
          ],
        }),
    ...(request.toolChoice === undefined
      ? {}
      : { tool_choice: { type: "function", name: request.toolChoice.name } }),
    input,
  };
}
