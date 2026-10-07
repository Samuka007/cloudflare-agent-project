import { describe, expect, test } from "vitest";
import { FixedReplyProvider } from "@cap/agent-do/testing";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import {
  RELAY_FALLBACK_CONTEXT_WINDOW,
  RELAY_FALLBACK_MAX_TOKENS,
  defaultExecutionOptions,
  permissionPolicyOf,
} from "../src/execution-posture.js";
import { EdgeAgentProviderAdapter, type ManagerFacade } from "../src/adapter.js";
import type {
  AdapterCommand,
  AdapterCommandOutcome,
} from "../../daemon-worker/src/provider-adapter.js";
import { executionOptions } from "./helpers.js";

/**
 * Session execution posture (#500): the invariant mode → policy mapping, the
 * default execution options assembly (no deployment model; D1-read permission
 * mode), the wire-safety fallback constants, and the bb change-classification
 * vocabulary over the adapter face.
 */

describe("permissionPolicyOf (#500 invariant table)", () => {
  test("mode fully determines scope/reviewer/escalation", () => {
    expect(permissionPolicyOf("accept-edits")).toEqual({
      permissionMode: "accept-edits",
      permissionScope: "workspace",
      approvalReviewer: "user",
      permissionEscalation: "deny",
    });
    expect(permissionPolicyOf("auto")).toEqual({
      permissionMode: "auto",
      permissionScope: "workspace",
      approvalReviewer: "automatic",
      permissionEscalation: "deny",
    });
    expect(permissionPolicyOf("full")).toEqual({
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    });
  });
});

describe("defaultExecutionOptions (#500)", () => {
  test("no deployment model; the seat mode decides the policy", () => {
    expect(defaultExecutionOptions("full")).toEqual({
      model: "",
      serviceTier: "default",
      reasoningLevel: "none",
      workflowsEnabled: false,
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    });
    expect(defaultExecutionOptions("accept-edits")).toMatchObject({
      model: "",
      reasoningLevel: "none",
      permissionMode: "accept-edits",
      permissionScope: "workspace",
      approvalReviewer: "user",
      permissionEscalation: "deny",
    });
    expect(defaultExecutionOptions("auto")).toMatchObject({
      permissionMode: "auto",
      approvalReviewer: "automatic",
    });
  });

  test("wire-safety fallback scalars stay positive constants (#496 ruling)", () => {
    expect(RELAY_FALLBACK_MAX_TOKENS).toBe(8192);
    expect(RELAY_FALLBACK_CONTEXT_WINDOW).toBe(200_000);
  });
});

