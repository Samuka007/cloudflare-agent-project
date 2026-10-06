import { describe, expect, test } from "vitest";
import {
  RelaySelectionError,
  SYNTHETIC_RELAY_PROVIDER_ID,
  AnthropicRelayProvider,
} from "@cap/agent-do";
import {
  RelayProviderRegistry,
  decodeRelayProviderCredentials,
  relayAgentRuntime,
} from "../src/relay-registry.js";
import { FixedReplyProvider } from "../src/harness.js";

/**
 * #351 relay provider registry: the providerId-keyed dispatch half of the
 * catalog layer. Two threads selecting two models resolve two DISTINCT
 * RelayConfigs (model/maxTokens/thinking/contextWindow/imageInput walk with
 * the selected row); unknown selections throw RelaySelectionError — the
 * fail-closed red line; credential slots stay in the secret env (#255 C).
 */

const DECLARED_CATALOG = JSON.stringify({
  defaultProvider: "main",
  providers: {
    main: {
      displayName: "Main relay",
      models: [
        {
          id: "glm-5.3",
          name: "GLM-5.3",
          input: ["text", "image"],
          reasoningLevels: ["none", "low", "high"],
          defaultReasoningLevel: "high",
          contextWindow: 200_000,
          maxTokens: 8192,
        },
        { id: "glm-5.3-air", name: "GLM-5.3-Air", maxTokens: 4096 },
      ],
    },
    backup: {
      models: [
        {
          id: "flash-mini",
          reasoningLevels: ["none", "medium"],
          contextWindow: 128_000,
          maxTokens: 2048,
        },
      ],
    },
  },
});

const BUDGET_ON = {
  MODEL_RELAY_CATALOG: DECLARED_CATALOG,
  MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096",
};

