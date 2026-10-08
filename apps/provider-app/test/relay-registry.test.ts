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
import {
  RELAY_FALLBACK_CONTEXT_WINDOW,
  RELAY_FALLBACK_MAX_TOKENS,
} from "../src/execution-posture.js";

/**
 * #351/#450/#500/#534 relay provider registry: the providerId-keyed dispatch
 * half of the catalog layer. Since #450 the construction is D1-only — the
 * overlay (the decoded provider_configs rows) is the ENTIRE directory and
 * the ONLY credential source: every row is standalone (a user-authored
 * baseUrl is never hit with a deployment key), so a keyless row fails
 * dispatch with the named credential error (#434 point ⑦ — no row-level
 * mock). #500: no deployment env takes part at all. #534: the wire thinking
 * rides the row's pi transports — the rung picks disabled / budget (the
 * row's effortBudgets, else the named default ladder) / adaptive
 * (+ output_config.effort), and the wire model id honors
 * thinking.effortRouting. Unknown selections throw RelaySelectionError —
 * the fail-closed red line.
 */

const OVERLAY: RelayProviderOverlay = {
  providers: {
    main: {
      displayName: "Main relay",
      models: [
        {
          id: "glm-5.3",
          name: "GLM-5.3",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 200_000,
          maxTokens: 8192,
          thinking: {
            mode: "budget",
            efforts: ["low", "high"],
            defaultLevel: "high",
            effortBudgets: { high: 4096 },
          },
        },
        { id: "glm-5.3-air", name: "GLM-5.3-Air", maxTokens: 4096 },
      ],
    },
    backup: {
      models: [
        {
          id: "flash-mini",
          reasoning: true,
          contextWindow: 128_000,
          maxTokens: 2048,
          // No effortBudgets entry for "medium" — the named default ladder
          // serves the wire budget (RELAY_ANTHROPIC_BUDGET_BY_EFFORT).
          thinking: { mode: "budget", efforts: ["medium"] },
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
    const registry = RelayProviderRegistry.create(OVERLAY);
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
    // #534: the row's declared effortBudgets is the wire budget; an
    // undeclared rung rides the named default ladder.
    expect(main.config.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(backup.config.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  test("the none rung dispatches thinking disabled on the same row", () => {
    const registry = RelayProviderRegistry.create(OVERLAY);
    const off = registry.resolve({ providerId: "main", model: "glm-5.3", reasoningLevel: "none" });
    const on = registry.resolve({ providerId: "main", model: "glm-5.3", reasoningLevel: "high" });
    expect(off.config.thinking).toEqual({ type: "disabled" });
    expect(on.config.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  test("#500: every row carries its own declaration — no deployment fold", () => {
    const registry = RelayProviderRegistry.create(OVERLAY);
    const flagship = registry.resolve({ providerId: "main", model: "glm-5.3" });
    expect(flagship.modelId).toBe("glm-5.3");
    expect(flagship.config.supportsImageInput).toBe(true);
    // The sibling row declares no thinking seat — the ladder is exactly
    // [none], and the maxTokens window comes from the row itself, never a
    // deployment fold.
    const sibling = registry.resolve({ providerId: "main", model: "glm-5.3-air" });
    expect(sibling.config.supportsImageInput).toBe(false);
    expect(sibling.config.maxTokens).toBe(4096);
    expect(sibling.config.thinking).toEqual({ type: "disabled" });
    // A capability-less row has exactly one runnable rung — asking for
    // another fails closed with the named 422 (display and dispatch agree).
    try {
      registry.resolve({ providerId: "main", model: "glm-5.3-air", reasoningLevel: "high" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RelaySelectionError);
      expect((error as RelaySelectionError).code).toBe("reasoning_level_unknown");
    }
  });

  test("#500: rows that declare no window/thinking fall back to the wire-safety constants", () => {
    const registry = RelayProviderRegistry.create({
      providers: { bare: { models: [{ id: "bare-model" }] } },
      imageSourceProviderId: null,
      credentials: {},
    });
    const resolved = registry.resolve({ providerId: "bare", model: "bare-model" });
    expect(resolved.config.maxTokens).toBe(RELAY_FALLBACK_MAX_TOKENS);
    expect(resolved.config.contextWindow).toBe(RELAY_FALLBACK_CONTEXT_WINDOW);
    expect(resolved.config.thinking).toEqual({ type: "disabled" });
    expect(resolved.config.supportsImageInput).toBe(false);
  });

  test("unknown provider/model/reasoning fail closed with named errors", () => {
    const registry = RelayProviderRegistry.create(OVERLAY);
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
    // "ultra" is not a pi effort — a row ladder can never offer it, so the
    // rung is outside every runnable ladder (the named 422).
    try {
      registry.resolve({ providerId: "backup", model: "flash-mini", reasoningLevel: "ultra" });
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("reasoning_level_unknown");
      expect((error as RelaySelectionError).message).toContain("runnable ladder");
    }
    // #500: no deployment model is named — a provider-only selection has no
    // default to fall to; pass the model explicitly (named 422).
    try {
      registry.resolve({ providerId: "main" });
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("model_unknown");
      expect((error as RelaySelectionError).message).toContain("pass model explicitly");
    }
  });

  test("the zero-config overlay admits nothing (#434 fail-closed)", () => {
    const registry = RelayProviderRegistry.create();
    // No selection and no D1 default declaration (#450: rows never declare
    // one) → the named undeclared-default 422.
    expect(() => registry.resolve({})).toThrow(/names no defaultProvider/);
    // Any unknown provider id fails closed (#508: the sentinel is purged and
    // nothing re-reserves the vocabulary).
    try {
      registry.resolve({ providerId: "ghost-relay" });
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
    const registry = RelayProviderRegistry.create(OVERLAY);
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
  test("a row resolves with its OWN wire identity, never a deployment slot", () => {
    const registry = RelayProviderRegistry.create(OVERLAY);
    const main = registry.resolve({ providerId: "main", model: "glm-5.3" });
    expect(main.config.apiKey).toBe("k-main");
    expect(main.config.baseUrl).toBe("https://main.example.com/api/anthropic");
    const backup = registry.resolve({ providerId: "backup", model: "flash-mini" });
    expect(backup.config.apiKey).toBe("k-backup");
    expect(backup.config.baseUrl).toBe("https://backup.example.com/api/anthropic");
  });

  test("a row whose credential slot is empty degrades to empty slots — never a deployment key", () => {
    const registry = RelayProviderRegistry.create({
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
    const registry = RelayProviderRegistry.create(OVERLAY);
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
    const registry = RelayProviderRegistry.create(OVERLAY);
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
    const registry = RelayProviderRegistry.create(OVERLAY);
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

describe("#534 the pi transports on the anthropic face", () => {
  test("adaptive rows dispatch thinking:adaptive + output_config.effort (the pi mapper)", () => {
    const registry = RelayProviderRegistry.create({
      providers: {
        official: {
          models: [
            {
              id: "claude-opus-4-7",
              reasoning: true,
              thinking: {
                mode: "anthropic-adaptive",
                efforts: ["low", "high", "max"],
                defaultLevel: "high",
              },
            },
          ],
        },
      },
      imageSourceProviderId: null,
      credentials: {
        official: { apiKey: "k", baseUrl: "https://api.anthropic.example.com" },
      },
    });
    const resolution = registry.resolve({
      providerId: "official",
      model: "claude-opus-4-7",
      reasoningLevel: "max",
    });
    expect(resolution.config.thinking).toEqual({ type: "adaptive" });
    expect(resolution.config.outputConfig).toEqual({ effort: "max" });
    // The off rung carries no effort seat at all (explicit disabled only).
    const off = registry.resolve({
      providerId: "official",
      model: "claude-opus-4-7",
      reasoningLevel: "none",
    });
    expect(off.config.thinking).toEqual({ type: "disabled" });
    expect(off.config.outputConfig).toBeUndefined();
  });

  test("anthropic-budget-effort rows send the budget AND the mapped effort", () => {
    const registry = RelayProviderRegistry.create({
      providers: {
        zai: {
          models: [
            {
              id: "glm-5.3",
              reasoning: true,
              thinking: {
                mode: "anthropic-budget-effort",
                efforts: ["low", "high", "max"],
                defaultLevel: "max",
                requiresEffort: true,
                effortMap: { max: "xhigh" },
              },
            },
          ],
        },
      },
      imageSourceProviderId: null,
      credentials: { zai: { apiKey: "k", baseUrl: "https://open.bigmodel.cn/api/anthropic" } },
    });
    const resolution = registry.resolve({
      providerId: "zai",
      model: "glm-5.3",
      reasoningLevel: "max",
    });
    // Budget from the default ladder (no effortBudgets), effort through the
    // row's effortMap (max → xhigh).
    expect(resolution.config.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(resolution.config.outputConfig).toEqual({ effort: "xhigh" });
  });

  test("effortRouting routes the upstream wire id per rung", () => {
    const registry = RelayProviderRegistry.create({
      providers: {
        collapsed: {
          models: [
            {
              id: "gemini-3-flash",
              reasoning: true,
              thinking: {
                mode: "google-level",
                efforts: ["low", "high"],
                effortRouting: { low: "gemini-3-flash-low", high: "gemini-3-flash", off: "gemini-3-flash" },
              },
            },
          ],
        },
      },
      imageSourceProviderId: null,
      credentials: { collapsed: { apiKey: "k", baseUrl: "https://cca.example.com" } },
    });
    const low = registry.resolve({ providerId: "collapsed", model: "gemini-3-flash", reasoningLevel: "low" });
    expect(low.config.model).toBe("gemini-3-flash-low");
    const high = registry.resolve({ providerId: "collapsed", model: "gemini-3-flash", reasoningLevel: "high" });
    expect(high.config.model).toBe("gemini-3-flash");
    const off = registry.resolve({ providerId: "collapsed", model: "gemini-3-flash", reasoningLevel: "none" });
    expect(off.config.model).toBe("gemini-3-flash");
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
            reasoning: true,
            contextWindow: 200_000,
            maxTokens: 8192,
            thinking: { mode: "effort", efforts: ["low", "high", "xhigh"] },
          },
          // Per-model remap: the pi effortMap (omp models.yml compat
          // .reasoningEffortMap deepseek anchor).
          {
            id: "deepseek-v4-pro",
            api: "openai-responses",
            reasoning: true,
            thinking: { mode: "effort", efforts: ["high", "xhigh"], effortMap: { xhigh: "max" } },
          },
        ],
      },
    },
    imageSourceProviderId: null,
    credentials: { newapi: { apiKey: "k-newapi" } },
  };

  test("a catalog api: openai-responses row dispatches the ResponsesRelayProvider", () => {
    const registry = RelayProviderRegistry.create(RESPONSES_OVERLAY);
    const provider = registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" });
    expect(provider).toBeInstanceOf(ResponsesRelayProvider);
  });

  test("the resolved config carries the face, base, and the rung-mapped effort", () => {
    const registry = RelayProviderRegistry.create(RESPONSES_OVERLAY);
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

  test("a keyless responses row fails dispatch with the named credential error", () => {
    const registry = RelayProviderRegistry.create({
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
            reasoning: true,
            contextWindow: 200_000,
            maxTokens: 8192,
            thinking: { mode: "effort", efforts: ["low", "high"] },
          },
          {
            id: "deepseek-v4-pro",
            reasoning: true,
            thinking: { mode: "effort", efforts: ["high", "xhigh"], effortMap: { xhigh: "max" } },
          },
        ],
      },
    },
    imageSourceProviderId: null,
    credentials: { newapi: { apiKey: "k-newapi" } },
  };

  test("a catalog api: openai-completions row dispatches the CompletionsRelayProvider", () => {
    const registry = RelayProviderRegistry.create(COMPLETIONS_OVERLAY);
    const provider = registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" });
    expect(provider).toBeInstanceOf(CompletionsRelayProvider);
  });

  test("the resolved config carries the face and the rung-mapped effort (per-model map wins)", () => {
    const registry = RelayProviderRegistry.create(COMPLETIONS_OVERLAY);
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

  test("a keyless completions row fails dispatch with the named credential error", () => {
    const registry = RelayProviderRegistry.create({
      ...COMPLETIONS_OVERLAY,
      credentials: {},
    });
    expect(() => registry.providerFor({ providerId: "newapi", model: "glm-5.3-flash" })).toThrow(
      /newapi.*no usable credential.*fail-closed, #434/s,
    );
  });
});
