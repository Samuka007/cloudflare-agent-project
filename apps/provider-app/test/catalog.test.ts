import { describe, expect, test } from "vitest";
import { relayCatalogModelSchema, type RelayCatalogProvider } from "@cap/agent-do";
import { resolveOverlayCatalog } from "../src/catalog.js";

/**
 * #350 → #450 → #500 → #534 catalog directory resolution — the projection
 * source for the execution-options / provider-projections / project-defaults
 * faces. Since #450 the env seed is gone: the D1 provider-config rows (the
 * panel's CRUD 正本, decoded into the overlay by the server loader) are the
 * ENTIRE directory, and resolveOverlayCatalog is the one projection they
 * feed. #534: the ladder is the pi capability projection
 * (relayReasoningLadder — `reasoning === true && efforts.length > 0`), with
 * NO load-bearing budget field: a re-imported model list re-derives the same
 * ladder from the declaration, never from a hand-set scalar.
 */

/** A stored row exactly as the legacy pre-#534 D1 JSON wrote it. */
const LEGACY_BUDGET_ROW = {
  id: "glm-5.3",
  name: "GLM-5.3",
  reasoning: true,
  reasoningLevels: ["none", "low", "high"],
  defaultReasoningLevel: "high",
  thinkingBudgetTokens: 4096,
};

const MULTI: Record<string, RelayCatalogProvider> = {
  main: {
    displayName: "Main relay",
    serviceTier: true,
    baseUrl: "https://relay.example/anthropic",
    api: "anthropic-messages",
    models: [
      {
        id: "glm-5.3",
        name: "GLM-5.3",
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 8192,
        description: "Flagship",
        // The pi shape (models.dev zhipu-coding-plan glm-5.3 anchor):
        // capability ladder + declared default, zero hand-set scalars.
        reasoning: true,
        thinking: {
          mode: "anthropic-budget-effort",
          efforts: ["low", "high", "max"],
          defaultLevel: "max",
          requiresEffort: true,
        },
      },
      { id: "glm-5.3-air", name: "GLM-5.3-Air", contextWindow: 131_072 },
    ],
  },
  backup: { models: [{ id: "glm-5.3-flash", reasoning: true }] },
};

