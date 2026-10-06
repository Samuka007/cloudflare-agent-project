import type {
  ImageContribution,
  ModelRequest,
  PriorModelCall,
  SteerContribution,
} from "../provider.js";
import {
  enabledToolNames,
  MAIN_WIRE_TOOLS,
  M0_RENDER_FLAGS,
  subagentWireTools,
  wireToolSet,
} from "../tools/registry.js";
import {
  EMPTY_OUTPUT_SENTINEL,
  WireAssemblyError,
  degradedImageText,
  toolUseIdFor,
  walkModelRequestContext,
  type ContextSegment,
  type WalkUserPart,
} from "./context-walk.js";

// Walk-level identities re-exported: the public wire API keeps naming them
// (relay/index.ts and tests import from here; #361 moved the definitions to
// the protocol-neutral walk so both protocol faces share them).
export { WireAssemblyError, toolUseIdFor };
export { EMPTY_OUTPUT_SENTINEL, degradedImageText };

/**
 * Anthropic Message wire assembly (#28 ruling ③ translation layer, omp §1.5
 * shapes). Pure and deterministic: the same ModelRequest always serializes to
 * byte-identical JSON — ids derive from the log (executionId), never from the
 * wire; no timestamps, no randomness, fixed key insertion order.
 *
 * #361: the history walk itself is protocol-neutral (context-walk.ts) — this
 * module renders the walked segments into the Anthropic Messages shape and
 * owns the Anthropic-specific frame (system blocks, thinking config, tool
 * surface). The openai-responses face (responses-wire.ts) renders the same
 * segments into Response input items.
 */

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

/**
 * Anthropic image block (relay vision source, A4): `url` for http(s)
 * references, `base64` for inline images (media type limited to the
 * API-accepted set at classification time — translate.ts).
 */
export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

export type AnthropicUserBlock =
  AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock;
export type AnthropicAssistantBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicUserBlock[] | AnthropicAssistantBlock[];
}

export type ThinkingConfig = { type: "disabled" } | { type: "enabled"; budget_tokens: number };

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  stream: true;
  thinking: ThinkingConfig;
  system: AnthropicTextBlock[];
  /** Omitted on the #309 `compaction` surface — a summary call offers no tools. */
  tools?: AnthropicToolDefinition[];
  /** Present only on the T17 forced-yield attempt (reminder ladder, 3/3). */
  tool_choice?: AnthropicToolChoiceTool;
  messages: AnthropicMessage[];
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Anthropic tool_choice — the M1.5 T17 forced-yield shape only. */
export interface AnthropicToolChoiceTool {
  type: "tool";
  name: string;
}

// ---------------------------------------------------------------------------
// System prompt — minimal M0 placeholder (#28 ruling 1: content is a future
// decision; this is identity + tool orientation + sandbox constraints only).
// omp shape (system-prompt.ts:597-609): ordered string[] blocks, preserved as
// distinct blocks on the wire so the static prefix stays cache-stable.
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT_BLOCKS: readonly string[] = [
  [
    "你是 agent-do（M0）的执行内核：运行在 Cloudflare Durable Object 编排下的编码 agent。",
    "用户以中文或英文下达任务；你通过工具调用完成任务，并用与用户一致的语言简要汇报。",
    "工具结果原样转述；没有工具证据的结论不要编造。",
  ].join("\n"),
  [
    "# 沙箱约束",
    "- bash 命令在受限 daemon 主机上执行：无交互输入（避免 vim、交互式确认等需要 stdin 的命令）。",
    "- 命令输出可能被截断；避免产生巨量输出的命令。",
    "- 不要假设命令的工作目录在多次调用之间保留；需要时在命令里显式 cd 或用绝对路径。",
    "- 执行超时由平台策略控制；长任务应拆分。",
  ].join("\n"),
];

// ---------------------------------------------------------------------------
// Request assembly — append-only build over the shared protocol-neutral walk
// (context-walk.ts). Roles strictly alternate: consecutive user-side material
// (input, steers, tool results) merges into one user message.
// ---------------------------------------------------------------------------

/**
 * omp sdk.ts:4275-4282 supportsExternalThinking: the `think` gate is
 * cfgExternalThinking ∧ supports(model) — models with NATIVE reasoning
 * families must not take external CoT (the forceReasoningOff pairing below
 * exists for the models that can). Unknown/absent model ids stay permissive:
 * the deployment env gate owns the decision there.
 */
const NATIVE_REASONING_MODEL_PATTERN = /^(glm|deepseek-r|o[13](?:-|$)|.*thinking)/i;

export function supportsExternalThinking(model: string | undefined): boolean {
  if (model === undefined || model === "") return true;
  return !NATIVE_REASONING_MODEL_PATTERN.test(model);
}

export interface WireCallOptions {
  model: string;
  maxTokens: number;
  thinking?: ThinkingConfig;
  /**
   * A4 consumption dispatch: does the deployment's relay model accept image
   * input? Absent/false → every image part renders as the acp degradation
   * text. Even a `true` verdict cannot conjure bytes for path-kind
   * contributions (no DO→staging-host channel) — those degrade regardless
   * (acp bridge/bridge.ts:1131-1153 anchor semantics).
   */
  supportsImageInput?: boolean;
}

/**
 * The gated tool-surface names for one call (both protocol faces): surface
 * selection (main/subagent/compaction), experimental gates (#150), and the
 * omp sdk.ts:4275-4282 native-reasoning `think` filter. Exported so the
 * responses wire cannot grow a second gating opinion.
 */
