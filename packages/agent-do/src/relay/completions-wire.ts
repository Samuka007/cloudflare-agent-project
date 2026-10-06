import type { ModelRequest } from "../provider.js";
import type { ResponsesEffort } from "../provider-catalog.js";
import { M0_RENDER_FLAGS, wireToolSet } from "../tools/registry.js";
import { walkModelRequestContext, WireAssemblyError, type ContextSegment } from "./context-walk.js";
import { resolveWireToolNames, SYSTEM_PROMPT_BLOCKS } from "./wire.js";

/**
 * OpenAI Chat Completions wire assembly (#363 adaptor face, #28 ruling ③
 * translation layer). Renders the SAME protocol-neutral context walk as the
 * anthropic/responses faces (context-walk.ts) into the `messages` list, per
 * the official current schema (POST /v1/chat/completions — the protocol
 * canon, not memory; the pi-ai openai-completions provider factory is the
 * working G1/G3 reference shape, packages/ai/src/providers/openai-completions.ts).
 *
 * Shape map (shared walk → Chat Completions):
 * - `system` blocks           → first `message` with role "system"
 *   (string content — the universal form; the `developer` role is an
 *   OpenAI-only reasoning-model nicety that compat endpoints reject)
 * - user text/image parts     → one `message` role "user", content parts
 *   `{"type":"text"}` / `{"type":"image_url","image_url":{url}}` in part order
 * - assistant text            → `message` role "assistant", string content
 * - assistant tool_use        → the same message's `tool_calls` entries
 *   (`{id, type:"function", function:{name, arguments}}`; id = toolUseIdFor —
 *   deterministic log-derived pairing, never the wire's id)
 * - tool_result               → one `message` role "tool" per result
 *   (`tool_call_id` pairing, content = output string)
 * - `thinking` budget config  → `reasoning_effort` (official vocabulary is
 *   EXACTLY the responses effort ladder: none|minimal|low|medium|high|xhigh|
 *   max — one fold, `resolveResponsesEffort`, serves both openai faces)
 * - `max_tokens`              → `max_completion_tokens` (official current;
 *   `max_tokens` is deprecated and incompatible with o-series models)
 * - forced `tool_choice{name}` → `tool_choice {type:"function", function:{name}}`
 *
 * Deterministic like the other faces: the same ModelRequest serializes to
 * byte-identical JSON. Stateless by omission — chat completions carries no
 * `previous_response_id`/`previous_response_id`-analog, and reasoning deltas
 * are deliberately NOT replayed into assistant history (the responses face's
 * text+tool_calls rebuild parity: thinking blocks stay stream-only, #257).
 */

export interface CompletionsTextPart {
  type: "text";
  text: string;
}

export interface CompletionsImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type CompletionsContentPart = CompletionsTextPart | CompletionsImagePart;

export interface CompletionsFunctionCallEntry {
  /** Deterministic pairing id (toolUseIdFor) — answered by a role:"tool" message. */
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface CompletionsMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | CompletionsContentPart[] | null;
  tool_calls?: CompletionsFunctionCallEntry[];
  tool_call_id?: string;
}

export interface CompletionsFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /** Registry schemas are JSON-schema but not strict-mode audited — pin off. */
    strict: false;
  };
}

export interface CompletionsRequestBody {
  model: string;
  stream: true;
  messages: CompletionsMessage[];
  max_completion_tokens: number;
  /**
   * Effort-pinned reasoning: "none" is the official explicit-off value —
   * sent verbatim even at none so a reasoning model never runs its default
   * budget uninvited (the responses face's same posture). Compat endpoints
   * that reject the field 400 pre-first-byte — a loud, retryable-off failure:
   * the deployment's catalog row moves to a face it can speak.
   */
  reasoning_effort?: ResponsesEffort;
  /** Omitted on the #309 `compaction` surface — a summary call offers no tools. */
  tools?: CompletionsFunctionTool[];
  /** Present only on the T17 forced-yield attempt (reminder ladder, 3/3). */
  tool_choice?: { type: "function"; function: { name: string } };
  /** Official streaming usage channel — the final usage-only chunk carries the call's receipt (#308). */
  stream_options: { include_usage: true };
}