describe("#450/#500 resolveOverlayCatalog (D1 rows are the sole 正本)", () => {
  test("zero-config overlay → the empty resolution; nothing is synthesized (#434)", () => {
    const resolution = resolveOverlayCatalog({});
    expect(resolution.configured).toBe(false);
    // The env-era decodeError cannot arise without env JSON: the loader drops
    // schema-invalid rows with a loud per-row warning, so the state is
    // constantly false with the contract shape kept (#450).
    expect(resolution.decodeError).toBe(false);
    // D1 rows carry no deployment-wide default declaration — a selection
    // without an explicit provider fails closed at the resolver (#434).
    expect(resolution.defaultProviderId).toBeNull();
    expect(resolution.providers).toEqual([]);
    expect(resolution.models).toEqual([]);
  });

  test("configured rows project every provider/model row in declaration order", () => {
    const resolution = resolveOverlayCatalog(MULTI);
    expect(resolution.configured).toBe(true);
    expect(resolution.decodeError).toBe(false);
    expect(resolution.defaultProviderId).toBeNull();
    expect(resolution.providers).toEqual([
      {
        id: "main",
        displayName: "Main relay",
        api: "anthropic-messages",
        serviceTier: true,
        // OR over the provider's rows: glm-5.3 declares image input.
        imageInput: true,
      },
      { id: "backup", displayName: "backup", api: undefined, serviceTier: false, imageInput: false },
    ]);
    expect(resolution.models.map((model) => [model.providerId, model.id])).toEqual([
      ["main", "glm-5.3"],
      ["main", "glm-5.3-air"],
      ["backup", "glm-5.3-flash"],
    ]);
    const flagship = resolution.models[0];
    expect(flagship).toMatchObject({
      displayName: "GLM-5.3",
      description: "Flagship",
      // The pi gate passes: none + the declared efforts, default = the
      // declared defaultLevel (capability-driven — no budget anywhere).
      reasoning: true,
      reasoningLevels: ["none", "low", "high", "max"],
      defaultReasoningLevel: "max",
      contextWindow: 200_000,
      maxTokens: 8192,
      imageInput: true,
      isDefault: false,
      // Model declaration, then provider, then the incumbent anthropic face.
      api: "anthropic-messages",
    });
    expect(flagship?.thinking).toEqual({
      mode: "anthropic-budget-effort",
      efforts: ["low", "high", "max"],
      defaultLevel: "max",
      requiresEffort: true,
    });
    // Every row carries its own declaration; undeclared scalars stay null
    // rather than borrowing another row's.
    expect(resolution.models[1]).toMatchObject({
      displayName: "GLM-5.3-Air",
      contextWindow: 131_072,
      maxTokens: null,
      // No capability seats → the pi gate fails → exactly [none].
      reasoning: false,
      reasoningLevels: ["none"],
      defaultReasoningLevel: "none",
      thinking: undefined,
      imageInput: false,
      isDefault: false,
    });
  });

  test("#500: no row is ever a default (no deployment model exists)", () => {
    const resolution = resolveOverlayCatalog(MULTI);
    expect(resolution.models.filter((model) => model.isDefault)).toHaveLength(0);
    // The picker's fallback is an explicit selection — even a row list that
    // contains every plausible id flags nothing.
    expect(resolution.models.every((model) => !model.isDefault)).toBe(true);
  });

  test("the #361 api fold: model declaration, then provider, then the incumbent face", () => {
    const resolution = resolveOverlayCatalog({
      mixed: {
        api: "openai-responses",
        models: [
          { id: "glm-5.3", api: "anthropic-messages" },
          { id: "glm-5.3-flash" },
        ],
      },
      legacy: { models: [{ id: "claude-panel" }] },
    });
    const apiOf = (id: string) =>
      resolution.models.find((model) => model.id === id)?.api;
    // Model-level api wins over the provider face.
    expect(apiOf("glm-5.3")).toBe("anthropic-messages");
    // Provider-level covers rows without their own api.
    expect(apiOf("glm-5.3-flash")).toBe("openai-responses");
    // No declaration anywhere → the incumbent anthropic face.
    expect(apiOf("claude-panel")).toBe("anthropic-messages");
  });

  test("openai-images rows are image sources, never LLM directory entries (#362 scope ②)", () => {
    const resolution = resolveOverlayCatalog({
      imagey: {
        api: "openai-images",
        baseUrl: "https://images.example.com/v1",
        models: [{ id: "image-model", sizes: ["1024x1024"], outputFormat: "png" }],
      },
      chat: { models: [{ id: "glm-5.3" }] },
    });
    // The image row rides the panel CRUD face only — it never enters the
    // selectable LLM directory (fail-closed selection vocabulary stays honest).
    expect(resolution.providers.map((provider) => provider.id)).toEqual(["chat"]);
    expect(resolution.models.map((model) => model.id)).toEqual(["glm-5.3"]);
  });
});

