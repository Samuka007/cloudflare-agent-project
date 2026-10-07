import { describe, expect, test } from "vitest";

import { discoveredModelEntrySchema, hostDiscoverModelsResultSchema } from "../src/protocol.js";
import { discoverHostProviderModels } from "../src/client/host-discovery.js";
import { dispatchHostRpc } from "../src/client/connection.js";

/**
 * #447 bun suite: the daemon face of `host.discover_models` — the pi-catalog
 * enrichment path the edge cannot run. Both fetch seams are stubbed: the
 * upstream `/models` probe and the models.dev hydration (the pi-catalog
 * catalog session is scoped per fetch implementation, so a stub fetch gives
 * each test an isolated catalog). The bundled-snapshot fallback loads the
 * REAL bundled catalog (models.json import — no network), pinned by the
 * workspace's @oh-my-pi/pi-catalog@18.6.0 lockfile resolution.
 */

type FetchCalls = { url: string; init: RequestInit }[];

function stubFetch(responder: (url: string, init: RequestInit) => Response, calls: FetchCalls) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlText = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const initRecord: RequestInit = init ?? {};
    calls.push({ url: urlText, init: initRecord });
    return Promise.resolve(responder(urlText, initRecord));
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UPSTREAM_OK = { data: [{ id: "meta-llama-3" }] };

