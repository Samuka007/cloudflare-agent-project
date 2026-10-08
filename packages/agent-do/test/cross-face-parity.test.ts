import { describe, expect, test } from "vitest";
import type { AgentEventDataByType, AgentEventType } from "../src/fsm-events.js";
import { parseAgentEvent, type AnyAgentEvent } from "../src/fsm-events.js";
import { modelRequestFromEvents } from "../src/translate.js";
import {
  anthropicRequestBody,
  SYSTEM_PROMPT_BLOCKS,
  toolUseIdFor,
  type AnthropicRequestBody,
  type RelayOutputConfig,
  type ThinkingConfig,
} from "../src/relay/wire.js";
import { responsesRequestBody, type ResponsesRequestBody } from "../src/relay/responses-wire.js";
import {
  completionsRequestBody,
  type CompletionsRequestBody,
} from "../src/relay/completions-wire.js";
import { WireAssemblyError } from "../src/relay/context-walk.js";
import type { ResponsesEffort } from "../src/provider-catalog.js";
import type { ModelRequest } from "../src/provider.js";

/**
 * Cross-face assembly parity (#549, W5 coverage-audit gap 1): the three wire
 * faces (anthropic / responses / completions) share the protocol-neutral
 * walk (context-walk.ts — construction equivalence), but every face-specific
 * renderer mapping is otherwise only pinned on the anthropic face. This file
 * feeds the SAME ModelRequest through all three renderers and asserts their
 * CANONICAL SEMANTIC PROJECTIONS are equal — never JSON equality, only the
 * walked meaning:
 *
 *   role sequence · tool-call id/name/args · tool-result text (incl. the
 *   #454 markers) · image url/inline-data classification · reasoning effort
 *   seat · tool-surface name set · forced tool_choice.
 *
 * Carrier (Phase 0 ruling, PM steering 2026-10-08): in-repo vitest + one
 * canonical projector — fast-check is NOT in the pnpm tree (adding it would
 * be a new dependency for tests-only parity), vitest goldens lock JSON bytes
 * (ticket forbids JSON equality), and @oh-my-pi/pi-agent-core ships no test
 * helpers. Scenario fixtures feed logs in the translate.test shape
 * (parseAgentEvent → modelRequestFromEvents); image/compact requests use the
 * relay-test request-literal idiom. Walk-layer pins (#549 walk 钉) construct
 * invalid ModelRequests directly and require every face to throw the same
 * WireAssemblyError (context-walk.ts:175/:186).
 *
 * Sensitivity contract: breaking ANY renderer mapping (block order, marker
 * text, data-URI round-trip, effort pin, tool_choice shape) must turn at
 * least one assertion in this file red — the positive anchors per scenario
 * keep the equality chains from passing vacuously.
 */

const THREAD = "th-parity";
const MODEL = "test-model";
const MAX_TOKENS = 8192;

function event<TType extends AgentEventType>(
  seq: number,
  type: TType,
  data: AgentEventDataByType[TType],
): AnyAgentEvent {
  // parseAgentEvent is the single validation seam — test logs go through it
  // so a malformed fixture fails here, not three layers down.
  return parseAgentEvent({ id: `e${seq}`, threadId: THREAD, seq, type, data, createdAt: 0 });
}

/** Request literal base for walk/renderer pins that need no journal fold. */
const BASE: ModelRequest = {
  threadId: THREAD,
  turnId: "t1",
  modelCallId: 9,
  input: "列出文件",
  inputImages: [],
  steers: [],
  priorCalls: [],
  asyncResults: [],
};

// ---------------------------------------------------------------------------
// Canonical semantic projection — one vocabulary for all three wire bodies.
// ---------------------------------------------------------------------------

type CanonicalImage =
  { kind: "url"; url: string } | { kind: "data"; mediaType: string; data: string };

interface CanonicalCall {
  id: string;
  name: string;
  args: unknown;
}

