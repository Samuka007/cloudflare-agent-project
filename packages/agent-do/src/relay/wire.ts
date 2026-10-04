import type { ModelRequest, PriorModelCall, SteerContribution } from "../provider.js";

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
  messages: AnthropicMessage[];
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export class WireAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireAssemblyError";
  }
}

// ---------------------------------------------------------------------------
// bash tool — omp verbatim (anchored at omp d4d49e71: schema from
// packages/coding-agent/src/tools/bash.ts:330-337, description template from
// prompts/tools/bash.md rendered with M0 conditionals all false: no eval, no
// async, no long-lived services, no auto-background). Per omp agent-loop.ts
// normalizeTools (:916-998) the runtime injects the `i` intent field into
// every tool: required, first, 200-char cap — it is loop-level injection, not
// part of the tool author's schema.
// ---------------------------------------------------------------------------

const BASH_TIMEOUT_DESCRIPTION =
  "timeout in seconds; 0 disables the command deadline; nonzero values are clamped to 1-600";

const INTENT_FIELD_DESCRIPTION = "concise intent";

export const BASH_TOOL: AnthropicToolDefinition = {
  name: "bash",
  description: [
    "Persistent shell: one fact command/pipeline; dependencies use `&&`.",
    "Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.",
    "`cwd`, not `cd`; `pty` only interactive.",
    "Internal URIs work as paths for builtins/coreutils, redirects, globs.",
    "No `head`/`tail`/redirection; output trunc by default, full result at `artifact://<id>`.",
  ].join("\n"),
  input_schema: {
    type: "object",
    properties: {
      i: { type: "string", description: INTENT_FIELD_DESCRIPTION, maxLength: 200 },
      command: { type: "string" },
      timeout: { type: "number", description: BASH_TIMEOUT_DESCRIPTION },
      cwd: { type: "string" },
      pty: { type: "boolean" },
    },
    required: ["i", "command"],
    additionalProperties: false,
  },
};

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
  flushUser();

  const firstMessage = messages[0];
  if (firstMessage === undefined || firstMessage.role !== "user") {
    throw new WireAssemblyError("request must open with a user message");
  }
  for (let index = 1; index < messages.length; index++) {
    const currentMessage = messages[index];
    const previousMessage = messages[index - 1];
    if (
      currentMessage !== undefined &&
      previousMessage !== undefined &&
      currentMessage.role === previousMessage.role
    ) {
      throw new WireAssemblyError(`roles must alternate (index ${index})`);
    }
  }
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "user") {
    throw new WireAssemblyError("request must end with a user message");
  }

  return {
    model: options.model,
    max_tokens: options.maxTokens,
    stream: true,
    thinking: options.thinking ?? { type: "disabled" },
    system: SYSTEM_PROMPT_BLOCKS.map((block) => ({ type: "text", text: block })),
    tools: [BASH_TOOL],
    messages,
  };
}
