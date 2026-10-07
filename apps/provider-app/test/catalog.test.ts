import { describe, expect, test } from "vitest";
import type { RelayCatalogProvider } from "@cap/agent-do";
import { resolveOverlayCatalog } from "../src/catalog.js";
import { resolveHarness, type HarnessEnv } from "../src/harness.js";

/**
 * #350 → #450 catalog directory resolution — the projection source for the
 * execution-options / provider-projections / project-defaults faces. Since
 * #450 the env seed is gone: the D1 provider-config rows (the panel's CRUD
 * 正本, decoded into the overlay by the server loader) are the ENTIRE
 * directory, and resolveOverlayCatalog is the one projection they feed. The
 * acceptance core is the same-source matrix: for the same harness
 * resolution, the directory's running row must equal the harness fold
 * (model, budget scalars, image input) — the #319 dual-face pattern pinned
 * at the resolution layer, so the picker face and the turns-actually-run
 * truth cannot disagree (roadmap §2.3 contradiction 1).
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

describe("#450 resolveOverlayCatalog (D1 rows are the sole 正本)", () => {
  test("zero-config overlay → the empty resolution; nothing is synthesized (#434)", () => {
    const resolution = resolveOverlayCatalog(resolveHarness({}), {});
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
    // The harness half (the deployment channel) is untouched — the catalog
    // face going empty must not break the projections' harness row.
    expect(resolution.harness.relay.model).toBe("");
    expect(resolution.harness.relay.mode).toBe("unconfigured");
  });

  test("configured rows project every provider/model row in declaration order", () => {
    // #496: the env names NO running model — no row is the deployment
    // default; every row carries its own declaration (the image-input OR
    // over the row's declared input, no harness fold).
    const resolution = resolveOverlayCatalog(resolveHarness({ MODEL_RELAY_IMAGE_INPUT: "1" }), MULTI);
    expect(resolution.configured).toBe(true);
    expect(resolution.decodeError).toBe(false);
    expect(resolution.defaultProviderId).toBeNull();
    expect(resolution.providers).toEqual([
      {
        id: "main",
        displayName: "Main relay",
        api: "anthropic-messages",
        serviceTier: true,
        // OR over the provider's rows: glm-5.3 carries image input.
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
      // Budget off in this harness → the declared ladder is dormant: extended
      // thinking never runs, so exactly [none] is advertised.
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
    // Non-running rows carry their declaration; undeclared scalars stay null
    // rather than borrowing the running model's.
    expect(resolution.models[1]).toMatchObject({
      displayName: "GLM-5.3-Air",
      contextWindow: 131_072,
      maxTokens: null,
      imageInput: false,
      isDefault: false,
    });
  });

  test("same-source matrix: the running row equals the harness resolution", () => {
    const envs: HarnessEnv[] = [
      { MODEL_RELAY_MODEL: "glm-5.3-air" },
      { MODEL_RELAY_MODEL: "glm-5.3-flash", MODEL_RELAY_THINKING_BUDGET_TOKENS: "2048" },
    ];
    for (const env of envs) {
      const harness = resolveHarness(env);
      const resolution = resolveOverlayCatalog(harness, MULTI);
      const runningRows = resolution.models.filter((model) => model.isDefault);
      // Exactly one advertised default: the model turns actually run.
      expect(runningRows).toHaveLength(1);
      const row = runningRows[0];
      expect(resolution.harness).toEqual(harness);
      expect(row?.model).toBe(harness.relay.model);
      expect(row?.contextWindow).toBe(harness.relay.contextWindow);
      expect(row?.maxTokens).toBe(harness.relay.maxTokens);
      expect(row?.imageInput).toBe(harness.relay.supportsImageInput);
      // The row's effective budget folds the deployment scalar under the
      // model declaration (same fold the registry dispatch reads).
      const globalBudget =
        harness.relay.thinking.type === "enabled" ? harness.relay.thinking.budget_tokens : null;
      expect(row?.thinkingBudgetTokens).toBe(globalBudget);
      expect(resolution.models[0]?.reasoningLevels).toContain(
        resolution.models[0]?.defaultReasoningLevel,
      );
    }
    // #496: an env that names scalars but NO model declares no running row —
    // the honest projection advertises zero defaults (nothing invented).
    for (const env of [
      { MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096" },
      { MODEL_RELAY_MAX_TOKENS: "1024" },
      { MODEL_RELAY_IMAGE_INPUT: "1" },
    ] satisfies HarnessEnv[]) {
      const resolution = resolveOverlayCatalog(resolveHarness(env), MULTI);
      expect(resolution.models.filter((model) => model.isDefault)).toHaveLength(0);
    }
  });

  test("a running model missing from the rows gets no default row (#434)", () => {
    const resolution = resolveOverlayCatalog(resolveHarness({ MODEL_RELAY_MODEL: "undeclared" }), {
      main: { models: [{ id: "glm-5.3" }] },
    });
    // #434: the omission is configuration — exactly the configured rows are
    // projected, and none is falsely flagged default (no prepend, no
    // synthesized wire-truth row).
    expect(resolution.models.map((model) => model.id)).toEqual(["glm-5.3"]);
    expect(resolution.models.filter((model) => model.isDefault)).toHaveLength(0);
  });

  test("the #361 api fold: model declaration, then provider, then the incumbent face", () => {
    const resolution = resolveOverlayCatalog(resolveHarness({}), {
      mixed: {
        api: "openai-responses",
        models: [
          { id: "glm-5.3", api: "anthropic-messages" },
          { id: "glm-5.3-flash" },
        ],
      },
      legacy: { models: [{ id: "claude-panel" }] },
    });
    const byId = new Map(resolution.models.map((model) => [model.id, model]));
    // Model-level api wins over the provider face.
    expect(byId.get("glm-5.3")?.api).toBe("anthropic-messages");
    // Provider-level covers rows without their own api.
    expect(byId.get("glm-5.3-flash")?.api).toBe("openai-responses");
    // No declaration anywhere → the incumbent anthropic face.
    expect(byId.get("claude-panel")?.api).toBe("anthropic-messages");
  });

  test("openai-images rows are image sources, never LLM directory entries (#362 scope ②)", () => {
    const resolution = resolveOverlayCatalog(resolveHarness({}), {
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

  test("per-row thinking budget opens its ladder without the deployment scalar (#362)", () => {
    const resolution = resolveOverlayCatalog(resolveHarness({}), {
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
    const byId = new Map(resolution.models.map((model) => [model.id, model]));
    // The row budget runs its declared rungs even with the env budget unset.
    expect(byId.get("budget-model")?.thinkingBudgetTokens).toBe(4096);
    expect(byId.get("budget-model")?.reasoningLevels).toEqual(["none", "high"]);
    // A row without a budget stays budget-off (null, not the deployment's).
    expect(byId.get("off-model")?.thinkingBudgetTokens).toBeNull();
    expect(byId.get("off-model")?.reasoningLevels).toEqual(["none"]);
  });
});
