import { describe, expect, test } from "vitest";
import {
  DEFAULT_THINKING_REASONING_LEVEL,
  decodeRelayCatalog,
  deriveRelayReasoning,
  findRelayCatalogModel,
  isImageGenerationModelId,
  isImageSourceProvider,
  relayApiConsumesEffortMap,
  relayCatalogProviderSchema,
  relayCatalogSchema,
  relayModelEntrySchema,
  resolveRelaySelection,
  resolveResponsesEffort,
  RelaySelectionError,
  RelayEffortMapError,
} from "../src/provider-catalog.js";

/**
 * #350 relay catalog declaration — L1 over the shared field dictionary, the
 * strict decode semantics (loud rejection, never silent under-declaration),
 * the budget-derived reasoning ladder, and the row lookup order. The same
 * dictionary object is the daemon-side DAEMON_AGENT_AUTH model schema
 * (packages/daemon-service agent-auth.ts imports THIS zod instance), so
 * dictionary drift is structurally impossible — these tests pin the
 * vocabulary itself.
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
          reasoningLevels: ["none", "low", "medium", "high"],
          defaultReasoningLevel: "high",
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

  test("accepts the full declaration shape (dictionary + edge fields)", () => {
    const catalog = decodeRelayCatalog(JSON.stringify(FULL_CATALOG));
    expect(catalog).not.toBeNull();
    expect(catalog?.defaultProvider).toBe("main");
    const main = catalog?.providers.main;
    if (main === undefined || isImageSourceProvider(main)) throw new Error("expected chat branch");
    expect(main.models[0]?.input).toEqual(["text", "image"]);
    expect(main.models[0]?.cost?.cacheWrite).toBe(0);
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

  test("rejects unknown reasoning rungs and a default outside the declared ladder", () => {
    const badRung = JSON.stringify({
      providers: { omp: { models: [{ id: "m", reasoningLevels: ["medium", "megahigh"] }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(badRung))).toThrow();
    const danglingDefault = JSON.stringify({
      providers: {
        omp: { models: [{ id: "m", reasoningLevels: ["low"], defaultReasoningLevel: "high" }] },
      },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(danglingDefault))).toThrow();
  });

  test("rejects non-positive windows/budgets and negative cost rates", () => {
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

  test("the dictionary is exactly the daemon agent-auth model vocabulary", () => {
    // Field-set pin at the schema level: the shared dictionary must keep the
    // omp models.yml field set (id/name/api/reasoning/input/contextWindow/
    // maxTokens/cost) — daemon-service imports this same schema instance.
    const keys = Object.keys(relayModelEntrySchema.shape).sort();
    expect(keys).toEqual(
      ["api", "contextWindow", "cost", "id", "input", "maxTokens", "name", "reasoning"].sort(),
    );
  });
});

describe("#350 reasoning ladder derivation", () => {
  test("budget off → exactly [none] regardless of any declaration", () => {
    // Extended thinking never runs — offering budget rungs would over-claim
    // dispatch the wire ignores (roadmap §2.3 contradiction 2).
    expect(deriveRelayReasoning({ thinkingEnabled: false })).toEqual({
      levels: ["none"],
      defaultLevel: "none",
    });
    expect(
      deriveRelayReasoning({
        thinkingEnabled: false,
        declaredLevels: ["low", "medium"],
        declaredDefault: "medium",
      }),
    ).toEqual({ levels: ["none"], defaultLevel: "none" });
  });

  test("budget on without a declaration → the single honest medium rung", () => {
    expect(deriveRelayReasoning({ thinkingEnabled: true })).toEqual({
      levels: [DEFAULT_THINKING_REASONING_LEVEL],
      defaultLevel: DEFAULT_THINKING_REASONING_LEVEL,
    });
    expect(DEFAULT_THINKING_REASONING_LEVEL).toBe("medium");
  });

  test("budget on with a declaration → the declaration verbatim", () => {
    expect(
      deriveRelayReasoning({
        thinkingEnabled: true,
        declaredLevels: ["none", "low", "high"],
        declaredDefault: "high",
      }),
    ).toEqual({ levels: ["none", "low", "high"], defaultLevel: "high" });
    // No declared default → medium when present, else the first rung.
    expect(
      deriveRelayReasoning({ thinkingEnabled: true, declaredLevels: ["low", "medium", "high"] }),
    ).toEqual({ levels: ["low", "medium", "high"], defaultLevel: "medium" });
    expect(deriveRelayReasoning({ thinkingEnabled: true, declaredLevels: ["low", "max"] })).toEqual(
      { levels: ["low", "max"], defaultLevel: "low" },
    );
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

describe("#361 relay api face + effort mapping", () => {
  test("the edge catalog validates api against the relay-speakable enum", () => {
    // The shared model dictionary stays free-form (daemon parity with omp's
    // api families); the EDGE face only accepts what the relay dials.
    const freeForm = relayModelEntrySchema.safeParse({ id: "m", api: "openai-completions" });
    expect(freeForm.success).toBe(true);
    // #363: openai-completions is a speakable edge face now (the second
    // protocol family — a completions row drives the chat.completions wire).
    const speakable = JSON.stringify({
      providers: { omp: { api: "openai-completions", models: [{ id: "m" }] } },
    });
    expect(relayCatalogSchema.parse(JSON.parse(speakable)).providers.omp?.api).toBe(
      "openai-completions",
    );
    const modelLevel = JSON.stringify({
      providers: { omp: { models: [{ id: "m", api: "google-generative-ai" }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(modelLevel))).toThrow();
  });

  test("reasoningEffortMap decodes per-model with rung keys and effort values", () => {
    const catalog = decodeRelayCatalog(
      JSON.stringify({
        providers: {
          omp: {
            api: "openai-responses",
            models: [
              {
                id: "glm-5.3-flash",
                reasoningEffortMap: { xhigh: "max", ultra: "high" },
              },
            ],
          },
        },
      }),
    );
    const omp = catalog?.providers.omp;
    if (omp === undefined || isImageSourceProvider(omp)) throw new Error("expected chat branch");
    expect(omp.models[0]?.reasoningEffortMap).toEqual({
      xhigh: "max",
      ultra: "high",
    });
    // An unknown rung key or an off-vocabulary effort value fails decode.
    const badKey = JSON.stringify({
      providers: { omp: { models: [{ id: "m", reasoningEffortMap: { megahigh: "max" } }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(badKey))).toThrow();
    const badValue = JSON.stringify({
      providers: { omp: { models: [{ id: "m", reasoningEffortMap: { high: "ultra" } }] } },
    });
    expect(() => relayCatalogSchema.parse(JSON.parse(badValue))).toThrow();
  });

  test("resolveResponsesEffort: identity defaults, per-model map wins, unmapped errors", () => {
    // Identity for the rungs the official effort vocabulary also names.
    expect(resolveResponsesEffort("none")).toBe("none");
    expect(resolveResponsesEffort("low")).toBe("low");
    expect(resolveResponsesEffort("high")).toBe("high");
    expect(resolveResponsesEffort("xhigh")).toBe("xhigh");
    expect(resolveResponsesEffort("max")).toBe("max");
    // The per-model map wins over the default (omp models.yml deepseek
    // anchor: compat.reasoningEffortMap {high: high, xhigh: max}).
    expect(resolveResponsesEffort("xhigh", { xhigh: "max" })).toBe("max");
    // Relay-only rungs without a map entry are honest errors, never clamps.
    expect(() => resolveResponsesEffort("ultra")).toThrow(RelayEffortMapError);
    expect(() => resolveResponsesEffort("ultracode")).toThrow(RelayEffortMapError);
  });

  test("#363 relayApiConsumesEffortMap: both openai faces fold, anthropic does not", () => {
    expect(relayApiConsumesEffortMap("openai-responses")).toBe(true);
    expect(relayApiConsumesEffortMap("openai-completions")).toBe(true);
    expect(relayApiConsumesEffortMap("anthropic-messages")).toBe(false);
  });

  test("#363 an effort-unmappable rung fails closed on a completions row at selection", () => {
    const directory = {
      rows: [
        {
          providerId: "omp",
          id: "ultra-row",
          reasoningLevels: ["none", "ultra"] as const,
          defaultReasoningLevel: "none" as const,
          api: "openai-completions" as const,
        },
      ],
      defaultProviderId: "omp",
      defaultModelId: "ultra-row",
      thinkingEnabled: true,
    };
    try {
      resolveRelaySelection(directory, { reasoningLevel: "ultra" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RelaySelectionError);
      expect((error as RelaySelectionError).code).toBe("reasoning_level_unknown");
    }
  });

  test("#434 the omp sentinel is retired: undeclared default and unknown ids fail closed", () => {
    const directory = {
      rows: [
        {
          providerId: "main",
          id: "m",
          reasoningLevels: ["none"] as const,
          defaultReasoningLevel: "none" as const,
        },
      ],
      defaultProviderId: null,
      defaultModelId: "m",
      thinkingEnabled: false,
    };
    // No selection and no declared default → the named 422 code.
    try {
      resolveRelaySelection(directory, {});
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("provider_default_undeclared");
    }
    // "omp" is no longer a seam: a selection naming it is provider_unknown
    // unless a row actually declares it.
    try {
      resolveRelaySelection(directory, { providerId: "omp", model: "m" });
      expect.unreachable();
    } catch (error) {
      expect((error as RelaySelectionError).code).toBe("provider_unknown");
    }
    // A declared default still fills an absent selection — the explicit,
    // declared configuration path.
    const declared = { ...directory, defaultProviderId: "main" as const };
    expect(resolveRelaySelection(declared, {})).toEqual({
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
