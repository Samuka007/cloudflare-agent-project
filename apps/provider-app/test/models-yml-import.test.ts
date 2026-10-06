import { describe, expect, test } from "vitest";
import { relayCatalogModelSchema } from "@cap/agent-do";
import {
  ModelsYmlImportError,
  OMP_UNADMITTED_API_VALUES,
  parseModelsYml,
} from "../src/models-yml-import.js";

/**
 * #364 the omp models.yml importer: the parse + map half (route orchestration
 * lives in server-worker L1). Semantics are grounded against omp's
 * models-config-schema-bundle.ts (can1357/oh-my-pi) — the thinking
 * legacy-range pipe, the Api vocabulary, and the $$CREDENTIAL_$$ placeholder
 * shape all come from that source, not memory.
 */

describe("#364 parseModelsYml — fragment shapes", () => {
  test("accepts the full {providers: {...}} shape", () => {
    const parse = parseModelsYml(
      `
providers:
  my-relay:
    baseUrl: https://up.example.com/v1
    api: openai-responses
    models:
      - id: model-a
`,
    );
    expect(parse.skips).toEqual([]);
    expect(parse.providers.map((provider) => provider.id)).toEqual(["my-relay"]);
  });

  test("accepts a bare fragment (the providers wrapper omitted)", () => {
    const parse = parseModelsYml(
      `
my-relay:
  baseUrl: https://up.example.com/v1
  api: anthropic-messages
  models:
    - id: model-a
`,
    );
    expect(parse.providers.map((provider) => provider.id)).toEqual(["my-relay"]);
    expect(parse.providers[0]?.api).toBe("anthropic-messages");
  });

  test("invalid YAML throws the honest import_yaml_invalid 422", () => {
    try {
      parseModelsYml("providers: [unclosed");
      expect.unreachable("parse must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelsYmlImportError);
      expect((error as ModelsYmlImportError).code).toBe("import_yaml_invalid");
    }
  });

  test("a non-mapping root, an empty providers map, and a missing wrapper are honest 422s", () => {
    for (const fragment of ["- a\n- b", "{}\n", "providers: {}\n"]) {
      try {
        parseModelsYml(fragment);
        expect.unreachable(`must throw for ${JSON.stringify(fragment)}`);
      } catch (error) {
        expect((error as ModelsYmlImportError).code).toBe("import_no_providers");
      }
    }
  });
});

describe("#364 parseModelsYml — provider-level mapping", () => {
  test("maps an admitted api provider with baseUrl and a plaintext key", () => {
    const parse = parseModelsYml(
      `
providers:
  deepseek-relay:
    baseUrl: https://api.example.com
    api: openai-responses
    apiKey: sk-unit-364-plaintext
`,
    );
    expect(parse.providers).toHaveLength(1);
    const provider = parse.providers[0];
    expect(provider).toMatchObject({
      id: "deepseek-relay",
      baseUrl: "https://api.example.com",
      api: "openai-responses",
      apiKey: "sk-unit-364-plaintext",
    });
    expect(provider?.models).toEqual([]);
    expect(provider?.warnings.join("\n")).toContain("declares no models and no discovery");
  });

  test("every omp api label with no cloud adaptor gets the 422 unsupported_api verdict", () => {
    expect(OMP_UNADMITTED_API_VALUES.length).toBeGreaterThan(0);
    for (const api of OMP_UNADMITTED_API_VALUES) {
      const parse = parseModelsYml(
        `
providers:
  doomed:
    api: ${api}
`,
      );
      expect(parse.providers, api).toEqual([]);
      const [skip] = parse.skips;
      expect(skip?.id, api).toBe("doomed");
      expect(skip?.status, api).toBe(422);
      expect(skip?.code, api).toBe("unsupported_api");
      expect(skip?.message ?? "", api).toContain(`api "${api}" has no cloud adaptor yet`);
    }
  });

  test("an arbitrary junk api label is equally an explicit unsupported verdict", () => {
    const parse = parseModelsYml(
      `
providers:
  weird:
    api: turbo-gpt-9000
`,
    );
    expect(parse.skips[0]).toMatchObject({ id: "weird", status: 422, code: "unsupported_api" });
  });

  test("a provider id that cannot be a D1 row id is an invalid_id skip", () => {
    const parse = parseModelsYml(
      `
providers:
  "bad id!":
    api: anthropic-messages
`,
    );
    expect(parse.providers).toEqual([]);
    expect(parse.skips[0]).toMatchObject({ id: "bad id!", status: 422, code: "invalid_id" });
  });

  test("a non-mapping provider value is an invalid_shape skip", () => {
    const parse = parseModelsYml(
      `
providers:
  flat: just-a-string
`,
    );
    expect(parse.skips[0]).toMatchObject({ id: "flat", status: 422, code: "invalid_shape" });
  });

  test("omp credential placeholders import WITHOUT a key plus a warning", () => {
    const parse = parseModelsYml(
      `
providers:
  local-relay:
    baseUrl: https://sub.example.com
    api: anthropic-messages
    apiKey: $$CREDENTIAL_ABCDEF123:M$$
`,
    );
    const provider = parse.providers[0];
    expect(provider?.apiKey).toBeNull();
    expect(provider?.warnings.join("\n")).toContain("$$CREDENTIAL_");
    expect(provider?.warnings.join("\n")).toContain("WITHOUT a key");
  });

  test("omp-only provider keys land in one bounded dropped-keys warning", () => {
    const parse = parseModelsYml(
      `
providers:
  gated:
    baseUrl: https://up.example.com
    api: anthropic-messages
    headers:
      X-Trace: e2e
    authHeader: false
    remoteCompaction:
      enabled: true
    models:
      - id: model-a
`,
    );
    const provider = parse.providers[0];
    const dropped = provider?.warnings.find((warning) => warning.includes("omp-only keys dropped"));
    expect(dropped).toContain("headers, authHeader, remoteCompaction");
  });

  test("discovery is not migrated but points at the panel Discover flow", () => {
    const parse = parseModelsYml(
      `
providers:
  discoverable:
    baseUrl: https://up.example.com/v1
    api: openai-completions
    discovery:
      type: proxy
`,
    );
    const provider = parse.providers[0];
    expect(provider?.models).toEqual([]);
    expect(provider?.warnings.join("\n")).toContain("Discover models");
    // discovery present → the "no models AND no discovery" nudge is redundant.
    expect(provider?.warnings.join("\n")).not.toContain("declares no models and no discovery");
  });
});

describe("#364 parseModelsYml — model-row mapping", () => {
  test("maps the omp model dictionary onto catalog rows and re-validates with #350 zod", () => {
    const parse = parseModelsYml(
      `
providers:
  deepseek:
    baseUrl: https://api.example.com
    api: openai-responses
    models:
      - id: deepseek-unit
        name: DeepSeek Unit
        reasoning: true
        thinking:
          minLevel: high
          maxLevel: xhigh
          mode: effort
        input:
          - text
          - image
        contextWindow: 1000000
        maxTokens: 384000
        compat:
          supportsReasoningEffort: true
          reasoningEffortMap:
            high: high
            xhigh: max
`,
    );
    const provider = parse.providers[0];
    expect(provider?.models).toHaveLength(1);
    const model = provider?.models[0];
    // The acceptance mechanism: the produced row passes the SAME schema the
    // env catalog and loader apply.
    expect(relayCatalogModelSchema.safeParse(model).success).toBe(true);
    expect(model).toMatchObject({
      id: "deepseek-unit",
      name: "DeepSeek Unit",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      // Legacy minLevel/maxLevel range → the inclusive ladder.
      reasoningLevels: ["high", "xhigh"],
      reasoningEffortMap: { high: "high", xhigh: "max" },
    });
  });

  test("explicit efforts lists map, and omp-only rungs drop WITH a warning", () => {
    const parse = parseModelsYml(
      `
providers:
  ladder:
    api: anthropic-messages
    models:
      - id: rungs
        thinking:
          mode: effort
          efforts:
            - minimal
            - low
            - xhigh
            - max
          defaultLevel: xhigh
`,
    );
    const model = parse.providers[0]?.models[0];
    // `minimal` has no rung on the cloud ladder — dropped with a warning,
    // never clamped onto a neighbor.
    expect(model?.reasoningLevels).toEqual(["low", "xhigh", "max"]);
    expect(model?.defaultReasoningLevel).toBe("xhigh");
    expect(parse.providers[0]?.warnings.join("\n")).toContain("minimal");
    expect(parse.providers[0]?.warnings.join("\n")).toContain("outside the cloud ladder");
  });

  test("thinking.defaultLevel outside the mapped ladder drops with a warning", () => {
    const parse = parseModelsYml(
      `
providers:
  ladder:
    api: anthropic-messages
    models:
      - id: rungs
        thinking:
          efforts: [low]
          defaultLevel: max
`,
    );
    const model = parse.providers[0]?.models[0];
    expect(model?.reasoningLevels).toEqual(["low"]);
    expect(model?.defaultReasoningLevel).toBeUndefined();
    expect(parse.providers[0]?.warnings.join("\n")).toContain("defaultLevel");
  });

  test("an out-of-family model-level api skips THAT model, not the provider", () => {
    const parse = parseModelsYml(
      `
providers:
  mixed:
    api: anthropic-messages
    models:
      - id: good
      - id: doomed
        api: azure-openai-responses
      - id: also-good
`,
    );
    const provider = parse.providers[0];
    expect(provider?.models.map((model) => model.id)).toEqual(["good", "also-good"]);
    expect(provider?.warnings.join("\n")).toContain('model "doomed"');
    expect(provider?.warnings.join("\n")).toContain("azure-openai-responses");
  });

  test("unusable model rows skip with warnings — never silently dropped", () => {
    const parse = parseModelsYml(
      `
providers:
  broken:
    api: anthropic-messages
    models:
      - name: no id here
      - id: bad-window
        contextWindow: definitely-not-a-number
      - 42
`,
    );
    const provider = parse.providers[0];
    expect(provider?.models).toEqual([]);
    const transcript = provider?.warnings.join("\n") ?? "";
    expect(transcript).toContain("models[0]");
    expect(transcript).toContain("missing id");
    expect(transcript).toContain("bad-window");
    expect(transcript).toContain("contextWindow");
    expect(transcript).toContain("models[2]");
  });

  test("modelOverrides merge onto explicit rows; discovered-only targets warn", () => {
    const parse = parseModelsYml(
      `
providers:
  overridden:
    baseUrl: https://up.example.com/v1
    api: openai-responses
    discovery:
      type: proxy
    modelOverrides:
      explicit-model:
        maxTokens: 131072
        reasoning: true
      discovered-only:
        contextWindow: 1048576
    models:
      - id: explicit-model
        name: Explicit
`,
    );
    const provider = parse.providers[0];
    expect(provider?.models[0]).toMatchObject({
      id: "explicit-model",
      name: "Explicit",
      maxTokens: 131_072,
      reasoning: true,
    });
    const transcript = provider?.warnings.join("\n") ?? "";
    expect(transcript).toContain("discovered-only");
    expect(transcript).toContain("local discovery cache");
  });

  test("compat.extraBody and per-model headers warn — wire behavior never silently changes", () => {
    const parse = parseModelsYml(
      `
providers:
  wired:
    api: openai-responses
    models:
      - id: shaped
        headers:
          X-Model: yes
        compat:
          supportsDeveloperRole: false
          extraBody:
            thinking:
              type: enabled
`,
    );
    const transcript = parse.providers[0]?.warnings.join("\n") ?? "";
    expect(transcript).toContain("compat.extraBody is not migrated");
    expect(transcript).toContain("compat flags not migrated (supportsDeveloperRole)");
    expect(transcript).toContain("per-model headers are not migrated");
  });

  test("thinking.effortMap wins over compat.reasoningEffortMap on conflicts (omp precedence)", () => {
    const parse = parseModelsYml(
      `
providers:
  conflicted:
    api: openai-responses
    models:
      - id: both
        thinking:
          efforts: [high]
          effortMap:
            high: xhigh
        compat:
          reasoningEffortMap:
            high: low
`,
    );
    expect(parse.providers[0]?.models[0]?.reasoningEffortMap).toEqual({ high: "xhigh" });
  });

  test("effort-map entries outside the vocabularies drop with warnings", () => {
    const parse = parseModelsYml(
      `
providers:
  noisy:
    api: openai-responses
    models:
      - id: entries
        compat:
          reasoningEffortMap:
            minimal: low
            high: bogus-effort
            low: low
`,
    );
    const model = parse.providers[0]?.models[0];
    expect(model?.reasoningEffortMap).toEqual({ low: "low" });
    const transcript = parse.providers[0]?.warnings.join("\n") ?? "";
    expect(transcript).toContain('"minimal" is not a cloud ladder rung');
    expect(transcript).toContain("bogus-effort");
  });
});
