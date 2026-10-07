import { describe, expect, test } from "vitest";
import {
  RelaySelectionError,
  AnthropicRelayProvider,
  CompletionsRelayProvider,
  ResponsesRelayProvider,
} from "@cap/agent-do";
import {
  EMPTY_PROVIDER_OVERLAY,
  RelayProviderRegistry,
  relayAgentRuntime,
  type RelayProviderOverlay,
} from "../src/relay-registry.js";

/**
 * #351/#450 relay provider registry: the providerId-keyed dispatch half of
 * the catalog layer. Since #450 the construction is D1-only — the overlay
 * (the decoded provider_configs rows) is the ENTIRE directory and the ONLY
 * credential source: every row is standalone (a user-authored baseUrl is
 * never hit with a deployment key), so a keyless row fails dispatch with the
 * named credential error (#434 point ⑦ — no row-level mock). Two threads
 * selecting two models resolve two DISTINCT RelayConfigs; unknown selections
 * throw RelaySelectionError — the fail-closed red line.
 */

const DEPLOYMENT_ENV = {
  MODEL_RELAY_MODEL: "glm-5.3",
  MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096",
  MODEL_RELAY_IMAGE_INPUT: "1",
  // Deployment channel scalars exist for the default provider only; rows
  // NEVER read them (#450 standalone posture — the leak-vector tests below).
  MODEL_RELAY_API_KEY: "k-deployment",
  MODEL_RELAY_BASE_URL_ANTHROPIC: "https://main.example.com/api/anthropic",
};

const OVERLAY: RelayProviderOverlay = {
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
  imageSourceProviderId: null,
  credentials: {
    main: { apiKey: "k-main", baseUrl: "https://main.example.com/api/anthropic" },
    backup: { apiKey: "k-backup", baseUrl: "https://backup.example.com/api/anthropic" },
  },
};

describe("#351 RelayProviderRegistry resolution over the D1 overlay", () => {
  test("two selected models resolve two distinct wire configs", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, OVERLAY);
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
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, OVERLAY);
    const off = registry.resolve({ providerId: "main", model: "glm-5.3", reasoningLevel: "none" });
    const on = registry.resolve({ providerId: "main", model: "glm-5.3", reasoningLevel: "high" });
    expect(off.config.thinking).toEqual({ type: "disabled" });
    expect(on.config.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  test("non-running rows read their declaration; the running row keeps the harness fold", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, OVERLAY);
    // MODEL_RELAY_MODEL is glm-5.3 → the running row carries the harness
    // fold (env overrides and defaults already applied).
    const running = registry.resolve({ providerId: "main", model: "glm-5.3" });
    expect(running.modelId).toBe("glm-5.3");
    expect(running.config.supportsImageInput).toBe(true);
    // The sibling row declares no image input — capability stays per-row.
    const sibling = registry.resolve({ providerId: "main", model: "glm-5.3-air" });
    expect(sibling.config.supportsImageInput).toBe(false);
    expect(sibling.config.maxTokens).toBe(4096);
    // The deployment budget scalar folds onto rows without their own budget
    // seat (#362: undefined = legacy row that keeps the harness fold).
    expect(sibling.config.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  test("unknown provider/model/reasoning fail closed with named errors", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, OVERLAY);
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

  test("the zero-config overlay admits nothing (#434 fail-closed)", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV);
    // No selection and no D1 default declaration (#450: rows never declare
    // one) → the named undeclared-default 422.
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

  test("no explicit selection fails closed — D1 rows declare no default (#434)", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, OVERLAY);
    // #434/#450: no first-key fill and no declaration seat — a selectionless
    // resolve is the named 422, never a guessed provider.
    try {
      registry.resolve({});
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("provider_default_undeclared");
    }
  });
});