describe("#308 fixed-reply usage estimate", () => {
  test("the mock reports an estimated receipt sized off the exact wire body", async () => {
    const provider = new FixedReplyProvider("mock reply", {
      model: "glm-5.3",
      maxTokens: 8192,
      thinking: { type: "disabled" },
      contextWindow: 200_000,
    });
    const chunks = [];
    for await (const chunk of provider.streamTurn(
      {
        threadId: "th",
        turnId: "t1",
        modelCallId: 1,
        input: "hi",
        inputImages: [],
        steers: [],
        priorCalls: [],
        asyncResults: [],
        experimentalGates: {
          externalThinking: false,
          contextNotes: false,
          checkpoint: false,
          generateImage: false,
        },
      },
      { signal: new AbortController().signal },
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    const [usage, reply] = chunks;
    expect(usage?.kind).toBe("usage");
    if (usage?.kind !== "usage") throw new Error("unreachable");
    expect(usage.usage).toMatchObject({
      estimated: true,
      contextWindow: 200_000,
      outputTokens: 0,
    });
    expect(usage.usage.inputTokens).toBeGreaterThan(0);
    expect(reply).toEqual({ kind: "text-delta", text: "mock reply" });
  });
});

describe("#363 fixed-reply completions face", () => {
  test("a completions-face mock renders the chat.completions wire body", async () => {
    const provider = new FixedReplyProvider("mock reply", {
      model: "glm-5.3-flash",
      maxTokens: 4096,
      thinking: { type: "disabled" },
      contextWindow: 200_000,
      api: "openai-completions",
      reasoningEffort: "none",
    });
    const chunks = [];
    for await (const chunk of provider.streamTurn(
      {
        threadId: "th",
        turnId: "t1",
        modelCallId: 1,
        input: "hi",
        inputImages: [],
        steers: [],
        priorCalls: [],
        asyncResults: [],
        experimentalGates: {
          externalThinking: false,
          contextNotes: false,
          checkpoint: false,
          generateImage: false,
        },
      },
      { signal: new AbortController().signal },
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    const [usage, reply] = chunks;
    if (usage?.kind !== "usage") throw new Error("unreachable");
    expect(usage.usage.inputTokens).toBeGreaterThan(0);
    expect(reply).toEqual({ kind: "text-delta", text: "mock reply" });
  });
});

describe("classifyExecutionSettingsChange (bb face)", () => {
  const adapter = new EdgeAgentProviderAdapter({
    handleAdapterCommand: () => Promise.resolve({ ok: true, result: null }),
  });

  test("permission policy change → session; live fields → live; none → unchanged", () => {
    const current = executionOptions();
    expect(adapter.classifyExecutionSettingsChange({ current, next: { ...current } })).toBe(
      "unchanged",
    );
    expect(
      adapter.classifyExecutionSettingsChange({
        current,
        next: { ...current, model: "glm-5.3-air" },
      }),
    ).toBe("live");
    expect(
      adapter.classifyExecutionSettingsChange({
        current,
        next: { ...current, serviceTier: "fast" },
      }),
    ).toBe("live");
    expect(
      adapter.classifyExecutionSettingsChange({
        current,
        next: { ...current, reasoningLevel: "high" },
      }),
    ).toBe("live");
    expect(
      adapter.classifyExecutionSettingsChange({
        current,
        next: executionOptions({ permissionMode: "accept-edits" }),
      }),
    ).toBe("session");
  });

  test("normalizeExecutionOptions collapses unsupported tier and provider-only flags", () => {
    const normalized = adapter.normalizeExecutionOptions({
      ...executionOptions({ serviceTier: "fast" }),
      claudeCodePermissionMode: "plan",
      memoryEnabled: true,
      providerSubagentsEnabled: true,
      claudeCodeMockCliTraffic: { enabled: false, endpoint: "" },
    });
    expect(normalized.serviceTier).toBe("default");
    expect(normalized).not.toHaveProperty("claudeCodePermissionMode");
    expect(normalized).not.toHaveProperty("memoryEnabled");
    expect(normalized).not.toHaveProperty("providerSubagentsEnabled");
    expect(normalized.model).toBe("glm-5.3");
  });
});

describe("adapter direct answers (#500 channel-free)", () => {
  test("initialize and model/list never reach the manager", async () => {
    const seen: AdapterCommand[] = [];
    const manager: ManagerFacade = {
      handleAdapterCommand(command: AdapterCommand): Promise<AdapterCommandOutcome> {
        seen.push(command);
        return Promise.resolve({ ok: true, result: null });
      },
    };
    const adapter = new EdgeAgentProviderAdapter(manager);
    const init = await adapter.handleCommand({ type: "initialize" }, { timeoutMs: 1_000 });
    expect(init.ok).toBe(true);
    // #377/#500: the host binding is the cloud placeholder; no relay mode
    // exists (the deployment channel is deleted).
    expect(init).toEqual({
      ok: true,
      result: {
        protocolVersion: 1,
        provider: "edge-agent",
        machineId: CLOUD_PLACEHOLDER_HOST_ID,
      },
    });
    const list = await adapter.handleCommand({ type: "model/list" }, { timeoutMs: 1_000 });
    expect(list.ok).toBe(true);
    const result = list.ok ? (list.result as { models: { model: string }[] }) : undefined;
    // #500: the face advertises nothing (no synthesized row); the D1 catalog
    // is the selection 正本 (#450).
    expect(result?.models).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("the adapter declares no deployment-wide image input (#500)", () => {
    const adapter = new EdgeAgentProviderAdapter({
      handleAdapterCommand: () => Promise.resolve({ ok: true, result: null }),
    });
    // The per-row verdict (provider_configs `input`) rides the relay config
    // and the execution-options projection — the adapter metadata stays the
    // conservative undeclared posture.
    expect(adapter.capabilities.supportsImageInput).toBe(false);
  });
});