export function resolveWireToolNames(
  request: ModelRequest,
  model: string,
): readonly string[] {
  const surface =
    request.toolSurface === "subagent"
      ? subagentWireTools(request.spawnPolicyBlocked === true)
      : request.toolSurface === "compaction"
        ? []
        : MAIN_WIRE_TOOLS;
  const gated =
    request.experimentalGates === undefined
      ? surface
      : enabledToolNames(surface, request.experimentalGates);
  return supportsExternalThinking(model) ? gated : gated.filter((name) => name !== "think");
}

export function anthropicRequestBody(
  request: ModelRequest,
  options: WireCallOptions,
): AnthropicRequestBody {
  const messages: AnthropicMessage[] = walkModelRequestContext(request, {
    supportsImageInput: options.supportsImageInput,
  }).map(renderSegment);

  const firstMessage = messages[0];
  if (firstMessage?.role !== "user") {
    throw new WireAssemblyError("request must open with a user message");
  }
  for (let index = 1; index < messages.length; index++) {
    const currentMessage = messages[index];
    const previousMessage = messages[index - 1];
    if (currentMessage === undefined || previousMessage === undefined) continue;
    if (currentMessage.role === previousMessage.role) {
      throw new WireAssemblyError(`roles must alternate (index ${index})`);
    }
  }
  const last = messages[messages.length - 1];
  if (last?.role !== "user") {
    throw new WireAssemblyError("request must end with a user message");
  }

  // The tool surface renders from the compile-time registry only — the
  // single schema authority (control-plane-layer.md §1.1, M1.5 T1). The
  // omp sdk.ts:4275-4282 model verdict gates the `think` tool itself (the
  // gate is cfgExternalThinking ∧ supports(model) — a native-reasoning
  // family (glm, deepseek-r, o1/o3, *thinking*) never renders the
  // external-CoT tool, leaving its native thinking pathway to the harness
  // budget).
  const finalNames = resolveWireToolNames(request, options.model);
  // #150 forceReasoningOff pairing, derived where the surface is known:
  // when the `think` tool actually renders, native reasoning is pinned OFF
  // regardless of the caller's thinking config — external CoT and native
  // reasoning must never coexist (ToC risk). An explicit
  // `request.forceReasoningOff` keeps the unconditional pin for callers that
  // decide the pairing upstream of the tool surface.
  const thinking: ThinkingConfig =
    finalNames.includes("think") || request.forceReasoningOff === true
      ? { type: "disabled" }
      : (options.thinking ?? { type: "disabled" });

  return {
    model: options.model,
    max_tokens: options.maxTokens,
    stream: true,
    thinking,
    system: SYSTEM_PROMPT_BLOCKS.map((block) => ({ type: "text", text: block })),
    // Empty compaction surface: omit `tools` entirely — a tool-free request
    // never offers the model a tool_use escape hatch from summarization.
    ...(finalNames.length === 0
      ? {}
      : {
          // MCP server tools (matrix C2, #327) ride after the registry rows —
          // dynamic, deployment-config-derived names (`mcp__<server>__<tool>`)
          // that never enter the compile-time registry (control-plane §1.1
          // stays the single schema authority for REGISTERED tools; these
          // carry the server's own JSON schema verbatim, tools/mcp.ts).
          tools: [...wireToolSet(M0_RENDER_FLAGS, finalNames), ...(request.mcpTools ?? [])],
        }),
    // M1.5 T17: the ladder's forced attempt pins `yield` as the tool choice
    // (translate derives it from the reminder marker bound to this turn).
    ...(request.toolChoice === undefined
      ? {}
      : { tool_choice: { type: "tool", name: request.toolChoice.name } }),
    messages,
  };
}

/** One walked segment → one Anthropic message (block order = part order). */
function renderSegment(segment: ContextSegment): AnthropicMessage {
  if (segment.kind === "assistant") {
    const content: AnthropicAssistantBlock[] = [];
    if (segment.text !== "") content.push({ type: "text", text: segment.text });
    for (const call of segment.toolCalls) {
      content.push({ type: "tool_use", id: call.callId, name: call.name, input: call.arguments });
    }
    return { role: "assistant", content };
  }
  return { role: "user", content: segment.parts.map(renderUserBlock) };
}

function renderUserBlock(part: WalkUserPart): AnthropicUserBlock {
  switch (part.kind) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      if (part.image.kind === "degraded") return { type: "text", text: part.image.text };
      return part.image.kind === "url"
        ? { type: "image", source: { type: "url", url: part.image.url } }
        : {
            type: "image",
            source: { type: "base64", media_type: part.image.mediaType, data: part.image.data },
          };
    case "tool-result":
      return {
        type: "tool_result",
        tool_use_id: part.callId,
        content: part.output,
        is_error: part.isError,
      };
  }
}

/**
 * bytes/4 token estimate over an exact wire body (#308 estimate path).
 *
 * The estimator rides the REAL serialization — `anthropicRequestBody` output,
 * JSON.stringify'd exactly like the fetch call — so system prompt, tool
 * definitions, and the full message framing all count. UTF-8 bytes / 4 is the
 * display-grade heuristic: ≈4 bytes/token for English, and CJK's ~3 bytes/char
 * at ~0.7 tokens/char lands within the same ratio. Receipts (estimated:false)
 * always win when a provider reports them; this only covers providers that
 * never do (fixed-reply mock, degenerate upstreams).
 */
export function estimateWireRequestTokens(serializedBody: string): number {
  return Math.ceil(new TextEncoder().encode(serializedBody).byteLength / 4);
}
