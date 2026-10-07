import { afterEach, describe, expect, test } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_EXPERIMENTAL_TOOL_CONFIG, type ExperimentalToolConfig } from "../src/config.js";
import {
  enabledToolNames,
  EXPERIMENTAL_TOOL_GATE,
  MAIN_WIRE_TOOLS,
  subagentWireTools,
  TOOL_REGISTRY,
} from "../src/tools/registry.js";
import { anthropicRequestBody, supportsExternalThinking } from "../src/relay/wire.js";
import type { ModelRequest } from "../src/provider.js";
import { createRig, resetRuntime } from "./helpers.js";

/**
 * #150 L1 — the experimental tools are gated OFF by default (omp
 * tools/index.ts:766-772 posture: cfgExternalThinking,
 * cfgCompactionExperimentalContextManagement, cfgCheckpointEnabled) and the
 * `think` gate pairs with the omp forceReasoningOff reasoning pin
 * (sdk.ts:4275-4282). #502: the gate VALUES come from the D1
 * `tool_capabilities` seat (hot-applied via AgentDO.applyToolCapabilities at
 * the turn boundary — the env inputs are deleted); generate_image's gate is
 * NOT part of the seat — it folds from the 产图源 seat (#448); the wire
 * shape still carries it as the fourth boolean.
 */

afterEach(() => {
  resetRuntime();
});

const FIVE = ["think", "context_notes", "new_context", "checkpoint", "rewind"];
const SIX = [...FIVE, "generate_image"];

const GATES_ON = {
  externalThinking: true,
  contextNotes: true,
  checkpoint: true,
  generateImage: true,
};

function requestWith(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    threadId: "th",
    turnId: "t1",
    modelCallId: 2,
    input: "go",
    inputImages: [],
    steers: [],
    priorCalls: [],
    asyncResults: [],
    ...overrides,
  };
}

function wireNames(request: ModelRequest): string[] {
  const tools = anthropicRequestBody(request, { model: "test-model", maxTokens: 64 }).tools ?? [];
  return tools.map((tool) => tool.name);
}

describe("#150/#322 — gate map covers exactly the experimental tools", () => {
  test("EXPERIMENTAL_TOOL_GATE keys are the six; every gate key exists in the config", () => {
    expect(Object.keys(EXPERIMENTAL_TOOL_GATE).sort()).toEqual([...SIX].sort());
    for (const gate of Object.values(EXPERIMENTAL_TOOL_GATE)) {
      expect(
        gate === "externalThinking" ||
          gate === "contextNotes" ||
          gate === "checkpoint" ||
          gate === "generateImage",
      ).toBe(true);
    }
    // The gated names are registered rows (the gate map can only hide real tools).
    for (const name of SIX) {
      expect(TOOL_REGISTRY.some((row) => row.name === name)).toBe(true);
    }
  });

  test("#502 absent row = the omp posture defaults (all gates off)", () => {
    expect(DEFAULT_EXPERIMENTAL_TOOL_CONFIG).toEqual({
      externalThinking: false,
      contextNotes: false,
      checkpoint: false,
    });
  });

  test("#502 the D1 seat applies at the turn boundary (applyToolCapabilities)", async () => {
    const rig = await createRig({ turns: [{ deltas: ["ok"] }] });
    const first = await rig.stub.sendMessage({
      clientRequestId: "gates-default",
      mode: "auto",
      content: [{ type: "text", text: "hi" }],
    });
    await rig.waitTurnComplete(first.turnId);
    // Nothing applied yet = the omp posture on the wire (defaults + the
    // #448 image seat folding to off).
    expect(rig.mock().calls[0]?.experimentalGates).toEqual({
      ...DEFAULT_EXPERIMENTAL_TOOL_CONFIG,
      generateImage: false,
    });

    // The composed worker's turn-boundary refresh calls this with the
    // overlay row; `configured` is overlay-only presence and must not leak
    // into the DO state or the model wire.
    await runInDurableObject(rig.stub, (instance) => {
      const seat = {
        externalThinking: true,
        contextNotes: true,
        checkpoint: true,
        configured: true,
      };
      instance.applyToolCapabilities(seat);
      const seam = instance as unknown as { experimentalGates: ExperimentalToolConfig };
      expect(seam.experimentalGates).toEqual({
        externalThinking: true,
        contextNotes: true,
        checkpoint: true,
      });
    });
    const second = await rig.stub.sendMessage({
      clientRequestId: "gates-on",
      mode: "auto",
      content: [{ type: "text", text: "hi again" }],
    });
    await rig.waitTurnComplete(second.turnId);
    // The next turn's request carries the flipped gates (the per-call read).
    expect(rig.mock().calls[1]?.experimentalGates).toEqual({
      externalThinking: true,
      contextNotes: true,
      checkpoint: true,
      generateImage: false,
    });
  });
});

