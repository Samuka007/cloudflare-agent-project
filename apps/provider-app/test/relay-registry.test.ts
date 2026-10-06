import { describe, expect, test } from "vitest";
import {
  RelaySelectionError,
  AnthropicRelayProvider,
  CompletionsRelayProvider,
  ResponsesRelayProvider,
} from "@cap/agent-do";
import {
  RelayProviderRegistry,
  decodeRelayProviderCredentials,
  relayAgentRuntime,
} from "../src/relay-registry.js";

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

  test("the empty catalog state admits nothing (#434 fail-closed)", () => {
    const registry = RelayProviderRegistry.fromEnv({});
    // No selection and no declared default → the named undeclared-default 422.
    expect(() => registry.resolve({})).toThrow(/names no defaultProvider/);
    // The retired "omp" sentinel is an unknown provider like any other —
    // sentinel-era stored threads fail loudly (point ⑧).
    try {
      registry.resolve({ providerId: "omp" });
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("provider_unknown");
    }
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
      // No provider resolvable at all — the default absence fires first.
      expect((error as RelaySelectionError).code).toBe("provider_default_undeclared");
    }
    try {
      registry.resolve({ model: "glm-5.3-air" });
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("provider_default_undeclared");
    }
  });
});

describe("#351 selection defaults over a declared catalog", () => {
  test("no explicit selection resolves the declaration's defaultProvider", () => {
    const registry = RelayProviderRegistry.fromEnv(BUDGET_ON);
    const resolved = registry.resolve({});
    expect(resolved.providerId).toBe("main");
    expect(resolved.modelId).toBe("glm-5.3");
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

  test("a keyless row fails dispatch with the named credential error (#434 ⑦)", () => {
    const registry = RelayProviderRegistry.fromEnv({
      MODEL_RELAY_CATALOG: DECLARED_CATALOG,
      MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096",
    });
    expect(() => registry.providerFor({ providerId: "backup", model: "flash-mini" })).toThrow(
      /backup.*no usable credential.*MODEL_RELAY_PROVIDER_CREDENTIALS/s,
    );
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

describe("#361 openai-responses dispatch", () => {
  const RESPONSES_CATALOG = JSON.stringify({
    defaultProvider: "newapi",
    providers: {
      newapi: {
        displayName: "newapi",
        baseUrl: "https://newapi.samuka007.top/v1",
        api: "openai-responses",
        models: [
          {
            id: "glm-5.3-flash",
            reasoningLevels: ["none", "low", "high", "xhigh"],
            defaultReasoningLevel: "none",
            contextWindow: 200_000,
            maxTokens: 8192,
          },
          // Per-model override: identity face but a custom effort map
          // (omp models.yml compat.reasoningEffortMap deepseek anchor).
          {
            id: "deepseek-v4-pro",
            api: "openai-responses",
            reasoningLevels: ["none", "high", "xhigh"],
            reasoningEffortMap: { xhigh: "max" },
          },
          // A rung the responses wire cannot express without a map entry —
          // ladder-valid but effort-unmappable.
          {
            id: "ultra-row",
            reasoningLevels: ["none", "ultra"],
            defaultReasoningLevel: "none",
          },
        ],
      },
    },
  });

  const ENV = {
    MODEL_RELAY_CATALOG: RESPONSES_CATALOG,
    MODEL_RELAY_MODEL: "glm-5.3-flash",
    MODEL_RELAY_API_KEY: "k-deployment",
    MODEL_RELAY_BASE_URL_ANTHROPIC: "https://unused-anthropic.example/api",
    // Budget rungs only exist while the thinking budget is on (#350
    // contradiction-2 discipline — ladder collapse comes first).
    MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096",
  };

  test("a catalog api: openai-responses row dispatches the ResponsesRelayProvider", () => {
    const registry = RelayProviderRegistry.fromEnv(ENV);
    const provider = registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" });
    expect(provider).toBeInstanceOf(ResponsesRelayProvider);
  });

  test("the resolved config carries the face, base, and the rung-mapped effort", () => {
    const registry = RelayProviderRegistry.fromEnv(ENV);
    const resolution = registry.resolve({
      providerId: "newapi",
      model: "glm-5.3-flash",
      reasoningLevel: "high",
    });
    expect(resolution.config.api).toBe("openai-responses");
    // Credential-slot fallback: no newapi slot → the deployment single-relay
    // slot rides (baseUrl stays the DECLARED provider shape test's business).
    expect(resolution.config.apiKey).toBe("k-deployment");
    expect(resolution.config.reasoningEffort).toBe("high");
    // Per-model map wins over the identity default (xhigh → max).
    const deepseek = registry.resolve({
      providerId: "newapi",
      model: "deepseek-v4-pro",
      reasoningLevel: "xhigh",
    });
    expect(deepseek.config.reasoningEffort).toBe("max");
  });

  test("an effort-unmappable rung on a responses row fails closed with the named 422", () => {
    const registry = RelayProviderRegistry.fromEnv(ENV);
    try {
      registry.resolve({ providerId: "newapi", model: "ultra-row", reasoningLevel: "ultra" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RelaySelectionError);
      expect((error as RelaySelectionError).code).toBe("reasoning_level_unknown");
      expect((error as RelaySelectionError).message).toContain("responses-effort mapping");
    }
  });

  test("a keyless responses row fails dispatch with the named credential error", () => {
    const registry = RelayProviderRegistry.fromEnv({
      MODEL_RELAY_CATALOG: RESPONSES_CATALOG,
      MODEL_RELAY_MODEL: "glm-5.3-flash",
    });
    expect(() => registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" })).toThrow(
      /newapi.*no usable credential/s,
    );
  });
});

describe("#363 openai-completions dispatch", () => {
  const COMPLETIONS_CATALOG = JSON.stringify({
    defaultProvider: "newapi",
    providers: {
      newapi: {
        displayName: "newapi",
        api: "openai-completions",
        models: [
          {
            id: "glm-5.3-flash",
            reasoningLevels: ["none", "low", "high"],
            defaultReasoningLevel: "none",
            contextWindow: 200_000,
            maxTokens: 8192,
          },
          {
            id: "deepseek-v4-pro",
            reasoningLevels: ["none", "high", "xhigh"],
            reasoningEffortMap: { xhigh: "max" },
          },
          {
            id: "ultra-row",
            reasoningLevels: ["none", "ultra"],
            defaultReasoningLevel: "none",
          },
        ],
      },
    },
  });

  const ENV = {
    MODEL_RELAY_CATALOG: COMPLETIONS_CATALOG,
    MODEL_RELAY_MODEL: "glm-5.3-flash",
    MODEL_RELAY_API_KEY: "k-deployment",
    MODEL_RELAY_BASE_URL_ANTHROPIC: "https://unused-anthropic.example/api",
    MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096",
  };

  test("a catalog api: openai-completions row dispatches the CompletionsRelayProvider", () => {
    const registry = RelayProviderRegistry.fromEnv(ENV);
    const provider = registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" });
    expect(provider).toBeInstanceOf(CompletionsRelayProvider);
  });

  test("the resolved config carries the face and the rung-mapped effort (per-model map wins)", () => {
    const registry = RelayProviderRegistry.fromEnv(ENV);
    const flash = registry.resolve({
      providerId: "newapi",
      model: "glm-5.3-flash",
      reasoningLevel: "high",
    });
    expect(flash.config.api).toBe("openai-completions");
    expect(flash.config.reasoningEffort).toBe("high");
    const deepseek = registry.resolve({
      providerId: "newapi",
      model: "deepseek-v4-pro",
      reasoningLevel: "xhigh",
    });
    expect(deepseek.config.reasoningEffort).toBe("max");
  });

  test("an effort-unmappable rung on a completions row fails closed with the named 422", () => {
    const registry = RelayProviderRegistry.fromEnv(ENV);
    try {
      registry.resolve({ providerId: "newapi", model: "ultra-row", reasoningLevel: "ultra" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RelaySelectionError);
      expect((error as RelaySelectionError).code).toBe("reasoning_level_unknown");
      expect((error as RelaySelectionError).message).toContain("responses-effort mapping");
    }
  });

  test("a keyless completions row fails dispatch with the named credential error", () => {
    const registry = RelayProviderRegistry.fromEnv({
      MODEL_RELAY_CATALOG: COMPLETIONS_CATALOG,
      MODEL_RELAY_MODEL: "glm-5.3-flash",
    });
    expect(() => registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" })).toThrow(
      /newapi.*no usable credential/s,
    );
  });
});
