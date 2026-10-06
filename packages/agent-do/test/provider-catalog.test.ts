import { describe, expect, test } from "vitest";
import {
  DEFAULT_THINKING_REASONING_LEVEL,
  decodeRelayCatalog,
  deriveRelayReasoning,
  findRelayCatalogModel,
  relayCatalogSchema,
  relayModelEntrySchema,
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
      api: "anthropic",
      serviceTier: true,
      models: [
        {
          id: "glm-5.3",
          name: "GLM-5.3",
          api: "anthropic",
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
    expect(catalog?.providers.main?.models[0]?.input).toEqual(["text", "image"]);
    expect(catalog?.providers.main?.models[0]?.cost?.cacheWrite).toBe(0);
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
});
