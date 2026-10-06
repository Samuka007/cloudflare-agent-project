import { beforeAll, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { systemProviderProjectionsResponseSchema } from "../../src/contract/api/system.js";
import { buildProviderProjections } from "../../src/routes/system.js";

/**
 * Ticket #266: GET /system/provider-projections — the read-only provider
 * status face (#255 solution C). The harness row is the secret-free
 * HarnessProjection (provider-app projectHarness) plus the relay host; the
 * web_search row is chain order + credential-gate booleans + browser-backed
 * exclusions. Acceptance: zero secret values anywhere in the response, and
 * no PUT on the face — provider edits ride the deployment env.
 */
beforeAll(ensureMigrations);

describe("GET /api/v1/system/provider-projections", () => {
  it("serves a contract-valid default projection (mock relay, ruled chain)", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/v1/system/provider-projections",
    );
    expect(response.status).toBe(200);
    const parsed = systemProviderProjectionsResponseSchema.parse(await response.json());
    // No MODEL_RELAY_API_KEY in the test worker env → mock mode (mock-first
    // ruling #28), key gate false, defaults from HARNESS_DEFAULTS.
    expect(parsed.harness.relayMode).toBe("mock");
    expect(parsed.harness.relayKeyPresent).toBe(false);
    expect(parsed.harness.relayBaseUrlHost).toBe("open.bigmodel.cn");
    expect(parsed.harness.relayModel).toBe("glm-5.3");
    expect(parsed.harness.machineId).toBe("local");
    expect(parsed.harness.permissionMode).toBe("full");
    // Unset AGENT_DO_WEB_SEARCH → ruled default chain: keyed API first,
    // credential-free aggregate as fallback (#144).
    expect(parsed.webSearch.configured).toBe(false);
    expect(parsed.webSearch.decodeError).toBe(false);
    expect(
      parsed.webSearch.chain.map((engine) => [
        engine.engine,
        engine.credentialsRequired,
        engine.credentialsPresent,
      ]),
    ).toEqual([
      ["brave", true, false],
      ["public", false, true],
    ]);
    expect(parsed.webSearch.timeoutSeconds).toBe(60);
    expect(parsed.webSearch.browserBackedEngines).toEqual(["google", "ecosia", "mojeek"]);
  });

  it("never emits secret values (评审断言)", () => {
    const RELAY_KEY = "sk-relay-secret-266-harness";
    const BRAVE_KEY = "brave-secret-266-value";
    const SEARXNG_TOKEN = "searxng-secret-266-token";
    const built = buildProviderProjections({
      MODEL_RELAY_API_KEY: RELAY_KEY,
      MODEL_RELAY_BASE_URL_ANTHROPIC: "https://newapi.example.com",
      MODEL_RELAY_MODEL: "glm-5.3-anth",
      AGENT_DO_WEB_SEARCH: JSON.stringify({
        chain: ["brave", "searxng"],
        engines: {
          brave: { apiKey: BRAVE_KEY },
          searxng: { endpoint: "https://searx.example.com", token: SEARXNG_TOKEN },
        },
      }),
    });
    const wire = systemProviderProjectionsResponseSchema.parse(built);
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain(RELAY_KEY);
    expect(serialized).not.toContain(BRAVE_KEY);
    expect(serialized).not.toContain(SEARXNG_TOKEN);
    // Presence gates survive, values never do.
    expect(wire.harness.relayMode).toBe("anthropic");
    expect(wire.harness.relayKeyPresent).toBe(true);
    expect(wire.harness.relayBaseUrlHost).toBe("newapi.example.com");
    expect(
      wire.webSearch.chain.map((engine) => [engine.engine, engine.credentialsPresent]),
    ).toEqual([
      ["brave", true],
      ["searxng", true],
    ]);
  });

  it("projects credential gates per engine from the env JSON", () => {
    const built = buildProviderProjections({
      AGENT_DO_WEB_SEARCH: JSON.stringify({
        chain: ["duckduckgo", "searxng"],
        timeoutSeconds: 120,
        engines: { searxng: { endpoint: "https://searx.example.com" } },
      }),
    });
    const parsed = systemProviderProjectionsResponseSchema.parse(built);
    expect(parsed.webSearch.configured).toBe(true);
    expect(parsed.webSearch.decodeError).toBe(false);
    expect(
      parsed.webSearch.chain.map((engine) => [
        engine.engine,
        engine.credentialsRequired,
        engine.credentialsPresent,
      ]),
    ).toEqual([
      ["duckduckgo", false, true],
      ["searxng", true, true],
    ]);
    expect(parsed.webSearch.timeoutSeconds).toBe(120);
  });

  it("reports decodeError without env content when the env JSON is unusable", () => {
    // A browser-backed chain entry is refused at the config layer (L1:
    // rejection, never silent fallback) — the projection must report the
    // broken deployment without quoting the raw env or the error text.
    const raw = JSON.stringify({ chain: ["google"] });
    const built = buildProviderProjections({ AGENT_DO_WEB_SEARCH: raw });
    const parsed = systemProviderProjectionsResponseSchema.parse(built);
    expect(parsed.webSearch.configured).toBe(true);
    expect(parsed.webSearch.decodeError).toBe(true);
    expect(parsed.webSearch.chain).toEqual([]);
    expect(parsed.webSearch.timeoutSeconds).toBeNull();
    expect(parsed.webSearch.browserBackedEngines).toEqual(["google", "ecosia", "mojeek"]);
    const brokenJson = buildProviderProjections({ AGENT_DO_WEB_SEARCH: "{not-json" });
    expect(systemProviderProjectionsResponseSchema.parse(brokenJson).webSearch.decodeError).toBe(
      true,
    );
  });

  it("derives the relay host and tolerates a malformed relay URL", () => {
    const host = systemProviderProjectionsResponseSchema.parse(
      buildProviderProjections({
        MODEL_RELAY_BASE_URL_ANTHROPIC: "https://relay.example.net/v1/messages",
      }),
    );
    expect(host.harness.relayBaseUrlHost).toBe("relay.example.net");
    const malformed = systemProviderProjectionsResponseSchema.parse(
      buildProviderProjections({ MODEL_RELAY_BASE_URL_ANTHROPIC: "not a url" }),
    );
    expect(malformed.harness.relayBaseUrlHost).toBeNull();
  });

  it("carries the harness execution projection from the env", () => {
    const parsed = systemProviderProjectionsResponseSchema.parse(
      buildProviderProjections({
        HARNESS_PERMISSION_MODE: "accept-edits",
        DAEMON_MACHINE_ID: "gpu-box-1",
        MODEL_RELAY_THINKING_BUDGET_TOKENS: "2048",
      }),
    );
    expect(parsed.harness.permissionMode).toBe("accept-edits");
    expect(parsed.harness.machineId).toBe("gpu-box-1");
    expect(parsed.harness.relayThinking).toBe("enabled:2048");
  });

  it("#350 reports the catalog declaration status (synthesis by default)", () => {
    // No MODEL_RELAY_CATALOG in the test worker env → not configured, the
    // M0 omp synthesis stands in with the harness model.
    const built = buildProviderProjections({});
    const parsed = systemProviderProjectionsResponseSchema.parse(built);
    expect(parsed.catalog.configured).toBe(false);
    expect(parsed.catalog.decodeError).toBe(false);
    expect(parsed.catalog.defaultProviderId).toBe("omp");
    expect(parsed.catalog.defaultModel).toBe("glm-5.3");
    expect(parsed.catalog.providers).toEqual(["omp"]);
    expect(parsed.catalog.models).toEqual(["glm-5.3"]);
  });

  it("#350 reports a configured catalog's ids without leaking declared values", () => {
    const built = buildProviderProjections({
      MODEL_RELAY_CATALOG: JSON.stringify({
        defaultProvider: "main",
        providers: {
          main: {
            models: [{ id: "glm-5.3", name: "GLM-5.3", input: ["text", "image"] }],
          },
        },
      }),
    });
    const parsed = systemProviderProjectionsResponseSchema.parse(built);
    expect(parsed.catalog.configured).toBe(true);
    expect(parsed.catalog.decodeError).toBe(false);
    expect(parsed.catalog.defaultProviderId).toBe("main");
    expect(parsed.catalog.providers).toEqual(["main"]);
    expect(parsed.catalog.models).toEqual(["glm-5.3"]);
    // Ids only — display names/ladders/windows live on execution-options.
    expect(JSON.stringify(parsed.catalog)).not.toContain("GLM-5.3");
  });

  it("#350 reports catalog decodeError without env content when the JSON is unusable", () => {
    const broken = systemProviderProjectionsResponseSchema.parse(
      buildProviderProjections({ MODEL_RELAY_CATALOG: "{not-json" }),
    );
    expect(broken.catalog.configured).toBe(true);
    expect(broken.catalog.decodeError).toBe(true);
    // The functional synthesis is served; the error text (which can quote
    // raw env content) is dropped — the webSearch decodeError precedent.
    expect(broken.catalog.providers).toEqual(["omp"]);

    // A credential field has no seat in the public ledger: the strict decode
    // rejects the whole declaration, and the secret never reaches the face.
    const withKey = systemProviderProjectionsResponseSchema.parse(
      buildProviderProjections({
        MODEL_RELAY_CATALOG: JSON.stringify({
          providers: { omp: { apiKey: "sk-secret-value", models: [{ id: "glm-5.3" }] } },
        }),
      }),
    );
    expect(withKey.catalog.decodeError).toBe(true);
    expect(JSON.stringify(withKey)).not.toContain("sk-secret-value");
  });

  it("offers no write path on the read-only face", async () => {
    const put = await exports.default.fetch(
      "https://example.com/api/v1/system/provider-projections",
      { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(put.status).toBe(404);
    const post = await exports.default.fetch(
      "https://example.com/api/v1/system/provider-projections",
      { method: "POST" },
    );
    expect(post.status).toBe(404);
  });
});
