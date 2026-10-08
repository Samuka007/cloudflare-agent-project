import { describe, expect, test } from "vitest";
import {
  decodeRelayCatalog,
  findRelayCatalogModel,
  isImageGenerationModelId,
  isImageSourceProvider,
  relayApiConsumesEffortMap,
  relayCatalogProviderSchema,
  relayCatalogSchema,
  relayModelEntrySchema,
  relayReasoningLadder,
  relayResponsesWireEffort,
  relayAnthropicThinking,
  relayWireModelId,
  RELAY_ANTHROPIC_BUDGET_BY_EFFORT,
  resolveRelaySelection,
  RelaySelectionError,
  type RelaySelectionDirectory,
} from "../src/provider-catalog.js";

/**
 * #350 relay catalog declaration — L1 over the shared model-entry field
 * dictionary, the strict decode semantics (loud rejection, never silent
 * under-declaration), and the row lookup order. #534: the reasoning domain
 * is the pi-catalog 正本 — the row shape is `reasoning: boolean` +
 * `thinking?: { mode, efforts, … }`, the ladder is pi's capability gate, and
 * the retired thinkingBudgetTokens seat survives ONLY as the compat-read
 * fold (存量行迁移钉). #523 deleted the dictionary's last second consumer
 * (the daemon-side model registry), leaving the edge catalog as the schema's
 * only consumer — these tests pin the vocabulary itself.
 */

const FULL_CATALOG = {
  defaultProvider: "main",
  providers: {
    main: {
      displayName: "Main relay",
      baseUrl: "https://relay.example/anthropic",
      api: "anthropic-messages",
      serviceTier: true,
      models: [
        {
          id: "glm-5.3",
          name: "GLM-5.3",
          api: "anthropic-messages",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200_000,
          maxTokens: 8192,
          cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
          description: "Flagship reasoning model",
          // The pi shape (models.dev zhipu-coding-plan glm-5.3 anchor).
          thinking: {
            mode: "anthropic-budget-effort",
            efforts: ["low", "high", "max"],
            defaultLevel: "max",
            requiresEffort: true,
          },
        },
        { id: "glm-5.3-air", name: "GLM-5.3-Air" },
      ],
    },
    backup: { models: [{ id: "glm-5.3-flash" }] },
  },
};

