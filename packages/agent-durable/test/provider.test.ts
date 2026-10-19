import { describe, expect, it } from "vitest";
import {
  createModelsFromProviders,
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  foldCapRung,
  projectModelRow,
  projectProvider,
  ProviderProjectionError,
  resolveProviderApi,
  type DurableProviderSource,
} from "../src/provider.js";

const source: DurableProviderSource = {
  providerId: "relay-a",
  displayName: "Relay A",
  baseUrl: "https://relay.example",
  api: "openai-responses",
  resolveApiKey: () => "sk-test",
  models: [
    {
      id: "m1",
      name: "Model One",
      reasoning: true,
      thinking: {
        mode: "effort",
        efforts: ["low", "high", "max"],
        effortMap: { low: "low", max: "high" },
      },
      input: ["text", "image"],
      contextWindow: 128_000,
      maxTokens: 4_096,
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
    },
    {
      id: "m2",
      api: "anthropic-messages",
    },
  ],
};

describe("provider projection", () => {
  it("projects a D1 model row onto pi-ai Model", () => {
    const row = source.models[0];
    if (row === undefined) throw new Error("fixture row missing");
    const model = projectModelRow(source, row);
    expect(model).toMatchObject({
      id: "m1",
      name: "Model One",
      api: "openai-responses",
      provider: "relay-a",
      baseUrl: "https://relay.example",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 128_000,
      maxTokens: 4_096,
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
    });
    expect(model.thinkingLevelMap).toMatchObject({
      off: "none",
      low: "low",
      max: "high",
      xhigh: "xhigh",
    });
  });

  it("uses the row api over the provider api and applies fallbacks", () => {
    const row = source.models[1];
    if (row === undefined) throw new Error("fixture row missing");
    const model = projectModelRow(source, row);
    expect(model.api).toBe("anthropic-messages");
    expect(model.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(model.maxTokens).toBe(FALLBACK_MAX_TOKENS);
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it("assembles a Models collection and resolves the row key", async () => {
    const models = createModelsFromProviders([source]);
    const model = models.getModel("relay-a", "m1");
    if (model === undefined) throw new Error("projected model missing");
    const auth = await models.getAuth(model);
    expect(auth?.auth.apiKey).toBe("sk-test");
    expect(auth?.source).toBe("provider_configs");
  });

  it("builds a provider with both chat APIs", () => {
    const provider = projectProvider(source);
    expect(provider.id).toBe("relay-a");
    expect(provider.getModels().map((model) => model.id)).toEqual(["m1", "m2"]);
  });

  it("folds cap-only rungs explicitly", () => {
    expect(foldCapRung("none")).toBe("off");
    expect(foldCapRung("ultra")).toBe("max");
    expect(foldCapRung("ultracode")).toBe("max");
    expect(() => foldCapRung("turbo")).toThrow(ProviderProjectionError);
  });

  it("rejects unknown APIs and empty model lists", () => {
    expect(resolveProviderApi(undefined)).toBe("anthropic-messages");
    expect(() => resolveProviderApi("openai-images")).toThrow(ProviderProjectionError);
    expect(() => projectProvider({ ...source, models: [] })).toThrow(ProviderProjectionError);
  });
});
