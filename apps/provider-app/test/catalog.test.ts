import { describe, expect, test } from "vitest";
import { resolveRelayCatalog } from "../src/catalog.js";
import { resolveHarness, type HarnessEnv } from "../src/harness.js";

/**
 * #350 catalog directory resolution — the projection source for the
 * execution-options / provider-projections / project-defaults faces. The
 * acceptance core is the same-source matrix: for the same env, the
 * directory's default row must equal the harness resolution (model, budget
 * scalars, image input, reasoning default) — the #319 dual-face pattern
 * pinned at the resolution layer, so the picker face and the
 * turns-actually-run truth cannot disagree (roadmap §2.3 contradiction 1).
 */

const MULTI = JSON.stringify({
  defaultProvider: "main",
  providers: {
    main: {
      displayName: "Main relay",
      serviceTier: true,
      baseUrl: "https://relay.example/anthropic",
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
  },
});

describe("#350 resolveRelayCatalog", () => {
  test("absent catalog → the M0 omp synthesis (picker shape unchanged)", () => {
    const resolution = resolveRelayCatalog({});
    expect(resolution.configured).toBe(false);
    expect(resolution.decodeError).toBe(false);
    expect(resolution.defaultProviderId).toBe("omp");
    expect(resolution.providers).toEqual([
      { id: "omp", displayName: "omp", serviceTier: false, imageInput: false },
    ]);
    expect(resolution.models).toHaveLength(1);
    expect(resolution.models[0]).toMatchObject({
      providerId: "omp",
      id: "glm-5.3",
      model: "glm-5.3",
      displayName: "glm-5.3",
      reasoningLevels: ["none"],
      defaultReasoningLevel: "none",
      isDefault: true,
    });
  });

  test("declared catalog projects every provider/model row in declaration order", () => {
    const resolution = resolveRelayCatalog({ MODEL_RELAY_CATALOG: MULTI });
    expect(resolution.configured).toBe(true);
    expect(resolution.decodeError).toBe(false);
    expect(resolution.defaultProviderId).toBe("main");
    expect(resolution.providers).toEqual([
      {
        id: "main",
        displayName: "Main relay",
        serviceTier: true,
        // OR over the provider's rows: glm-5.3 carries image input.
        imageInput: true,
      },
      { id: "backup", displayName: "backup", serviceTier: false, imageInput: false },
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
      // Budget off in this env → the declared ladder is dormant: extended
      // thinking never runs, so exactly [none] is advertised.
      reasoningLevels: ["none"],
      defaultReasoningLevel: "none",
      contextWindow: 200_000,
      maxTokens: 8192,
      imageInput: true,
    });
    // Non-running rows carry their declaration; undeclared scalars stay null
    // rather than borrowing the running model's.
    expect(resolution.models[1]).toMatchObject({
      displayName: "GLM-5.3-Air",
      contextWindow: 131_072,
      maxTokens: null,
      imageInput: false,
    });
  });

  test("same-source matrix: the default row equals the harness resolution", () => {
    const envs: HarnessEnv[] = [
      {},
      { MODEL_RELAY_MODEL: "glm-5.3-air", MODEL_RELAY_CATALOG: MULTI },
      { MODEL_RELAY_CATALOG: MULTI, MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096" },
      {
        MODEL_RELAY_CATALOG: MULTI,
        MODEL_RELAY_MODEL: "glm-5.3-flash",
        MODEL_RELAY_THINKING_BUDGET_TOKENS: "2048",
      },
      { MODEL_RELAY_CATALOG: MULTI, MODEL_RELAY_MAX_TOKENS: "1024" },
    ];
    for (const env of envs) {
      const resolution = resolveRelayCatalog(env);
      const harness = resolveHarness(env);
      const defaultRows = resolution.models.filter((model) => model.isDefault);
      // Exactly one advertised default: the model turns actually run.
      expect(defaultRows).toHaveLength(1);
      const row = defaultRows[0];
      expect(resolution.harness).toEqual(harness);
      expect(row?.model).toBe(harness.relay.model);
      expect(row?.contextWindow).toBe(harness.relay.contextWindow);
      expect(row?.maxTokens).toBe(harness.relay.maxTokens);
      expect(row?.imageInput).toBe(harness.relay.supportsImageInput);
      expect(row?.defaultReasoningLevel).toBe(harness.execution.reasoningLevel);
      expect(resolution.models[0]?.reasoningLevels).toContain(
        resolution.models[0]?.defaultReasoningLevel,
      );
    }
  });

  test("a running model missing from the declaration is prepended under the default provider", () => {
    const resolution = resolveRelayCatalog({
      MODEL_RELAY_CATALOG: MULTI,
      MODEL_RELAY_MODEL: "undeclared-model",
      MODEL_RELAY_IMAGE_INPUT: "1",
    });
    expect(resolution.models[0]).toMatchObject({
      providerId: "main",
      id: "undeclared-model",
      displayName: "undeclared-model",
      isDefault: true,
      imageInput: true,
    });
    // The declared rows ride alongside, none falsely flagged default.
    expect(resolution.models).toHaveLength(4);
    expect(resolution.models.filter((model) => model.isDefault)).toHaveLength(1);
  });

  test("broken declaration → decodeError with a functional synthesis", () => {
    const resolution = resolveRelayCatalog({
      MODEL_RELAY_CATALOG: '{"providers":{},"defaultProvider":"omp"}',
      MODEL_RELAY_MODEL: "glm-5.3-air",
    });
    expect(resolution.configured).toBe(true);
    expect(resolution.decodeError).toBe(true);
    // The picker stays functional: the env-only M0 synthesis is served.
    expect(resolution.defaultProviderId).toBe("omp");
    expect(resolution.models).toHaveLength(1);
    expect(resolution.models[0]).toMatchObject({ id: "glm-5.3-air", isDefault: true });
    expect(resolution.harness.relay.model).toBe("glm-5.3-air");
  });
});