type CanonicalAtom =
  | { atom: "system"; text: string }
  /** One walked assistant segment: text (possibly "") + its tool calls. */
  | { atom: "assistant"; text: string; calls: CanonicalCall[] }
  | { atom: "tool-result"; callId: string; text: string }
  | { atom: "user-text"; text: string }
  | { atom: "user-image"; image: CanonicalImage };

interface CanonicalBody {
  turns: CanonicalAtom[];
  /** Reasoning effort seat: the shared ladder token ("none" when pinned). */
  effort: string;
  /** Wire tool-surface names, sorted (names only — schemas are registry-shared). */
  toolNames: string[];
  /** Forced tool choice name, or null. */
  toolChoice: string | null;
}

const DATA_URL_PATTERN = /^data:([^;]+);base64,(.+)$/;

function imageFromDataUrl(url: string): CanonicalImage | undefined {
  const match = DATA_URL_PATTERN.exec(url);
  if (match === null) return { kind: "url", url };
  return { kind: "data", mediaType: match[1] ?? "", data: match[2] ?? "" };
}

function canonicalize(
  turns: CanonicalAtom[],
  effort: string,
  toolNames: string[],
  toolChoice: string | null,
): CanonicalBody {
  // Merge adjacent assistant atoms (the responses face renders one walked
  // assistant segment as message + standalone function_call items).
  const merged: CanonicalAtom[] = [];
  for (const atom of turns) {
    const last = merged[merged.length - 1];
    if (atom.atom === "assistant" && last?.atom === "assistant") {
      merged[merged.length - 1] = {
        atom: "assistant",
        text: last.text + atom.text,
        calls: [...last.calls, ...atom.calls],
      };
      continue;
    }
    merged.push(atom);
  }
  return { turns: merged, effort, toolNames: [...toolNames].sort(), toolChoice };
}

function canonicalAnthropic(body: AnthropicRequestBody): CanonicalBody {
  const turns: CanonicalAtom[] = [
    { atom: "system", text: body.system.map((block) => block.text).join("\n\n") },
  ];
  for (const message of body.messages) {
    if (message.role === "assistant") {
      let text = "";
      const calls: CanonicalCall[] = [];
      for (const block of message.content) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use")
          calls.push({ id: block.id, name: block.name, args: block.input });
      }
      turns.push({ atom: "assistant", text, calls });
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") turns.push({ atom: "user-text", text: block.text });
      else if (block.type === "image") {
        turns.push({
          atom: "user-image",
          image:
            block.source.type === "url"
              ? { kind: "url", url: block.source.url }
              : { kind: "data", mediaType: block.source.media_type, data: block.source.data },
        });
      } else if (block.type === "tool_result")
        turns.push({ atom: "tool-result", callId: block.tool_use_id, text: block.content });
    }
  }
  const effort =
    body.output_config?.effort ??
    (body.thinking.type === "disabled" ? "none" : `thinking:${body.thinking.type}`);
  return canonicalize(
    turns,
    effort,
    (body.tools ?? []).map((tool) => tool.name),
    body.tool_choice?.name ?? null,
  );
}