describe("#150 — default wire: the five are absent; gated wire: present", () => {
  test("default gates strip all five from the main and subagent surfaces", () => {
    const mainDefault = wireNames(
      requestWith({
        experimentalGates: { ...DEFAULT_EXPERIMENTAL_TOOL_CONFIG, generateImage: false },
      }),
    );
    for (const name of FIVE) expect(mainDefault).not.toContain(name);
    const subDefault = wireNames(
      requestWith({
        toolSurface: "subagent",
        experimentalGates: { ...DEFAULT_EXPERIMENTAL_TOOL_CONFIG, generateImage: false },
      }),
    );
    for (const name of FIVE) expect(subDefault).not.toContain(name);
    // Everything else stays (spot: read/bash/task/yield on the subagent face).
    expect(subDefault).toContain("read");
    expect(subDefault).toContain("yield");
  });

  test("gates on restore the five on both surfaces (order-stable filter)", () => {
    const mainGated = enabledToolNames(MAIN_WIRE_TOOLS, GATES_ON);
    for (const name of FIVE) expect(mainGated).toContain(name);
    const subGated = enabledToolNames(subagentWireTools(false), GATES_ON);
    for (const name of FIVE) expect(subGated).toContain(name);
    // Absent-gates request = ungated default surfaces (mock passthrough).
    expect(wireNames(requestWith())).toEqual(wireNames(requestWith({})));
  });
});

describe("#150/#257 — forceReasoningOff pairing (sdk.ts:4275-4282)", () => {
  test("a rendered think tool pins native reasoning OFF even against the caller's thinking config", () => {
    const body = anthropicRequestBody(
      requestWith({
        experimentalGates: { ...GATES_ON },
        forceReasoningOff: true,
      }),
      { model: "test-model", maxTokens: 64, thinking: { type: "enabled", budget_tokens: 1024 } },
    );
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  test("the model verdict strips think for native-reasoning families and keeps native thinking available (#257)", () => {
    const glmBody = anthropicRequestBody(requestWith({ experimentalGates: { ...GATES_ON } }), {
      model: "glm-5.3",
      maxTokens: 64,
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    expect((glmBody.tools ?? []).some((tool) => tool.name === "think")).toBe(false);
    expect(glmBody.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("without the pairing the caller's thinking config is respected", () => {
    const body = anthropicRequestBody(
      requestWith({
        experimentalGates: { ...DEFAULT_EXPERIMENTAL_TOOL_CONFIG, generateImage: false },
      }),
      { model: "test-model", maxTokens: 64, thinking: { type: "enabled", budget_tokens: 1024 } },
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });
});

describe("#150 — supportsExternalThinking model verdict", () => {
  test("native-reasoning families are refused; unknown/absent ids stay permissive", () => {
    expect(supportsExternalThinking("glm-5.3-flash")).toBe(false);
    expect(supportsExternalThinking("deepseek-r1")).toBe(false);
    expect(supportsExternalThinking("o1-mini")).toBe(false);
    expect(supportsExternalThinking("o3")).toBe(false);
    expect(supportsExternalThinking("qwen3-thinking")).toBe(false);
    expect(supportsExternalThinking(undefined)).toBe(true);
    expect(supportsExternalThinking("")).toBe(true);
    expect(supportsExternalThinking("test-model")).toBe(true);
  });
});