describe("#351/#450 standalone credentials (D1 rows never ride deployment slots)", () => {
  test("a row resolves with its OWN wire identity, never the deployment scalars", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, OVERLAY);
    const main = registry.resolve({ providerId: "main", model: "glm-5.3" });
    expect(main.config.apiKey).toBe("k-main");
    expect(main.config.baseUrl).toBe("https://main.example.com/api/anthropic");
    const backup = registry.resolve({ providerId: "backup", model: "flash-mini" });
    expect(backup.config.apiKey).toBe("k-backup");
    expect(backup.config.baseUrl).toBe("https://backup.example.com/api/anthropic");
  });

  test("a row whose credential slot is empty degrades to empty slots — never the deployment key", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, {
      ...OVERLAY,
      credentials: {},
    });
    // No credential slot at all → both wire slots resolve empty (the baseUrl
    // declaration half supplies the base ONLY when the row declares one).
    const resolved = registry.resolve({ providerId: "backup", model: "flash-mini" });
    expect(resolved.config.apiKey).toBe("");
    expect(resolved.config.baseUrl).toBe("");
    // #434 point ⑦: no row-level mock. resolve() still answers (the config
    // slots are honestly empty), but dispatch refuses to fabricate a client.
    expect(() => registry.providerFor({ providerId: "backup", model: "flash-mini" })).toThrow(
      /backup.*\(flash-mini\) has no usable credential.*lacks a usable key\/baseUrl; set the row's apiKey\/baseUrl in the panel \(fail-closed, #434\)/s,
    );
  });

  test("providerFor caches one instance per provider+model+rung", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, OVERLAY);
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

  test("applyOverlay clears the instance cache — stale wire clients never survive a rotation", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, OVERLAY);
    const first = registry.providerFor({ providerId: "backup", model: "flash-mini" });
    registry.applyOverlay({
      ...OVERLAY,
      credentials: {
        ...OVERLAY.credentials,
        backup: { apiKey: "k-rotated", baseUrl: "https://backup.example.com/api/anthropic" },
      },
    });
    const second = registry.providerFor({ providerId: "backup", model: "flash-mini" });
    expect(second).not.toBe(first);
    expect(registry.resolve({ providerId: "backup", model: "flash-mini" }).config.apiKey).toBe(
      "k-rotated",
    );
  });

  test("relayAgentRuntime installs the registry resolver (the one registration shape)", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, OVERLAY);
    const runtime = relayAgentRuntime(registry);
    expect(typeof runtime.resolveExecutionProvider).toBe("function");
    const resolved = runtime.resolveExecutionProvider({
      providerId: "backup",
      model: "flash-mini",
    });
    expect(resolved).toBeInstanceOf(AnthropicRelayProvider);
    // #496: the runtime carries no materializer — the DO never maps a
    // legacy selection; threads pin explicit rows or fail closed.
    expect("materializeLegacySelection" in runtime).toBe(false);
    // The empty overlay is the honest zero-config construction the composed
    // worker boots with before the awaited D1 hot-apply.
    expect(EMPTY_PROVIDER_OVERLAY.providers).toEqual({});
    expect(EMPTY_PROVIDER_OVERLAY.imageSourceProviderId).toBeNull();
    expect(EMPTY_PROVIDER_OVERLAY.credentials).toEqual({});
  });
});

describe("#361 openai-responses dispatch", () => {
  const RESPONSES_OVERLAY: RelayProviderOverlay = {
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
    imageSourceProviderId: null,
    credentials: { newapi: { apiKey: "k-newapi" } },
  };

  test("a catalog api: openai-responses row dispatches the ResponsesRelayProvider", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, RESPONSES_OVERLAY);
    const provider = registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" });
    expect(provider).toBeInstanceOf(ResponsesRelayProvider);
  });

  test("the resolved config carries the face, base, and the rung-mapped effort", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, RESPONSES_OVERLAY);
    const resolution = registry.resolve({
      providerId: "newapi",
      model: "glm-5.3-flash",
      reasoningLevel: "high",
    });
    expect(resolution.config.api).toBe("openai-responses");
    // The credential slot carries the key; the declaration carries the base
    // (the slot omitted baseUrl → the row's public declaration supplies it).
    expect(resolution.config.apiKey).toBe("k-newapi");
    expect(resolution.config.baseUrl).toBe("https://newapi.samuka007.top/v1");
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
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, RESPONSES_OVERLAY);
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
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, {
      ...RESPONSES_OVERLAY,
      credentials: {},
    });
    expect(() => registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" })).toThrow(
      /newapi.*no usable credential.*fail-closed, #434/s,
    );
  });
});

describe("#363 openai-completions dispatch", () => {
  const COMPLETIONS_OVERLAY: RelayProviderOverlay = {
    providers: {
      newapi: {
        displayName: "newapi",
        baseUrl: "https://newapi.samuka007.top/v1",
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
    imageSourceProviderId: null,
    credentials: { newapi: { apiKey: "k-newapi" } },
  };

  test("a catalog api: openai-completions row dispatches the CompletionsRelayProvider", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, COMPLETIONS_OVERLAY);
    const provider = registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" });
    expect(provider).toBeInstanceOf(CompletionsRelayProvider);
  });

  test("the resolved config carries the face and the rung-mapped effort (per-model map wins)", () => {
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, COMPLETIONS_OVERLAY);
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
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, COMPLETIONS_OVERLAY);
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
    const registry = RelayProviderRegistry.create(DEPLOYMENT_ENV, {
      ...COMPLETIONS_OVERLAY,
      credentials: {},
    });
    expect(() => registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" })).toThrow(
      /newapi.*no usable credential.*fail-closed, #434/s,
    );
  });
});
