import type { ModelRequest, PriorModelCall, SteerContribution } from "../provider.js";
import {
  enabledToolNames,
  MAIN_WIRE_TOOLS,
  M0_RENDER_FLAGS,
  subagentWireTools,
  wireToolSet,
} from "../tools/registry.js";
import type { AsyncResultContribution } from "../provider.js";

/**
 * Anthropic Message wire assembly (#28 ruling ③ translation layer, omp §1.5
 * shapes). Pure and deterministic: the same ModelRequest always serializes to
 * byte-identical JSON — ids derive from the log (executionId), never from the
 * wire; no timestamps, no randomness, fixed key insertion order.
 */

export interface AnthropicTextBlock {
  type: "text";
  text: string;
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

export type AnthropicUserBlock = AnthropicTextBlock | AnthropicToolResultBlock;
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
  tools: AnthropicToolDefinition[];
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

export class WireAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireAssemblyError";
  }
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
// Request assembly — append-only build (omp append-only-context semantics:
// the log folds into messages in seq order; nothing is reordered or
// re-serialized per call). Roles strictly alternate: consecutive user-side
// material (input, steers, tool results) merges into one user message.
// ---------------------------------------------------------------------------

/** Deterministic tool_use id derived from the log — never the wire's id. */
export function toolUseIdFor(executionId: string): string {
  return `toolu_${executionId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;
}

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

/** Anthropic rejects empty tool_result content — omp fills a sentinel. */
const EMPTY_OUTPUT_SENTINEL = "(empty output)";

export interface WireCallOptions {
  model: string;
  maxTokens: number;
  thinking?: ThinkingConfig;
}

export function anthropicRequestBody(
  request: ModelRequest,
  options: WireCallOptions,
): AnthropicRequestBody {
  const messages: AnthropicMessage[] = [];
  /** User-side blocks accumulated since the last assistant message. */
  let pendingUserBlocks: AnthropicUserBlock[] = [];

  const flushUser = (): void => {
    if (pendingUserBlocks.length === 0) return;
    messages.push({ role: "user", content: pendingUserBlocks });
    pendingUserBlocks = [];
  };

  const appendSteers = (steers: readonly SteerContribution[]): void => {
    for (const steer of steers) {
      pendingUserBlocks.push({ type: "text", text: steer.text });
    }
  };

  /**
   * M1.5 T16 async-result follow-ups ride the same boundary position as
   * steers — the user-side material of the call they attribute to (omp
   * injects them as follow-up messages into the run; the boundary merge is
   * our alternation-safe shape). Each result renders as one tagged text
   * block, prefixed `[async-result]` for model-side recognition.
   */
  const appendAsyncResults = (results: readonly AsyncResultContribution[]): void => {
    for (const result of results) {
      pendingUserBlocks.push({ type: "text", text: `[async-result] ${result.text}` });
    }
  };

  const assistantOf = (call: PriorModelCall): AnthropicMessage => {
    const content: AnthropicAssistantBlock[] = [];
    if (call.text !== "") {
      content.push({ type: "text", text: call.text });
    }
    call.toolCalls.forEach((call_, index) => {
      const executionId = call.toolResults[index]?.executionId;
      if (executionId === undefined) {
        throw new WireAssemblyError(
          `call ${call.modelCallId}: toolCall #${index} has no paired result executionId`,
        );
      }
      content.push({
        type: "tool_use",
        id: toolUseIdFor(executionId),
        name: call_.name,
        input: call_.arguments,
      });
    });
    if (content.length === 0) {
      throw new WireAssemblyError(`call ${call.modelCallId}: assistant message has no content`);
    }
    return { role: "assistant", content };
  };

  // turn input opens the history.
  pendingUserBlocks.push({ type: "text", text: request.input });

  for (const call of request.priorCalls) {
    appendAsyncResults(call.asyncResults);
    // This call's boundary steers merge into the user message that the API
    // positionally places right before its assistant response.
    appendSteers(call.steers);
    flushUser();
    messages.push(assistantOf(call));
    // Terminal results answer this assistant's tool_use blocks; they open
    // the next user message.
    for (const result of call.toolResults) {
      pendingUserBlocks.push({
        type: "tool_result",
        tool_use_id: toolUseIdFor(result.executionId),
        content: result.output === "" ? EMPTY_OUTPUT_SENTINEL : result.output,
        is_error: result.status !== "ok",
      });
    }
  }
  // The current call's boundary steers ride the trailing user message — the
  // positionally-last user turn the model reads before this response (a
  // steer placed earlier would retroactively re-context prior turns).
  appendSteers(request.steers);
  appendAsyncResults(request.asyncResults);
  flushUser();

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

  return {
    model: options.model,
    max_tokens: options.maxTokens,
    stream: true,
    // #150 forceReasoningOff pairing: when external thinking (the `think`
    // tool) rides the surface, native reasoning is pinned OFF regardless of
    // the caller's thinking config — the two must never coexist.
    thinking:
      request.forceReasoningOff === true ? { type: "disabled" } : (options.thinking ?? { type: "disabled" }),
    system: SYSTEM_PROMPT_BLOCKS.map((block) => ({ type: "text", text: block })),
    // The tool surface renders from the compile-time registry only — the
    // single schema authority (control-plane-layer.md §1.1, M1.5 T1). The
    // surface (M1.5 T16) picks main vs subagent names; the subagent surface
    // carries the hidden `yield` and strips `task` past the depth cap.
    tools: (() => {
      const surface =
        request.toolSurface === "subagent"
          ? subagentWireTools(request.spawnPolicyBlocked === true)
          : MAIN_WIRE_TOOLS;
      const gated =
        request.experimentalGates === undefined ? surface : enabledToolNames(surface, request.experimentalGates);
      return wireToolSet(M0_RENDER_FLAGS, gated);
    })(),
    // M1.5 T17: the ladder's forced attempt pins `yield` as the tool choice
    // (translate derives it from the reminder marker bound to this turn).
    ...(request.toolChoice === undefined
      ? {}
      : { tool_choice: { type: "tool", name: request.toolChoice.name } }),
    messages,
  };
}
