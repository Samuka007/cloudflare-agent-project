import { describe, expect, test } from "vitest";
import {
  classifyHarnessProjection,
  harnessFromSnapshot,
  projectHarness,
  resolveHarness,
  snapshotHarness,
} from "../src/harness.js";
import type { HarnessEnv } from "../src/harness.js";
import { EdgeAgentProviderAdapter, type ManagerFacade } from "../src/adapter.js";
import type {
  AdapterCommand,
  AdapterCommandOutcome,
} from "../../daemon-worker/src/provider-adapter.js";
import { executionOptions } from "./helpers.js";

/**
 * Harness three keys (ticket #28): resolution defaults, env lifting, secret
 * hygiene, and the live/session change classification over both the bb
 * execution-options face and the harness three-key face.
 */

describe("harness: three-key resolution", () => {
  test("defaults to the ruled relay with mock mode when no key is present", () => {
    const harness = resolveHarness({});
    expect(harness.relay.mode).toBe("mock");
    expect(harness.relay.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(harness.relay.model).toBe("glm-5.3");
    expect(harness.relay.maxTokens).toBeGreaterThan(0);
    expect(harness.relay.thinking).toEqual({ type: "disabled" });
    expect(harness.hostBinding).toEqual({ machineId: "local" });
    expect(harness.execution).toMatchObject({
      model: "glm-5.3",
      serviceTier: "default",
      reasoningLevel: "none",
      workflowsEnabled: false,
      permissionMode: "full",
    });
  });

  test("lifts relay config, host binding, and execution policy from env", () => {
    const envShape: HarnessEnv = {
      MODEL_RELAY_BASE_URL_ANTHROPIC: "https://relay.example/anthropic",
      MODEL_RELAY_API_KEY: "k-test",
      MODEL_RELAY_MODEL: "glm-5.3-air",
      MODEL_RELAY_MAX_TOKENS: "1024",
      MODEL_RELAY_THINKING_BUDGET_TOKENS: "2048",
      DAEMON_MACHINE_ID: "host-b",
      HARNESS_PERMISSION_MODE: "accept-edits",
    };
    const harness = resolveHarness(envShape);
    expect(harness.relay.mode).toBe("anthropic");
    expect(harness.relay.baseUrl).toBe("https://relay.example/anthropic");
    expect(harness.relay.model).toBe("glm-5.3-air");
    expect(harness.relay.maxTokens).toBe(1024);
    expect(harness.relay.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(harness.hostBinding).toEqual({ machineId: "host-b" });
    expect(harness.execution).toMatchObject({
      model: "glm-5.3-air",
      permissionMode: "accept-edits",
      permissionScope: "workspace",
      approvalReviewer: "user",
      permissionEscalation: "deny",
    });
  });

  test("durable snapshots carry key presence, never the key value", () => {
    const harness = resolveHarness({ MODEL_RELAY_API_KEY: "secret-value" });
    const snapshot = snapshotHarness(harness);
    expect(snapshot).not.toContain("secret-value");
    const parsed = harnessFromSnapshot(snapshot);
    expect(parsed).not.toBeNull();
    expect(parsed?.relayKeyPresent).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("secret-value");
  });

  test("unreadable snapshots report null so drift defaults to live", () => {
    expect(harnessFromSnapshot("not json")).toBeNull();
  });
});

describe("classifyExecutionSettingsChange (bb face)", () => {
  const adapter = new EdgeAgentProviderAdapter(
    { handleAdapterCommand: () => Promise.resolve({ ok: true, result: null }) },
    resolveHarness({}),
  );

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

describe("classifyHarnessChange (three-key face)", () => {
  const adapter = new EdgeAgentProviderAdapter(
    { handleAdapterCommand: () => Promise.resolve({ ok: true, result: null }) },
    resolveHarness({}),
  );

  test("host binding change → session", () => {
    const current = resolveHarness({ DAEMON_MACHINE_ID: "host-a" });
    const next = resolveHarness({ DAEMON_MACHINE_ID: "host-b" });
    expect(adapter.classifyHarnessChange(current, next)).toBe("session");
  });

  test("relay config and live execution fields → live", () => {
    const current = resolveHarness({ MODEL_RELAY_MODEL: "glm-5.3" });
    const relayDrift = resolveHarness({
      MODEL_RELAY_MODEL: "glm-5.3-air",
      MODEL_RELAY_API_KEY: "k",
    });
    expect(adapter.classifyHarnessChange(current, relayDrift)).toBe("live");
    const executionDrift = resolveHarness({ HARNESS_PERMISSION_MODE: undefined });
    const liveExecution = resolveHarness({ MODEL_RELAY_MAX_TOKENS: "128" });
    expect(adapter.classifyHarnessChange(executionDrift, liveExecution)).toBe("live");
  });

  test("identical resolution → unchanged; projection classify agrees", () => {
    const current = resolveHarness({ MODEL_RELAY_API_KEY: "k" });
    const next = resolveHarness({ MODEL_RELAY_API_KEY: "rotated" });
    // Key rotation changes presence-only semantics? No: both present → unchanged.
    expect(adapter.classifyHarnessChange(current, next)).toBe("unchanged");
    expect(classifyHarnessProjection(projectHarness(current), projectHarness(next))).toBe(
      "unchanged",
    );
    const gainedKey = resolveHarness({});
    expect(adapter.classifyHarnessChange(gainedKey, next)).toBe("live");
  });
});

describe("adapter direct answers", () => {
  test("initialize and model/list never reach the manager", async () => {
    const seen: AdapterCommand[] = [];
    const manager: ManagerFacade = {
      handleAdapterCommand(command: AdapterCommand): Promise<AdapterCommandOutcome> {
        seen.push(command);
        return Promise.resolve({ ok: true, result: null });
      },
    };
    const adapter = new EdgeAgentProviderAdapter(manager, resolveHarness({}));
    const init = await adapter.handleCommand({ type: "initialize" }, { timeoutMs: 1_000 });
    expect(init.ok).toBe(true);
    const list = await adapter.handleCommand({ type: "model/list" }, { timeoutMs: 1_000 });
    expect(list.ok).toBe(true);
    const result = list.ok ? (list.result as { models: { model: string }[] }) : undefined;
    expect(result?.models[0]?.model).toBe("glm-5.3");
    expect(seen).toEqual([]);
  });
});