function canonicalResponses(body: ResponsesRequestBody): CanonicalBody {
  const turns: CanonicalAtom[] = [{ atom: "system", text: body.instructions }];
  for (const item of body.input) {
    if (item.type === "function_call") {
      turns.push({
        atom: "assistant",
        text: "",
        calls: [{ id: item.call_id, name: item.name, args: JSON.parse(item.arguments) }],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      turns.push({ atom: "tool-result", callId: item.call_id, text: item.output });
      continue;
    }
    if (item.role === "assistant") {
      turns.push({
        atom: "assistant",
        text: item.content
          .map((part) =>
            part.type === "input_text" || part.type === "output_text" ? part.text : "",
          )
          .join(""),
        calls: [],
      });
      continue;
    }
    for (const part of item.content) {
      if (part.type === "input_text") turns.push({ atom: "user-text", text: part.text });
      else if (part.type === "input_image")
        turns.push({
          atom: "user-image",
          image: imageFromDataUrl(part.image_url) ?? { kind: "url", url: part.image_url },
        });
    }
  }
  return canonicalize(
    turns,
    body.reasoning.effort,
    (body.tools ?? []).map((tool) => tool.name),
    body.tool_choice?.name ?? null,
  );
}

function canonicalCompletions(body: CompletionsRequestBody): CanonicalBody {
  const turns: CanonicalAtom[] = [];
  for (const message of body.messages) {
    if (message.role === "system") {
      turns.push({
        atom: "system",
        text: typeof message.content === "string" ? message.content : "",
      });
      continue;
    }
    if (message.role === "assistant") {
      turns.push({
        atom: "assistant",
        text: typeof message.content === "string" ? message.content : "",
        calls: (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          args: JSON.parse(call.function.arguments) as unknown,
        })),
      });
      continue;
    }
    if (message.role === "tool") {
      turns.push({
        atom: "tool-result",
        callId: message.tool_call_id ?? "",
        text: typeof message.content === "string" ? message.content : "",
      });
      continue;
    }
    const content = message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") turns.push({ atom: "user-text", text: part.text });
        else
          turns.push({
            atom: "user-image",
            image: imageFromDataUrl(part.image_url.url) ?? { kind: "url", url: part.image_url.url },
          });
      }
    } else if (typeof content === "string") {
      turns.push({ atom: "user-text", text: content });
    }
  }
  return canonicalize(
    turns,
    body.reasoning_effort ?? "none",
    (body.tools ?? []).map((tool) => tool.function.name),
    body.tool_choice?.function.name ?? null,
  );
}

// ---------------------------------------------------------------------------
// Three-face driver: same request → three renderers → canonical equality.
// ---------------------------------------------------------------------------

interface FaceOptions {
  reasoningEffort?: ResponsesEffort;
  thinking?: ThinkingConfig;
  outputConfig?: RelayOutputConfig;
  supportsImageInput?: boolean;
  model?: string;
}

function canonicalFaces(request: ModelRequest, options: FaceOptions = {}) {
  const model = options.model ?? MODEL;
  const anthropic = anthropicRequestBody(request, {
    model,
    maxTokens: MAX_TOKENS,
    thinking: options.thinking ?? { type: "disabled" },
    ...(options.outputConfig !== undefined ? { outputConfig: options.outputConfig } : {}),
    ...(options.supportsImageInput !== undefined
      ? { supportsImageInput: options.supportsImageInput }
      : {}),
  });
  const shared = {
    model,
    maxTokens: MAX_TOKENS,
    // "none" is the deployment default posture on both openai faces (the
    // anthropic face's `thinking: disabled` equivalent) — explicit, never
    // conflated with the completions model-default absence.
    reasoningEffort: options.reasoningEffort ?? ("none" as const),
    ...(options.supportsImageInput !== undefined
      ? { supportsImageInput: options.supportsImageInput }
      : {}),
  };
  const responses = responsesRequestBody(request, shared);
  const completions = completionsRequestBody(request, shared);
  const canonical = {
    anthropic: canonicalAnthropic(anthropic),
    responses: canonicalResponses(responses),
    completions: canonicalCompletions(completions),
  };
  // The pin itself: all three canonical projections are THE SAME semantics.
  expect(canonical.responses).toEqual(canonical.anthropic);
  expect(canonical.completions).toEqual(canonical.anthropic);
  return { ...canonical, raw: { anthropic, responses, completions } };
}

// ---------------------------------------------------------------------------
// Log fixtures — translate.test log shapes fed straight through the fold.
// ---------------------------------------------------------------------------

/** Scenario 1: current-turn text only. */
function textTurnLog(): AnyAgentEvent[] {
  return [
    event(1, "thread.created", { title: "t", machineId: "local" }),
    event(2, "turn.input", {
      turnId: "t1",
      inputId: "i1",
      content: [{ type: "text", text: "列出文件" }],
    }),
    event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
  ];
}