describe("discoverHostProviderModels (#447 enrichment)", () => {
  test("models.dev declaration wins its seats; bundled/ladder fills the rest", async () => {
    const upstreamCalls: FetchCalls = [];
    const catalogCalls: FetchCalls = [];
    const verdict = await discoverHostProviderModels(
      { type: "host.discover_models", baseUrl: "https://relay.example.com/v1" },
      stubFetch(() => jsonResponse(UPSTREAM_OK), upstreamCalls),
      stubFetch(
        () =>
          jsonResponse({
            providerA: {
              models: {
                "meta-llama-3": {
                  name: "Llama 3",
                  reasoning: true,
                  limit: { context: 131_072, output: 8192 },
                  cost: { input: 0.5, output: 1.5, cache_read: 0.25, cache_write: 0.6 },
                  modalities: { input: ["text", "image"] },
                  reasoning_options: [{ values: ["low", "high"] }],
                },
              },
            },
          }),
        catalogCalls,
      ),
    );
    expect(verdict.ok).toBe(true);
    expect(upstreamCalls.map((call) => call.url)).toEqual(["https://relay.example.com/v1/models"]);
    expect(catalogCalls.map((call) => call.url)).toEqual([
      "https://catalog.stencil.so/models.json.zstd",
    ]);
    const row = discoveredModelEntrySchema.parse(verdict.models[0]);
    expect(row.metadataSource).toBe("models_dev");
    expect(row.name).toBe("Llama 3");
    expect(row.contextWindow).toBe(131_072);
    expect(row.maxTokens).toBe(8192);
    expect(row.reasoning).toBe(true);
    expect(row.input).toEqual(["text", "image"]);
    expect(row.cost).toEqual({ input: 0.5, output: 1.5, cacheRead: 0.25, cacheWrite: 0.6 });
    expect(row.thinking?.efforts).toEqual(["low", "high"]);
  });

  test("hydration failure degrades to the bundled snapshot with a warning", async () => {
    const verdict = await discoverHostProviderModels(
      { type: "host.discover_models", baseUrl: "https://relay.example.com/v1" },
      stubFetch(() => jsonResponse({ data: [{ id: "claude-sonnet-5" }] }), []),
      stubFetch(() => new Response("catalog down", { status: 502 }), []),
    );
    expect(verdict.ok).toBe(true);
    expect(
      verdict.warnings.some((warning) => warning.includes("models.dev catalog unavailable")),
    ).toBe(true);
    const row = discoveredModelEntrySchema.parse(verdict.models[0]);
    expect(row.metadataSource).toBe("bundled");
    expect(row.contextWindow).toBe(1_000_000);
    expect(row.reasoning).toBe(true);
    expect(row.thinking).not.toBeNull();
    expect(row.cost?.input).toBeGreaterThan(0);
  });

  test("an id no catalog knows keeps explicit null seats under metadataSource none", async () => {
    const verdict = await discoverHostProviderModels(
      {
        type: "host.discover_models",
        baseUrl: "https://relay.example.com/v1",
        api: "openai-responses",
      },
      stubFetch(() => jsonResponse({ data: [{ id: "totally-unknown-sku" }] }), []),
      stubFetch(() => jsonResponse({}), []),
    );
    const row = discoveredModelEntrySchema.parse(verdict.models[0]);
    expect(row.metadataSource).toBe("none");
    expect(row.contextWindow).toBeNull();
    expect(row.maxTokens).toBeNull();
    expect(row.cost).toBeNull();
    expect(row.thinking).toBeNull();
    expect(row.reasoning).toBeNull();
    expect(row.input).toBeNull();
    expect(row.api).toBe("openai-responses");
  });

  test("unusable entries skip with a warning; usable ones still enrich", async () => {
    const verdict = await discoverHostProviderModels(
      { type: "host.discover_models", baseUrl: "https://relay.example.com/v1" },
      stubFetch(() => jsonResponse({ data: [{ nope: true }, { id: "meta-llama-3" }] }), []),
      stubFetch(
        () =>
          jsonResponse({
            providerA: {
              models: {
                "meta-llama-3": { limit: { context: 4096 } },
              },
            },
          }),
        [],
      ),
    );
    expect(verdict.warnings.some((warning) => warning.includes("never silently dropped"))).toBe(
      true,
    );
    expect(verdict.models).toHaveLength(1);
    expect(verdict.models[0]?.contextWindow).toBe(4096);
  });

  test("auth headers follow the row's api family (anthropic vs bearer)", async () => {
    const calls: FetchCalls = [];
    const fetchImpl = stubFetch(() => jsonResponse({ data: [] }), calls);
    await discoverHostProviderModels(
      {
        type: "host.discover_models",
        baseUrl: "https://relay.example.com/v1",
        api: "anthropic",
        apiKey: "sk-host",
      },
      fetchImpl,
    );
    await discoverHostProviderModels(
      { type: "host.discover_models", baseUrl: "https://relay.example.com/v1", apiKey: "sk-host" },
      fetchImpl,
    );
    const upstreamHeaders = calls
      .filter((call) => call.url.endsWith("/models"))
      .map((call) => new Headers(call.init.headers));
    const [anthropicHeaders, bearerHeaders] = upstreamHeaders;
    expect(anthropicHeaders?.get("x-api-key")).toBe("sk-host");
    expect(anthropicHeaders?.get("anthropic-version")).toBe("2023-06-01");
    expect(anthropicHeaders?.get("authorization")).toBeNull();
    expect(bearerHeaders?.get("authorization")).toBe("Bearer sk-host");
  });

  test("a non-list envelope is an ok:false verdict with bounded error text", async () => {
    const verdict = await discoverHostProviderModels(
      { type: "host.discover_models", baseUrl: "https://relay.example.com/v1" },
      stubFetch(() => jsonResponse({ error: "not a list" }), []),
      stubFetch(() => jsonResponse({}), []),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("not an OpenAI models list");
  });
});

describe("dispatchHostRpc host.discover_models glue", () => {
  test("answers exactly one ok host-rpc.response parseable by the result schema", async () => {
    const sent: unknown[] = [];
    const socket = { send: (data: string) => sent.push(JSON.parse(data)) } as unknown as WebSocket;
    const realFetch = globalThis.fetch;
    const stubbedFetch = (url: string | URL | Request, _init?: RequestInit) => {
      const urlText = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      // The catalog hydration rides the same global; an empty object payload
      // parses to an empty index (safe stub).
      if (urlText.startsWith("https://catalog.stencil.so/"))
        return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse(UPSTREAM_OK));
    };
    globalThis.fetch = stubbedFetch;
    try {
      await dispatchHostRpc("/tmp/unused", socket, {
        type: "host-rpc.request",
        requestId: "req-447",
        command: { type: "host.discover_models", baseUrl: "https://relay.example.com/v1" },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent).toHaveLength(1);
    const frame = sent[0] as Record<string, unknown>;
    expect(frame.type).toBe("host-rpc.response");
    expect(frame.requestId).toBe("req-447");
    expect(frame.commandType).toBe("host.discover_models");
    expect(frame.ok).toBe(true);
    const result = hostDiscoverModelsResultSchema.parse(frame.result);
    expect(result.ok).toBe(true);
    expect(result.models.map((model) => model.id)).toEqual(["meta-llama-3"]);
  });
});