describe("#351 RelayProviderRegistry resolution", () => {
  test("two selected models resolve two distinct wire configs", () => {
    const registry = RelayProviderRegistry.fromEnv(BUDGET_ON);
    const main = registry.resolve({ providerId: "main", model: "glm-5.3", reasoningLevel: "high" });
    const backup = registry.resolve({
      providerId: "backup",
      model: "flash-mini",
      reasoningLevel: "medium",
    });
    // Distinct rows, distinct scalars — the dispatch walks with the selection.
    expect([main.modelId, backup.modelId]).toEqual(["glm-5.3", "flash-mini"]);
    expect(backup.config.maxTokens).toBe(2048);
    expect(backup.config.contextWindow).toBe(128_000);
    expect(main.config.maxTokens).toBe(8192);
    // The budget knob rides any non-none rung; the rung decides.
    expect(main.config.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(backup.config.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  test("the none rung dispatches thinking disabled on the same row", () => {
    const registry = RelayProviderRegistry.fromEnv(BUDGET_ON);
    const off = registry.resolve({ providerId: "main", model: "glm-5.3", reasoningLevel: "none" });
    const on = registry.resolve({ providerId: "main", model: "glm-5.3", reasoningLevel: "high" });
    expect(off.config.thinking).toEqual({ type: "disabled" });
    expect(on.config.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  test("non-running rows read their declaration; the running row keeps the harness fold", () => {
    const registry = RelayProviderRegistry.fromEnv(BUDGET_ON);
    // No MODEL_RELAY_MODEL → the running model is the catalog default row.
    const running = registry.resolve({ providerId: "main" });
    expect(running.modelId).toBe("glm-5.3");
    expect(running.providerId).toBe("main");
    expect(running.config.supportsImageInput).toBe(true);
    // The sibling row declares no image input — capability stays per-row.
    const sibling = registry.resolve({ providerId: "main", model: "glm-5.3-air" });
    expect(sibling.config.supportsImageInput).toBe(false);
    expect(sibling.config.maxTokens).toBe(4096);
  });

  test("unknown provider/model/reasoning fail closed with named errors", () => {
    const registry = RelayProviderRegistry.fromEnv(BUDGET_ON);
    try {
      registry.resolve({ providerId: "ghost" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RelaySelectionError);
      expect((error as RelaySelectionError).code).toBe("provider_unknown");
    }
    try {
      registry.resolve({ providerId: "backup", model: "nope" });
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("model_unknown");
    }
    try {
      registry.resolve({ providerId: "backup", model: "flash-mini", reasoningLevel: "ultra" });
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("reasoning_level_unknown");
    }
  });

  test("the empty catalog state (synthesis) admits exactly the running row", () => {
    const registry = RelayProviderRegistry.fromEnv({});
    const only = registry.resolve({});
    expect(only.providerId).toBe(SYNTHETIC_RELAY_PROVIDER_ID);
    expect(only.modelId).toBe("glm-5.3");
    expect(only.reasoningLevel).toBe("none");
    expect(registry.resolve({ providerId: "omp" }).modelId).toBe("glm-5.3");
    try {
      registry.resolve({ providerId: "ghost" });
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("provider_unknown");
    }
    try {
      registry.resolve({ reasoningLevel: "high" });
      expect.unreachable();
    } catch (error) {
      // Budget off → the ladder is ["none"]: a budget rung fails closed.
      expect((error as RelaySelectionError).code).toBe("reasoning_level_unknown");
    }
    try {
      registry.resolve({ model: "glm-5.3-air" });
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("model_unknown");
    }
  });
});

describe("#351 credential slots (#255 C)", () => {
  const CREDENTIALS = JSON.stringify({
    backup: { apiKey: "k-backup", baseUrl: "https://backup.example.com/api/anthropic" },
  });
  const ENV = {
    ...BUDGET_ON,
    MODEL_RELAY_API_KEY: "k-deployment",
    MODEL_RELAY_BASE_URL_ANTHROPIC: "https://main.example.com/api/anthropic",
    MODEL_RELAY_PROVIDER_CREDENTIALS: CREDENTIALS,
  };

  test("a slotted provider rides its own upstream; the default rides the deployment slots", () => {
    const registry = RelayProviderRegistry.fromEnv(ENV);
    const main = registry.resolve({ providerId: "main", model: "glm-5.3" });
    const backup = registry.resolve({ providerId: "backup", model: "flash-mini" });
    expect(main.config.apiKey).toBe("k-deployment");
    expect(main.config.baseUrl).toBe("https://main.example.com/api/anthropic");
    expect(backup.config.apiKey).toBe("k-backup");
    expect(backup.config.baseUrl).toBe("https://backup.example.com/api/anthropic");
  });

  test("providerFor caches one instance per provider+model+rung", () => {
    const registry = RelayProviderRegistry.fromEnv(ENV);
    const first = registry.providerFor({ providerId: "backup", model: "flash-mini" });
    const again = registry.providerFor({ providerId: "backup", model: "flash-mini" });
    const otherRung = registry.providerFor({
      providerId: "backup",
      model: "flash-mini",
      reasoningLevel: "none",
    });
    expect(again).toBe(first);
    expect(otherRung).not.toBe(first);
    expect(first).toBeInstanceOf(AnthropicRelayProvider);
  });

  test("a keyless row degrades to the fixed-reply mock (mock-first, #28)", () => {
    const registry = RelayProviderRegistry.fromEnv({
      MODEL_RELAY_CATALOG: DECLARED_CATALOG,
      MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096",
    });
    const provider = registry.providerFor({ providerId: "backup", model: "flash-mini" });
    expect(provider).toBeInstanceOf(FixedReplyProvider);
  });

  test("credential decoding is strict", () => {
    expect(decodeRelayProviderCredentials(undefined)).toEqual({});
    expect(decodeRelayProviderCredentials("  ")).toEqual({});
    expect(() => decodeRelayProviderCredentials("{not-json")).toThrow(
      /MODEL_RELAY_PROVIDER_CREDENTIALS/,
    );
    expect(() =>
      decodeRelayProviderCredentials(JSON.stringify({ backup: { apiKey: 42 } })),
    ).toThrow(/apiKey/);
    expect(() =>
      decodeRelayProviderCredentials(JSON.stringify({ backup: { apiKey: "k", rogue: 1 } })),
    ).toThrow(/unknown members/);
  });

  test("relayAgentRuntime installs the default provider plus the registry resolver", () => {
    const runtime = relayAgentRuntime(ENV);
    expect(typeof runtime.resolveExecutionProvider).toBe("function");
    const resolved = runtime.resolveExecutionProvider?.({
      providerId: "backup",
      model: "flash-mini",
    });
    expect(resolved).toBeInstanceOf(AnthropicRelayProvider);
  });
});