/** Scenarios 2/3: assistant + tool_calls rebuild and tool_result pairing. */
function toolCallTurnLog(result: {
  status: "ok" | "error";
  output: string;
  errorCode?: "host_offline";
}): AnyAgentEvent[] {
  return [
    event(1, "thread.created", { title: "t", machineId: "local" }),
    event(2, "turn.input", {
      turnId: "t1",
      inputId: "i1",
      content: [{ type: "text", text: "列出文件" }],
    }),
    event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
    event(4, "model.call_completed", {
      turnId: "t1",
      modelCallId: 3,
      text: "我来列出文件。",
      toolCalls: [{ name: "bash", arguments: { command: "ls" } }],
    }),
    event(5, "tool.call", {
      turnId: "t1",
      modelCallId: 3,
      tool: "bash",
      arguments: { command: "ls" },
      timeoutMs: 600_000,
    }),
    event(6, "tool.result", {
      turnId: "t1",
      executionId: `${THREAD}:5`,
      status: result.status,
      exitCode: result.status === "ok" ? 0 : null,
      output: result.output,
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    }),
    event(7, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
  ];
}

/** Scenario 4: steer re-anchoring at the consuming call's boundary (I9). */
function steerLog(): AnyAgentEvent[] {
  return [
    event(1, "thread.created", { title: "t", machineId: "local" }),
    event(2, "turn.input", {
      turnId: "t1",
      inputId: "i1",
      content: [{ type: "text", text: "列目录" }],
    }),
    event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
    event(4, "model.call_completed", {
      turnId: "t1",
      modelCallId: 3,
      text: "",
      toolCalls: [{ name: "bash", arguments: { command: "ls" } }],
    }),
    event(5, "tool.call", {
      turnId: "t1",
      modelCallId: 3,
      tool: "bash",
      arguments: { command: "ls" },
      timeoutMs: 600_000,
    }),
    event(6, "tool.result", {
      turnId: "t1",
      executionId: `${THREAD}:5`,
      status: "ok",
      exitCode: 0,
      output: "a b c",
    }),
    event(7, "turn.steer", {
      turnId: "t1",
      inputId: "i2",
      content: [{ type: "text", text: "只要前三个" }],
    }),
    event(8, "model.call_started", { turnId: "t1", consumedSteerSeqs: [7] }),
  ];
}

/** Scenario 5: prior-turns session fold (#228). */
function priorTurnsLog(): AnyAgentEvent[] {
  return [
    event(1, "thread.created", { title: "t", machineId: "local" }),
    event(2, "turn.input", {
      turnId: "t1",
      inputId: "i1",
      content: [{ type: "text", text: "Reply with exactly: OK" }],
    }),
    event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
    event(4, "model.call_completed", {
      turnId: "t1",
      modelCallId: 3,
      text: "OK",
      toolCalls: [],
    }),
    event(5, "turn.completed", { turnId: "t1" }),
    event(6, "turn.input", {
      turnId: "t2",
      inputId: "i2",
      content: [{ type: "text", text: "Reminder: submit your final result." }],
    }),
    event(7, "model.call_started", { turnId: "t2", consumedSteerSeqs: [] }),
  ];
}

/** Scenario 6: completed-rewind boundary cut (#147). */
function rewindCutLog(): AnyAgentEvent[] {
  const summary = "leak is in the drain path";
  return [
    event(1, "thread.created", { title: "t", machineId: "local" }),
    event(2, "turn.input", {
      turnId: "t1",
      inputId: "i1",
      content: [{ type: "text", text: "find the leak" }],
    }),
    event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
    event(4, "model.call_completed", {
      turnId: "t1",
      modelCallId: 3,
      text: "",
      toolCalls: [{ name: "checkpoint", arguments: { goal: "find the leak" } }],
    }),
    event(5, "tool.call", {
      turnId: "t1",
      modelCallId: 3,
      tool: "checkpoint",
      arguments: { goal: "find the leak" },
      timeoutMs: 600_000,
    }),
    event(6, "tool.result", {
      turnId: "t1",
      executionId: `${THREAD}:5`,
      status: "ok",
      exitCode: 0,
      output: "Checkpoint: find the leak",
    }),
    event(7, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
    event(8, "model.call_completed", {
      turnId: "t1",
      modelCallId: 7,
      text: "",
      toolCalls: [{ name: "rewind", arguments: { report: `  ${summary}  ` } }],
    }),
    event(9, "tool.call", {
      turnId: "t1",
      modelCallId: 7,
      tool: "rewind",
      arguments: { report: `  ${summary}  ` },
      timeoutMs: 600_000,
    }),
    event(10, "tool.result", {
      turnId: "t1",
      executionId: `${THREAD}:9`,
      status: "ok",
      exitCode: 0,
      output: "Rewind requested.",
    }),
    event(11, "turn.completed", { turnId: "t1" }),
    event(12, "turn.input", {
      turnId: "t2",
      inputId: "i2",
      content: [{ type: "text", text: "continue" }],
    }),
    event(13, "model.call_started", { turnId: "t2", consumedSteerSeqs: [] }),
  ];
}

// ---------------------------------------------------------------------------
// Scenarios — one describe block per ticket row, equality + positive anchors.
// ---------------------------------------------------------------------------

describe("cross-face canonical parity (#549): anthropic == responses == completions", () => {
  test("current-turn text folds identically on all three faces", () => {
    const request = modelRequestFromEvents(textTurnLog(), "t1", 3);
    const { anthropic } = canonicalFaces(request);
    // Positive anchors: the equality chain must not pass vacuously.
    expect(anthropic.turns[0]).toEqual({
      atom: "system",
      text: SYSTEM_PROMPT_BLOCKS.join("\n\n"),
    });
    expect(anthropic.turns).toContainEqual({ atom: "user-text", text: "列出文件" });
  });

  test("assistant + tool_calls rebuild: same id/name/args pairing everywhere", () => {
    const request = modelRequestFromEvents(
      toolCallTurnLog({ status: "ok", output: "a\n" }),
      "t1",
      7,
    );
    const { anthropic } = canonicalFaces(request);
    expect(anthropic.turns).toContainEqual({
      atom: "assistant",
      text: "我来列出文件。",
      calls: [{ id: toolUseIdFor(`${THREAD}:5`), name: "bash", args: { command: "ls" } }],
    });
    expect(anthropic.turns).toContainEqual({
      atom: "tool-result",
      callId: toolUseIdFor(`${THREAD}:5`),
      text: "a\n",
    });
  });

  test("tool_result pairing with the #454 refusal marker (互引 tool-result-contract.test)", () => {
    // The full journal/ux contract lives in tool-result-contract.test.ts
    // (#454); this pins the MODEL FACE half across all three renderers.
    const request = modelRequestFromEvents(
      toolCallTurnLog({
        status: "error",
        output: "tool not executed: bound host offline",
        errorCode: "host_offline",
      }),
      "t1",
      7,
    );
    const { anthropic } = canonicalFaces(request);
    expect(anthropic.turns).toContainEqual({
      atom: "tool-result",
      callId: toolUseIdFor(`${THREAD}:5`),
      text: "[tool error host_offline] tool not executed: bound host offline",
    });
  });

  test("steer re-anchors AFTER its boundary tool result on every face (I9)", () => {
    const request = modelRequestFromEvents(steerLog(), "t1", 8);
    const { anthropic } = canonicalFaces(request);
    const resultIndex = anthropic.turns.findIndex(
      (atom) => atom.atom === "tool-result" && atom.text === "a b c",
    );
    expect(anthropic.turns[resultIndex + 1]).toEqual({
      atom: "user-text",
      text: "只要前三个",
    });
  });

  test("priorTurns fold (#228): input → assistant → reminder, identically", () => {
    const request = modelRequestFromEvents(priorTurnsLog(), "t2", 7);
    const { anthropic } = canonicalFaces(request);
    expect(anthropic.turns.slice(1)).toEqual([
      { atom: "user-text", text: "Reply with exactly: OK" },
      { atom: "assistant", text: "OK", calls: [] },
      { atom: "user-text", text: "Reminder: submit your final result." },
    ]);
  });

  test("rewind cut (#147): the branch summary overlays first, identically", () => {
    const request = modelRequestFromEvents(rewindCutLog(), "t2", 13);
    expect(request.branchCut).toEqual({
      checkpointResultSeq: 6,
      rewindResultSeq: 10,
      summary: "leak is in the drain path",
    });
    const { anthropic } = canonicalFaces(request);
    expect(anthropic.turns.slice(1)).toEqual([
      { atom: "user-text", text: "[branch-summary] leak is in the drain path" },
      { atom: "user-text", text: "continue" },
    ]);
  });

  test("compact surface (#309): tool-free summarization request on all faces", () => {
    const request: ModelRequest = { ...BASE, input: "总结本会话", toolSurface: "compaction" };
    const { anthropic } = canonicalFaces(request, { reasoningEffort: "none" });
    expect(anthropic.toolNames).toEqual([]);
    expect(anthropic.turns).toContainEqual({ atom: "user-text", text: "总结本会话" });
  });

  test("image three-way classification rides identically (capable row)", () => {
    const request: ModelRequest = {
      ...BASE,
      input: "",
      inputImages: [
        { kind: "url", url: "https://img.test/a.png" },
        { kind: "data", mediaType: "image/png", base64: "aGk=" },
        { kind: "path", path: "/tmp/x.png" },
      ],
    };
    const { anthropic } = canonicalFaces(request, {
      reasoningEffort: "none",
      supportsImageInput: true,
    });
    // url stays a url; data survives the data-URI round-trip byte-exact;
    // path degrades to the acp anchor text even on a capable row.
    expect(anthropic.turns.slice(1)).toEqual([
      { atom: "user-image", image: { kind: "url", url: "https://img.test/a.png" } },
      {
        atom: "user-image",
        image: { kind: "data", mediaType: "image/png", data: "aGk=" },
      },
      { atom: "user-text", text: "[image attachment on disk: /tmp/x.png]" },
    ]);
  });

  test("image three-way classification rides identically (incapable row degrades all)", () => {
    const request: ModelRequest = {
      ...BASE,
      input: "",
      inputImages: [
        { kind: "url", url: "https://img.test/a.png" },
        { kind: "data", mediaType: "image/png", base64: "aGk=" },
        { kind: "path", path: "/tmp/x.png" },
      ],
    };
    const { anthropic } = canonicalFaces(request, { reasoningEffort: "none" });
    expect(anthropic.turns.slice(1)).toEqual([
      { atom: "user-text", text: "[image attachment: https://img.test/a.png]" },
      { atom: "user-text", text: "[image attachment: inline image/png]" },
      { atom: "user-text", text: "[image attachment on disk: /tmp/x.png]" },
    ]);
  });

  test("#257 thinking is never replayed into history on any face", () => {
    const request = modelRequestFromEvents(
      toolCallTurnLog({ status: "ok", output: "a\n" }),
      "t1",
      7,
    );
    const { raw } = canonicalFaces(request);
    // responses: history items are message/function_call/function_call_output
    // ONLY — a reasoning item sneaking into the replay must go red here.
    for (const item of raw.responses.input) {
      expect(item.type).not.toBe("reasoning");
    }
    // anthropic: assistant rebuild carries text + tool_use, never thinking.
    for (const message of raw.anthropic.messages) {
      for (const block of message.content) {
        expect(block.type).not.toBe("thinking");
      }
    }
    // completions: no message grows a reasoning field.
    for (const message of raw.completions.messages) {
      expect(Object.prototype.hasOwnProperty.call(message, "reasoning")).toBe(false);
    }
  });

  test("ToC pairing (completions-relay.test:226 shape): forceReasoningOff pins effort none everywhere", () => {
    const request: ModelRequest = { ...BASE, forceReasoningOff: true };
    // The caller asks for high + adaptive thinking — the pin must override.
    const { anthropic, responses, completions } = canonicalFaces(request, {
      reasoningEffort: "high",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "high" },
    });
    expect(anthropic.effort).toBe("none");
    expect(responses.effort).toBe("none");
    expect(completions.effort).toBe("none");
  });

  test("ToC pairing: the think tool on the surface pins effort none everywhere", () => {
    const request: ModelRequest = {
      ...BASE,
      experimentalGates: {
        externalThinking: true,
        contextNotes: false,
        checkpoint: false,
        generateImage: false,
      },
    };
    // A non-native family (qwen3) keeps the think tool (glm would filter it).
    const { anthropic, responses, completions } = canonicalFaces(request, {
      reasoningEffort: "high",
      model: "qwen3",
    });
    for (const face of [anthropic, responses, completions]) {
      expect(face.toolNames).toContain("think");
      expect(face.effort).toBe("none");
    }
  });

  test("effort rides verbatim when the think tool is gated off", () => {
    const request: ModelRequest = {
      ...BASE,
      experimentalGates: {
        externalThinking: false,
        contextNotes: true,
        checkpoint: true,
        generateImage: true,
      },
    };
    const { anthropic, responses, completions } = canonicalFaces(request, {
      reasoningEffort: "high",
      outputConfig: { effort: "high" },
    });
    for (const face of [anthropic, responses, completions]) {
      expect(face.toolNames).not.toContain("think");
      expect(face.effort).toBe("high");
    }
  });

  test("forced tool_choice (T17) renders the same forced name on all faces", () => {
    const request: ModelRequest = { ...BASE, toolChoice: { name: "yield" } };
    const { anthropic } = canonicalFaces(request, { reasoningEffort: "none" });
    expect(anthropic.toolChoice).toBe("yield");
    expect(canonicalFaces(request, { reasoningEffort: "none" }).responses.toolChoice).toBe("yield");
    expect(canonicalFaces(request, { reasoningEffort: "none" }).completions.toolChoice).toBe(
      "yield",
    );
  });
});

// ---------------------------------------------------------------------------
// Walk-layer pins (#549 walk 钉): assembly invariant violations are
// WireAssemblyErrors on EVERY face — never a silently mis-shaped request.
// ---------------------------------------------------------------------------

describe("cross-face walk pins: WireAssemblyError parity", () => {
  const A_OPTS = { model: MODEL, maxTokens: MAX_TOKENS, thinking: { type: "disabled" } as const };
  const OPENAI_OPTS = { model: MODEL, maxTokens: MAX_TOKENS, reasoningEffort: "none" as const };

  test("orphan tool_call (no paired result executionId) throws on all faces (context-walk.ts:175)", () => {
    const request: ModelRequest = {
      ...BASE,
      priorCalls: [
        {
          modelCallId: 3,
          steers: [],
          text: "determined",
          toolCalls: [{ name: "bash", arguments: { command: "ls" } }],
          toolResults: [],
          asyncResults: [],
        },
      ],
    };
    for (const render of [
      () => anthropicRequestBody(request, A_OPTS),
      () => responsesRequestBody(request, OPENAI_OPTS),
      () => completionsRequestBody(request, OPENAI_OPTS),
    ]) {
      expect(render).toThrow(WireAssemblyError);
      expect(render).toThrow(/no paired result executionId/);
    }
  });

  test("empty assistant (no text, no calls) throws on all faces (context-walk.ts:186)", () => {
    const request: ModelRequest = {
      ...BASE,
      priorCalls: [
        {
          modelCallId: 3,
          steers: [],
          text: "",
          toolCalls: [],
          toolResults: [],
          asyncResults: [],
        },
      ],
    };
    for (const render of [
      () => anthropicRequestBody(request, A_OPTS),
      () => responsesRequestBody(request, OPENAI_OPTS),
      () => completionsRequestBody(request, OPENAI_OPTS),
    ]) {
      expect(render).toThrow(WireAssemblyError);
      expect(render).toThrow(/assistant message has no content/);
    }
  });
});