describe("#534 the pi ladder gate and the legacy compat read", () => {
  test("the capability gate: reasoning=true + efforts → the declared ladder; else [none]", () => {
    const resolution = resolveOverlayCatalog({
      gated: {
        models: [
          {
            id: "capability-row",
            reasoning: true,
            thinking: { mode: "budget", efforts: ["medium", "high"], defaultLevel: "high" },
          },
          // reasoning bit absent → the gate fails even with declared efforts.
          { id: "bitless-row", thinking: { mode: "budget", efforts: ["high"] } },
          // reasoning=true but no effort surface (pi: thinking undefined) →
          // no controllable rung → exactly [none].
          { id: "surfaceless-row", reasoning: true },
        ],
      },
    });
    const findBy = (id: string) => resolution.models.find((model) => model.id === id);
    expect(findBy("capability-row")?.reasoningLevels).toEqual(["none", "medium", "high"]);
    expect(findBy("capability-row")?.defaultReasoningLevel).toBe("high");
    expect(findBy("bitless-row")?.reasoningLevels).toEqual(["none"]);
    expect(findBy("surfaceless-row")?.reasoningLevels).toEqual(["none"]);
  });

  test("no declared defaultLevel → pi defaultSupportedEffort (the lowest effort)", () => {
    const resolution = resolveOverlayCatalog({
      defaulted: {
        models: [
          { id: "glm-row", reasoning: true, thinking: { mode: "budget", efforts: ["low", "max"] } },
        ],
      },
    });
    expect(resolution.models[0]?.defaultReasoningLevel).toBe("low");
  });

  test("compat read: the legacy budget row migrates onto the pi shape (ladder survives)", () => {
    // The exact 存量行 shape the panel wrote pre-#534 (budget number + rung
    // list). The fold keeps the ladder AND the declared default — the
    // number demotes to a wire-detail effortBudgets entry on the default
    // rung, never a capability gate again.
    const folded = relayCatalogModelSchema.parse(LEGACY_BUDGET_ROW);
    expect(folded.thinking).toEqual({
      mode: "budget",
      efforts: ["low", "high"],
      defaultLevel: "high",
      effortBudgets: { high: 4096 },
    });
    // The retired seats strip from the output — the stored JSON normalizes
    // to the pi shape on the next write.
    expect(folded).not.toHaveProperty("reasoningLevels");
    expect(folded).not.toHaveProperty("defaultReasoningLevel");
    expect(folded).not.toHaveProperty("thinkingBudgetTokens");
    const resolution = resolveOverlayCatalog({
      // The loader path: stored JSON decodes through the SAME schema
      // (skip-with-warning) before the overlay ever sees a row.
      legacy: { models: [relayCatalogModelSchema.parse(JSON.parse(JSON.stringify(LEGACY_BUDGET_ROW)))] },
    });
    const row = resolution.models[0];
    expect(row?.reasoningLevels).toEqual(["none", "low", "high"]);
    expect(row?.defaultReasoningLevel).toBe("high");
  });

  test("compat read: a budget number with no declared ladder → the single honest medium rung", () => {
    // The old deriveRelayReasoning semantics preserved: budget-on + no
    // declaration = exactly [medium], number intact on the wire seat.
    const folded = relayCatalogModelSchema.parse({ id: "m", thinkingBudgetTokens: 4096 });
    expect(folded.thinking).toEqual({
      mode: "budget",
      efforts: ["medium"],
      defaultLevel: "medium",
      effortBudgets: { medium: 4096 },
    });
  });

  test("compat read: a declared ladder without a budget revives (the gate is capability)", () => {
    // Pre-#534 such a row was DORMANT (no budget → [none]); the pi gate
    // makes the declaration the capability — the ladder is the ladder.
    const folded = relayCatalogModelSchema.parse({
      id: "m",
      reasoning: true,
      reasoningLevels: ["none", "low", "max"],
    });
    expect(folded.thinking).toEqual({
      mode: "budget",
      efforts: ["low", "max"],
      defaultLevel: "low",
    });
  });

  test("compat read: legacy reasoningEffortMap folds into thinking.effortMap", () => {
    // The deepseek anchor: compat-level remap rides the pi effortMap, keys
    // the edge ladder cannot offer (none/ultra) drop.
    const folded = relayCatalogModelSchema.parse({
      id: "m",
      reasoning: true,
      reasoningLevels: ["none", "high", "xhigh"],
      reasoningEffortMap: { xhigh: "max", ultra: "high" },
    });
    expect(folded.thinking?.effortMap).toEqual({ xhigh: "max" });
  });

  test("pi-shaped input wins verbatim; legacy seats beside it strip", () => {
    const folded = relayCatalogModelSchema.parse({
      id: "m",
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "high", "max"], defaultLevel: "max" },
      // Stale legacy seats next to a pi block are ignored (pi wins).
      reasoningLevels: ["none", "medium"],
      defaultReasoningLevel: "medium",
      thinkingBudgetTokens: 8192,
    });
    expect(folded.thinking).toEqual({
      mode: "effort",
      efforts: ["low", "high", "max"],
      defaultLevel: "max",
    });
  });

  test("strictness lives on: unknown fields and a dangling defaultLevel still fail loudly", () => {
    expect(() =>
      relayCatalogModelSchema.parse({ id: "m", contextwindow: 200000 }),
    ).toThrow();
    expect(() =>
      relayCatalogModelSchema.parse({
        id: "m",
        thinking: { mode: "budget", efforts: ["low"], defaultLevel: "max" },
      }),
    ).toThrow();
    expect(() =>
      // minimal has no bb rung — the edge refuses it (the importer warns).
      relayCatalogModelSchema.parse({ id: "m", thinking: { mode: "effort", efforts: ["minimal"] } }),
    ).toThrow();
  });
});