export interface CompletionsWireCallOptions {
  model: string;
  /** Per-call completion budget — rides `max_completion_tokens` verbatim. */
  maxTokens: number;
  /**
   * The selection-resolved reasoning rung mapped to an official effort
   * (registry/harness fold through resolveResponsesEffort). Optional — the
   * chat face may run without an effort pin (unlike responses, reasoning is
   * model-conditional); absent = reasoning runs at the model default.
   */
  reasoningEffort?: ResponsesEffort;
  /** A4 verdict (PM ②): image-capable rows project image_url parts, else degrade. */
  supportsImageInput?: boolean;
}

/** Registry/MCP tool definition → Chat Completions function tool (strict pinned off). */
function toFunctionTool(definition: {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}): CompletionsFunctionTool {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.input_schema,
      strict: false,
    },
  };
}

/**
 * One walked segment → zero-plus chat messages. The walk's segment openers:
 * a user segment's tool results answer the PRIOR assistant's calls (canonical
 * history order: call → output → later user text), so they lead as role:"tool"
 * messages before the merged user message — byte-identical order to the
 * responses face's function_call_output items.
 */
function renderSegment(segment: ContextSegment): CompletionsMessage[] {
  if (segment.kind === "assistant") {
    // Empty content rides null (official; several compat endpoints also take
    // ""), and an assistant segment always carries content or calls (the walk
    // throws otherwise — WireAssemblyError before this list is built).
    const message: CompletionsMessage = {
      role: "assistant",
      content: segment.text === "" ? null : segment.text,
    };
    if (segment.toolCalls.length > 0) {
      message.tool_calls = segment.toolCalls.map((call) => ({
        id: call.callId,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
    }
    return [message];
  }
  const messages: CompletionsMessage[] = [];
  const contentParts: CompletionsContentPart[] = [];
  for (const part of segment.parts) {
    if (part.kind === "tool-result") {
      messages.push({ role: "tool", tool_call_id: part.callId, content: part.output });
    } else if (part.kind === "text") {
      contentParts.push({ type: "text", text: part.text });
    } else if (part.image.kind === "degraded") {
      contentParts.push({ type: "text", text: part.image.text });
    } else if (part.image.kind === "url") {
      contentParts.push({ type: "image_url", image_url: { url: part.image.url } });
    } else {
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${part.image.mediaType};base64,${part.image.data}` },
      });
    }
  }
  if (contentParts.length > 0) {
    messages.push({ role: "user", content: contentParts });
  }
  return messages;
}

export function completionsRequestBody(
  request: ModelRequest,
  options: CompletionsWireCallOptions,
): CompletionsRequestBody {
  const segments = walkModelRequestContext(request, {
    supportsImageInput: options.supportsImageInput,
  });
  const first = segments[0];
  if (first?.kind !== "user") {
    throw new WireAssemblyError("request must open with a user message");
  }
  const messages: CompletionsMessage[] = [
    // The static prompt prefix stays one cache-stable system string (the
    // responses face's `instructions` equivalent).
    { role: "system", content: SYSTEM_PROMPT_BLOCKS.join("\n\n") },
  ];
  for (const segment of segments) {
    messages.push(...renderSegment(segment));
  }

  // The think-tool pairing rule mirrors the other faces: when external CoT
  // renders (or forceReasoningOff pins), native reasoning goes off — effort
  // "none" is the official off value on both openai faces.
  const finalNames = resolveWireToolNames(request, options.model);
  const reasonOff = finalNames.includes("think") || request.forceReasoningOff === true;

  return {
    model: options.model,
    stream: true,
    messages,
    max_completion_tokens: options.maxTokens,
    ...(options.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: reasonOff ? "none" : options.reasoningEffort }),
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
      : { tool_choice: { type: "function", function: { name: request.toolChoice.name } } }),
    stream_options: { include_usage: true },
  };
}
