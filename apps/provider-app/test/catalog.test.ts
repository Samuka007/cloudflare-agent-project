import { describe, expect, test } from "vitest";
import type { RelayCatalogProvider } from "@cap/agent-do";
import { resolveOverlayCatalog } from "../src/catalog.js";

/**
 * #350 → #450 → #500 catalog directory resolution — the projection source for
 * the execution-options / provider-projections / project-defaults faces.
 * Since #450 the env seed is gone: the D1 provider-config rows (the panel's
 * CRUD 正本, decoded into the overlay by the server loader) are the ENTIRE
 * directory, and resolveOverlayCatalog is the one projection they feed.
 * #500: the deployment channel (env scalars folded into a "running model"
 * row) is deleted too — every row advertises exactly its own declaration,
 * no row is a synthesized default, and the resolution takes no env input at
 * all (the same-source matrix collapses to "the row IS the declaration").
 */

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
        reasoningLevels: ["none", "low", "medium", "high"],
        defaultReasoningLevel: "high",
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
      // No per-row budget → budget off: extended thinking never runs, so
      // exactly [none] is advertised.
      reasoningLevels: ["none"],
      defaultReasoningLevel: "none",
      contextWindow: 200_000,
      maxTokens: 8192,
      imageInput: true,
      isDefault: false,
      // Model declaration, then provider, then the incumbent anthropic face.
      api: "anthropic-messages",
      thinkingBudgetTokens: null,
    });
    // Every row carries its own declaration; undeclared scalars stay null
    // rather than borrowing another row's.
    expect(resolution.models[1]).toMatchObject({
      displayName: "GLM-5.3-Air",
      contextWindow: 131_072,
      maxTokens: null,
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

  test("per-row thinking budget opens its ladder — the row field is the only source (#362/#500)", () => {
    const resolution = resolveOverlayCatalog({
      budgeted: {
        models: [
          {
            id: "budget-model",
            reasoningLevels: ["none", "high"],
            defaultReasoningLevel: "high",
            thinkingBudgetTokens: 4096,
          },
          { id: "off-model", reasoningLevels: ["none", "high"], defaultReasoningLevel: "none" },
        ],
      },
    });
    const findBy = (id: string) => resolution.models.find((model) => model.id === id);
    // The row budget runs its declared rungs.
    expect(findBy("budget-model")?.thinkingBudgetTokens).toBe(4096);
    expect(findBy("budget-model")?.reasoningLevels).toEqual(["none", "high"]);
    // A row without a budget stays budget-off (null, never a deployment fold).
    expect(findBy("off-model")?.thinkingBudgetTokens).toBeNull();
    expect(findBy("off-model")?.reasoningLevels).toEqual(["none"]);
  });
});