describe("#350 MODEL_RELAY_CATALOG schema", () => {
  test("absent/blank env decodes to null — unset means ruled defaults", () => {
    expect(decodeRelayCatalog(undefined)).toBeNull();
    expect(decodeRelayCatalog("")).toBeNull();
    expect(decodeRelayCatalog("   ")).toBeNull();
  });

  test("accepts the full declaration shape (dictionary + pi thinking)", () => {
    const catalog = decodeRelayCatalog(JSON.stringify(FULL_CATALOG));
    expect(catalog).not.toBeNull();
    expect(catalog?.defaultProvider).toBe("main");
    const main = catalog?.providers.main;
    if (main === undefined || isImageSourceProvider(main)) throw new Error("expected chat branch");
    expect(main.models[0]?.input).toEqual(["text", "image"]);
    expect(main.models[0]?.cost?.cacheWrite).toBe(0);
    expect(main.models[0]?.thinking).toEqual({
      mode: "anthropic-budget-effort",
      efforts: ["low", "high", "max"],
      defaultLevel: "max",
      requiresEffort: true,
    });
    expect(catalog?.providers.backup?.models).toHaveLength(1);
  });

  test("strict decode rejects misspelled declared fields loudly", () => {
    // A stripped typo would silently under-declare capability — the disease
    // this layer treats. Unknown keys fail the deployment instead.
    const typo = JSON.stringify({
      providers: { omp: { models: [{ id: "glm-5.3", contextwindow: 200000 }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(typo))).toThrow();
    const topTypo = JSON.stringify({
      defaultprovider: "omp",
      providers: { omp: { models: [{ id: "glm-5.3" }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(topTypo))).toThrow();
    // The retired seats are DECLARED compat input — they fold, never fail.
    const legacy = relayCatalogSchema.parse({
      providers: { omp: { models: [{ id: "m", reasoningLevels: ["none", "high"] }] } },
    });
    const legacyOmp = legacy.providers.omp;
    if (legacyOmp === undefined || isImageSourceProvider(legacyOmp)) throw new Error("chat branch");
    expect(legacyOmp.models[0]?.thinking).toEqual({
      mode: "budget",
      efforts: ["high"],
      defaultLevel: "high",
    });
  });

  test("rejects empty providers, empty model rows, and a dangling defaultProvider", () => {
    expect(() => relayCatalogSchema.parse({ providers: {} })).toThrow();
    expect(() => relayCatalogSchema.parse({ providers: { omp: { models: [] } } })).toThrow();
    expect(() =>
      relayCatalogSchema.parse({
        defaultProvider: "missing",
        providers: { omp: { models: [{ id: "glm-5.3" }] } },
      }),
    ).toThrow();
  });

  test("rejects out-of-vocabulary efforts, modes, and a dangling defaultLevel", () => {
    const badEffort = JSON.stringify({
      providers: { omp: { models: [{ id: "m", thinking: { mode: "budget", efforts: ["megahigh"] } }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(badEffort))).toThrow();
    // `minimal` has no bb rung — the edge refuses it (the importer warns).
    const minimal = JSON.stringify({
      providers: { omp: { models: [{ id: "m", thinking: { mode: "effort", efforts: ["minimal"] } }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(minimal))).toThrow();
    const badMode = JSON.stringify({
      providers: { omp: { models: [{ id: "m", thinking: { mode: "turbo", efforts: ["low"] } }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(badMode))).toThrow();
    const danglingDefault = JSON.stringify({
      providers: {
        omp: {
          models: [{ id: "m", thinking: { mode: "budget", efforts: ["low"], defaultLevel: "max" } }],
        },
      },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(danglingDefault))).toThrow();
  });

  test("rejects non-positive windows and negative cost rates", () => {
    const zeroWindow = JSON.stringify({
      providers: { omp: { models: [{ id: "m", contextWindow: 0 }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(zeroWindow))).toThrow();
    const negativeCost = JSON.stringify({
      providers: {
        omp: { models: [{ id: "m", cost: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } }] },
      },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(negativeCost))).toThrow();
  });

  test("a credential field has no seat in the public ledger", () => {
    // Secrets stay in env/secret slots (#255 ruling C): an apiKey attempt
    // fails the strict decode instead of being stripped into the projection.
    const withKey = JSON.stringify({
      providers: { omp: { apiKey: "sk-secret", models: [{ id: "glm-5.3" }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(withKey))).toThrow();
    const modelKey = JSON.stringify({
      providers: { omp: { models: [{ id: "glm-5.3", apiKey: "sk-secret" }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(modelKey))).toThrow();
  });

  test("the dictionary is the omp models.yml model vocabulary + the pi thinking seat", () => {
    // Field-set pin at the schema level: the shared dictionary keeps the omp
    // models.yml field set (id/name/api/reasoning/input/contextWindow/
    // maxTokens/cost) plus #534's pi thinking seat.
    const keys = Object.keys(relayModelEntrySchema.shape).sort();
    expect(keys).toEqual(
      [
        "api",
        "contextWindow",
        "cost",
        "id",
        "input",
        "maxTokens",
        "name",
        "reasoning",
        "thinking",
      ].sort(),
    );
  });
});

describe("#534 the pi ladder gate (relayReasoningLadder)", () => {
  test("no capability seats → exactly [none]", () => {
    expect(relayReasoningLadder({})).toEqual({ levels: ["none"], defaultLevel: "none" });
    // reasoning bit without a controllable surface (pi: thinking undefined)
    // still gates off — unknown is not a ladder.
    expect(relayReasoningLadder({ reasoning: true })).toEqual({
      levels: ["none"],
      defaultLevel: "none",
    });
  });

  test("gate on → [none, ...efforts] with the declared defaultLevel", () => {
    // The glm anchor: [low,high,max] + default in the ladder (max).
    expect(
      relayReasoningLadder({
        reasoning: true,
        thinking: { mode: "effort", efforts: ["low", "high", "max"], defaultLevel: "max" },
      }),
    ).toEqual({ levels: ["none", "low", "high", "max"], defaultLevel: "max" });
  });

  test("no declared defaultLevel → pi defaultSupportedEffort (the lowest effort)", () => {
    expect(
      relayReasoningLadder({ reasoning: true, thinking: { mode: "budget", efforts: ["medium", "max"] } }),
    ).toEqual({ levels: ["none", "medium", "max"], defaultLevel: "medium" });
  });

  test("the budget number is NOT a gate: declared efforts run regardless of effortBudgets", () => {
    const withBudgets = relayReasoningLadder({
      reasoning: true,
      thinking: { mode: "budget", efforts: ["low", "max"], effortBudgets: { low: 4096 } },
    });
    const withoutBudgets = relayReasoningLadder({
      reasoning: true,
      thinking: { mode: "budget", efforts: ["low", "max"] },
    });
    expect(withBudgets).toEqual(withoutBudgets);
  });
});

describe("#534 the wire folds", () => {
  test("relayResponsesWireEffort: identity for ladder rungs, the row's effortMap wins", () => {
    expect(relayResponsesWireEffort("none")).toBe("none");
    expect(relayResponsesWireEffort("high")).toBe("high");
    expect(
      relayResponsesWireEffort("xhigh", { mode: "effort", efforts: ["xhigh"], effortMap: { xhigh: "max" } }),
    ).toBe("max");
  });

  test("relayAnthropicThinking: rung none → explicit disabled; budget rows ride effortBudgets", () => {
    const row = {
      reasoning: true,
      thinking: {
        mode: "budget",
        efforts: ["low", "high", "max"],
        defaultLevel: "max",
        effortBudgets: { max: 65536 },
      },
    } as const;
    expect(relayAnthropicThinking(row, "none").thinking).toEqual({ type: "disabled" });
    expect(relayAnthropicThinking(row, "max")).toEqual({
      thinking: { type: "enabled", budget_tokens: 65536 },
    });
    // An undeclared rung rides the named default ladder (pi-ai anchor).
    expect(relayAnthropicThinking(row, "low")).toEqual({
      thinking: { type: "enabled", budget_tokens: RELAY_ANTHROPIC_BUDGET_BY_EFFORT.low },
    });
  });

  test("relayAnthropicThinking: adaptive rows map the effort through the pi 正本", () => {
    const adaptive = {
      reasoning: true,
      thinking: {
        mode: "anthropic-adaptive" as const,
        efforts: ["low", "max"] as const,
        defaultLevel: "high" as const,
      },
    };
    expect(relayAnthropicThinking(adaptive, "max")).toEqual({
      thinking: { type: "adaptive" },
      outputConfig: { effort: "max" },
    });
    // budget-effort: the budget AND the mapped effort ride together.
    const budgetEffort = {
      reasoning: true,
      thinking: {
        mode: "anthropic-budget-effort" as const,
        efforts: ["high", "max"] as const,
        effortMap: { max: "xhigh" } as const,
      },
    };
    expect(relayAnthropicThinking(budgetEffort, "max")).toEqual({
      thinking: { type: "enabled", budget_tokens: RELAY_ANTHROPIC_BUDGET_BY_EFFORT.max },
      outputConfig: { effort: "xhigh" },
    });
  });

  test("relayWireModelId: effortRouting routes per rung (off included), else the row id", () => {
    const routed = {
      id: "gemini-3-flash",
      reasoning: true,
      thinking: {
        mode: "google-level" as const,
        efforts: ["low", "high"] as const,
        effortRouting: {
          low: "gemini-3-flash-low",
          high: "gemini-3-flash",
          off: "gemini-3-flash",
        } as const,
      },
    };
    expect(relayWireModelId(routed, "low")).toBe("gemini-3-flash-low");
    expect(relayWireModelId(routed, "high")).toBe("gemini-3-flash");
    expect(relayWireModelId(routed, "none")).toBe("gemini-3-flash");
    expect(relayWireModelId({ id: "glm-5.3" }, "high")).toBe("glm-5.3");
  });
});

describe("#350 findRelayCatalogModel", () => {
  test("prefers the default provider, then declaration order", () => {
    const catalog = decodeRelayCatalog(JSON.stringify(FULL_CATALOG));
    expect(catalog).not.toBeNull();
    if (catalog === null) throw new Error("unreachable");
    expect(findRelayCatalogModel(catalog, "glm-5.3")).toEqual({
      providerId: "main",
      model: FULL_CATALOG.providers.main.models[0],
    });
    expect(findRelayCatalogModel(catalog, "glm-5.3-flash")?.providerId).toBe("backup");
    expect(findRelayCatalogModel(catalog, "unknown")).toBeUndefined();
  });

  test("locate result exposes the provider id for the #361 api fold", () => {
    const catalog = decodeRelayCatalog(JSON.stringify(FULL_CATALOG));
    if (catalog === null) throw new Error("unreachable");
    const located = findRelayCatalogModel(catalog, "glm-5.3-flash");
    expect(located?.providerId).toBe("backup");
    expect(located?.model.api).toBeUndefined();
  });
});

describe("#361 relay api face", () => {
  test("the edge catalog validates api against the relay-speakable enum", () => {
    // The shared model dictionary stays free-form (daemon parity with omp's
    // api families); the EDGE face only accepts what the relay dials.
    const freeForm = relayModelEntrySchema.safeParse({ id: "m", api: "openai-completions" });
    expect(freeForm.success).toBe(true);
    const speakable = JSON.stringify({
      providers: { omp: { api: "openai-completions", models: [{ id: "m" }] } },
    });
    const parsed = relayCatalogSchema.parse(JSON.parse(speakable));
    const omp = parsed.providers.omp;
    if (omp === undefined || isImageSourceProvider(omp)) throw new Error("chat branch");
    expect(omp.api).toBe("openai-completions");
    const modelLevel = JSON.stringify({
      providers: { omp: { models: [{ id: "m", api: "google-generative-ai" }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(modelLevel))).toThrow();
  });

  test("#363 relayApiConsumesEffortMap: both openai faces fold, anthropic does not", () => {
    expect(relayApiConsumesEffortMap("openai-responses")).toBe(true);
    expect(relayApiConsumesEffortMap("openai-completions")).toBe(true);
    expect(relayApiConsumesEffortMap("anthropic-messages")).toBe(false);
  });
});

describe("#351 selection resolution over the pi directory", () => {
  const directory: RelaySelectionDirectory = {
    rows: [
      {
        providerId: "main",
        id: "glm-5.3",
        reasoning: true,
        reasoningLevels: ["none", "low", "high", "max"],
        defaultReasoningLevel: "max",
      },
      {
        providerId: "main",
        id: "off-row",
        reasoning: false,
        reasoningLevels: ["none"],
        defaultReasoningLevel: "none",
      },
    ],
    defaultProviderId: "main",
    defaultModelId: "glm-5.3",
  };

  test("a declared rung resolves; the default fills an absent rung", () => {
    expect(resolveRelaySelection(directory, { model: "glm-5.3" })).toEqual({
      providerId: "main",
      modelId: "glm-5.3",
      reasoningLevel: "max",
    });
    expect(
      resolveRelaySelection(directory, { model: "glm-5.3", reasoningLevel: "high" }),
    ).toMatchObject({ reasoningLevel: "high" });
  });

  test("a rung outside the row's pi ladder fails closed with the named 422", () => {
    try {
      resolveRelaySelection(directory, { model: "off-row", reasoningLevel: "high" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RelaySelectionError);
      expect((error as RelaySelectionError).code).toBe("reasoning_level_unknown");
      expect((error as RelaySelectionError).message).toContain("runnable ladder");
    }
  });

  test("#434 the omp sentinel is retired: undeclared default and unknown ids fail closed", () => {
    const open: RelaySelectionDirectory = {
      rows: [
        {
          providerId: "main",
          id: "m",
          reasoning: false,
          reasoningLevels: ["none"],
          defaultReasoningLevel: "none",
        },
      ],
      defaultProviderId: null,
      defaultModelId: "m",
    };
    // No selection and no declared default → the named 422 code.
    try {
      resolveRelaySelection(open, {});
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("provider_default_undeclared");
    }
    // "omp" is no longer a seam: a selection naming it is provider_unknown
    // unless a row actually declares it.
    try {
      resolveRelaySelection(open, { providerId: "omp", model: "m" });
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("provider_unknown");
    }
    // A declared default still fills an absent selection — the explicit,
    // declared configuration path.
    expect(resolveRelaySelection({ ...open, defaultProviderId: "main" }, {})).toEqual({
      providerId: "main",
      modelId: "m",
      reasoningLevel: "none",
    });
  });
});

/**
 * #485 the row/model family split: the provider schema is family-
 * discriminated (openai-images ⇒ image entries only; every other/unset api
 * ⇒ chat entries only), and the curated image-id detector names the
 * well-known 产图 families for the import/loader gates.
 */
describe("#485 the row/model family split", () => {
  test("an openai-images row admits image entries and rejects chat seats", () => {
    expect(
      relayCatalogProviderSchema.safeParse({
        api: "openai-images",
        models: [
          {
            id: "gpt-image-2",
            name: "GPT Image 2",
            sizes: ["1024x1024", "1536x1024"],
            outputFormat: "png",
            cost: { perImage: 0.04 },
          },
        ],
      }).success,
    ).toBe(true);
    // The chat seats have no seat on the image branch (strict).
    expect(
      relayCatalogProviderSchema.safeParse({
        api: "openai-images",
        models: [{ id: "gpt-image-2", contextWindow: 8192 }],
      }).success,
    ).toBe(false);
    // The per-image cost dictionary is the only cost shape admitted.
    expect(
      relayCatalogProviderSchema.safeParse({
        api: "openai-images",
        models: [{ id: "gpt-image-2", cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }],
      }).success,
    ).toBe(false);
  });

  test("a chat row admits chat entries and rejects image semantics", () => {
    expect(
      relayCatalogProviderSchema.safeParse({
        api: "openai-responses",
        models: [{ id: "glm-5.3", input: ["text"], contextWindow: 200000 }],
      }).success,
    ).toBe(true);
    expect(
      relayCatalogProviderSchema.safeParse({
        models: [{ id: "m", sizes: ["1024x1024"] }],
      }).success,
    ).toBe(false);
    expect(
      relayCatalogProviderSchema.safeParse({
        models: [{ id: "m", cost: { perImage: 0.04 } }],
      }).success,
    ).toBe(false);
  });

  test("the type guard discriminates the family branches", () => {
    const imageRow = relayCatalogProviderSchema.parse({
      api: "openai-images",
      models: [{ id: "gpt-image-2" }],
    });
    const chatRow = relayCatalogProviderSchema.parse({ models: [{ id: "m" }] });
    expect(isImageSourceProvider(imageRow)).toBe(true);
    expect(isImageSourceProvider(chatRow)).toBe(false);
    if (!isImageSourceProvider(imageRow)) throw new Error("expected the image branch");
    expect(imageRow.models[0]?.sizes).toBeUndefined();
  });

  test("isImageGenerationModelId names the well-known families and whole image segments", () => {
    for (const id of [
      "gpt-image-1",
      "gpt-image-2.5",
      "dall-e-3",
      "dalle-3",
      "imagen-4.0-generate-001",
      "flux-pro-1.1",
      "black-forest-labs/FLUX.1-schnell",
      "stable-diffusion-3.5-large",
      "sd3.5-large",
      "qwen-image-edit",
      "seedream-3.0",
      "wanx2.1-t2i-turbo",
      "ideogram-v3",
      "recraft-v3",
      "gemini-2.5-flash-image",
      "gemini-2.0-flash-preview-image-generation",
    ]) {
      expect(isImageGenerationModelId(id), id).toBe(true);
    }
    for (const id of [
      "glm-5.3",
      "claude-opus-4-7",
      "gpt-5.2-codex",
      "deepseek-v3.2",
      "qwen3-max",
      "",
      "   ",
    ]) {
      expect(isImageGenerationModelId(id), id).toBe(false);
    }
  });

  test("findRelayCatalogModel skips image-source rows entirely", () => {
    const catalog = relayCatalogSchema.parse({
      providers: {
        imagey: { api: "openai-images", models: [{ id: "shared-id" }] },
      },
    });
    expect(findRelayCatalogModel(catalog, "shared-id")).toBeUndefined();
  });
});
