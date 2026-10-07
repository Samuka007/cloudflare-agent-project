import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import {
  ensureRigProviderRow,
  removeRigProviderRow,
} from "../helpers.js";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import { loadProviderConfigCatalogOverlay } from "@cap/provider-app";
import type { ProviderConfigCatalogOverlay } from "@cap/provider-app";
import { systemProviderProjectionsResponseSchema } from "../../src/contract/api/system.js";
import { buildProviderProjections } from "../../src/routes/system.js";

/**
 * Ticket #266: GET /system/provider-projections — the read-only provider
 * status face (#255 solution C). The harness row is the secret-free
 * HarnessProjection (provider-app projectHarness) plus the relay host; the
 * web_search row is chain order + credential-gate booleans + browser-backed
 * exclusions. #449: the web_search row projects the D1 `web_search` seat —
 * the AGENT_DO_WEB_SEARCH env path is deleted (zero env fallback), edits
 * ride the /system/web-search write face. #450: the catalog row projects the
 * D1 provider_configs rows (the env seed is deleted — no decodeError state,
 * no defaultProviderId). Acceptance: zero secret values anywhere in the
 * response, and no PUT on this aggregate face.
 */
beforeAll(async () => {
  await ensureMigrations();
  await ensureRigProviderRow();
});

/** The honest no-D1 overlay literal (the route's zero-config construction). */
const EMPTY_OVERLAY = {
  providers: {},
  imageSourceProviderId: null,
  webSearch: { configured: false, decodeError: false, projection: null, engines: null },
} satisfies Pick<ProviderConfigCatalogOverlay, "providers" | "imageSourceProviderId" | "webSearch">;

async function loadedOverlay(): Promise<ProviderConfigCatalogOverlay> {
  const overlay = await loadProviderConfigCatalogOverlay(env);
  if (overlay === null) throw new Error("the rig D1 binding must load an overlay");
  return overlay;
}

afterEach(async () => {
  // The seat is single-row; every case starts from the unconfigured state.
  await env.DB.prepare("DELETE FROM web_search WHERE id = 'web_search'").run();
  // Suite-seeded catalog rows never leak onto later files' projections.
  await env.DB.prepare("DELETE FROM provider_configs WHERE id = 'projcat'").run();
});

describe("GET /api/v1/system/provider-projections", () => {
  it("serves a contract-valid default projection (mock relay, ruled chain)", async () => {
    // The default-projection shape is the UNCONFIGURED deployment; the rig
    // provider row is removed locally (the D1-row projection is covered
    // below).
    await removeRigProviderRow();
    try {
      const response = await exports.default.fetch(
        "https://example.com/api/v1/system/provider-projections",
      );
      expect(response.status).toBe(200);
      const parsed = systemProviderProjectionsResponseSchema.parse(await response.json());
      // No MODEL_RELAY_API_KEY in the test worker env → mock mode (mock-first
      // ruling #28), key gate false, defaults from HARNESS_DEFAULTS.
      expect(parsed.harness.relayMode).toBe("mock");
      // #450: the deployment channel is the incumbent anthropic face.
      expect(parsed.harness.relayApi).toBe("anthropic-messages");
      expect(parsed.harness.relayKeyPresent).toBe(false);
      expect(parsed.harness.relayBaseUrlHost).toBe("open.bigmodel.cn");
      expect(parsed.harness.relayModel).toBe("glm-5.3");
      // #377: no DAEMON_MACHINE_ID var → the cloud placeholder is the honest
      // harness default (no deployment machine is fabricated).
      expect(parsed.harness.machineId).toBe(CLOUD_PLACEHOLDER_HOST_ID);
      expect(parsed.harness.permissionMode).toBe("full");
      // No D1 web_search row → ruled default chain: keyed API first,
      // credential-free aggregate as fallback (#144); not an env fallback
      // (#449 — the env path no longer exists).
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
    } finally {
      await ensureRigProviderRow();
    }
  });

  it("never emits secret values (评审断言)", async () => {
    const RELAY_KEY = "sk-relay-secret-266-harness";
    const BRAVE_KEY = "brave-secret-266-value";
    const SEARXNG_TOKEN = "searxng-secret-266-token";
    // The engine chain rides the D1 seat: write it through the write face,
    // then project the SAME state the route reads (#449).
    await exports.default.fetch("https://example.com/api/v1/system/web-search", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: ["brave", "searxng"],
        engines: {
          brave: { apiKey: BRAVE_KEY },
          searxng: { endpoint: "https://searx.example.com", token: SEARXNG_TOKEN },
        },
      }),
    });
    const overlay = await loadedOverlay();
    const built = buildProviderProjections(
      {
        MODEL_RELAY_API_KEY: RELAY_KEY,
        MODEL_RELAY_BASE_URL_ANTHROPIC: "https://newapi.example.com",
        MODEL_RELAY_MODEL: "glm-5.3-anth",
      },
      overlay,
    );
    const wire = systemProviderProjectionsResponseSchema.parse(built);
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain(RELAY_KEY);
    expect(serialized).not.toContain(BRAVE_KEY);
    expect(serialized).not.toContain(SEARXNG_TOKEN);
    // Presence gates survive, values never do.
    expect(wire.harness.relayMode).toBe("anthropic");
    expect(wire.harness.relayApi).toBe("anthropic-messages");
    expect(wire.harness.relayKeyPresent).toBe(true);
    expect(wire.harness.relayBaseUrlHost).toBe("newapi.example.com");
    expect(
      wire.webSearch.chain.map((engine) => [engine.engine, engine.credentialsPresent]),
    ).toEqual([
      ["brave", true],
      ["searxng", true],
    ]);
  });

  it("projects credential gates per engine from the D1 seat", async () => {
    await exports.default.fetch("https://example.com/api/v1/system/web-search", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: ["duckduckgo", "searxng"],
        timeoutSeconds: 120,
        engines: { searxng: { endpoint: "https://searx.example.com" } },
      }),
    });
    const overlay = await loadedOverlay();
    const built = buildProviderProjections({}, overlay);
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

  it("reports decodeError without row content when the stored chain is unusable", async () => {
    // A browser-backed chain entry is refused at the config layer (L1:
    // rejection, never silent fallback) — a hand-edited row carrying one is
    // a loud decodeError: no chain is served, the error text is dropped
    // (it can quote raw row content — zero-secret discipline).
    await env.DB.prepare(
      "INSERT INTO web_search (id, chain, timeout_seconds, engines, secrets_enc, secrets_meta, updated_at) VALUES ('web_search', '[\"google\"]', 60, NULL, NULL, NULL, ?)",
    )
      .bind(Date.now())
      .run();
    const overlay = await loadedOverlay();
    const built = buildProviderProjections({}, overlay);
    const parsed = systemProviderProjectionsResponseSchema.parse(built);
    expect(parsed.webSearch.configured).toBe(true);
    expect(parsed.webSearch.decodeError).toBe(true);
    expect(parsed.webSearch.chain).toEqual([]);
    expect(parsed.webSearch.timeoutSeconds).toBeNull();
    expect(parsed.webSearch.browserBackedEngines).toEqual(["google", "ecosia", "mojeek"]);
  });

  it("projects the ruled defaults when no seat row exists", async () => {
    // The loader's absent-row half projects the ruled defaults (the same
    // state the route reads on a deployment whose web_search row is absent);
    // EMPTY_OVERLAY (projection null) is the no-DB fallback shape instead.
    const built = buildProviderProjections({}, await loadedOverlay());
    const parsed = systemProviderProjectionsResponseSchema.parse(built);
    expect(parsed.webSearch.configured).toBe(false);
    expect(parsed.webSearch.decodeError).toBe(false);
    expect(
      parsed.webSearch.chain.map((engine) => engine.engine),
    ).toEqual(["brave", "public"]);
    expect(parsed.webSearch.timeoutSeconds).toBe(60);
  });

  it("keeps the aggregate face read-only while the write face sits at /system/web-search", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/v1/system/provider-projections",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain: ["public"] }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("derives the relay host and tolerates a malformed relay URL", () => {
    const host = systemProviderProjectionsResponseSchema.parse(
      buildProviderProjections(
        {
          MODEL_RELAY_BASE_URL_ANTHROPIC: "https://relay.example.net/v1/messages",
        },
        EMPTY_OVERLAY,
      ),
    );
    expect(host.harness.relayBaseUrlHost).toBe("relay.example.net");
    const malformed = systemProviderProjectionsResponseSchema.parse(
      buildProviderProjections({ MODEL_RELAY_BASE_URL_ANTHROPIC: "not a url" }, EMPTY_OVERLAY),
    );
    expect(malformed.harness.relayBaseUrlHost).toBeNull();
  });

  it("carries the harness execution projection from the env", () => {
    const parsed = systemProviderProjectionsResponseSchema.parse(
      buildProviderProjections(
        {
          HARNESS_PERMISSION_MODE: "accept-edits",
          DAEMON_MACHINE_ID: "gpu-box-1",
          MODEL_RELAY_THINKING_BUDGET_TOKENS: "2048",
        },
        EMPTY_OVERLAY,
      ),
    );
    expect(parsed.harness.permissionMode).toBe("accept-edits");
    expect(parsed.harness.machineId).toBe("gpu-box-1");
    expect(parsed.harness.relayThinking).toBe("enabled:2048");
  });

  it("#450 reports the catalog status from the D1 rows (empty when unconfigured)", () => {
    // No configured rows → not configured, and NOTHING stands in (#434):
    // the catalog ledger is honestly empty; the harness row keeps folding
    // the deployment channel model. Rows never declare a default (#450),
    // and the env-era decodeError state cannot arise.
    const built = buildProviderProjections({}, EMPTY_OVERLAY);
    const parsed = systemProviderProjectionsResponseSchema.parse(built);
    expect(parsed.catalog.configured).toBe(false);
    expect(parsed.catalog.decodeError).toBe(false);
    expect(parsed.catalog.defaultProviderId).toBeNull();
    expect(parsed.catalog.defaultModel).toBe("glm-5.3");
    expect(parsed.catalog.providers).toEqual([]);
    expect(parsed.catalog.models).toEqual([]);
  });

  it("#450 reports configured rows' ids without leaking declared values", async () => {
    await env.DB.prepare(
      "INSERT INTO provider_configs (id, display_name, base_url, api, service_tier, api_key_enc, models, created_at, updated_at) VALUES ('projcat', 'GLM Relay', NULL, 'anthropic-messages', 0, NULL, ?, ?, ?)",
    )
      .bind(
        JSON.stringify([{ id: "glm-5.3", name: "GLM-5.3", input: ["text", "image"] }]),
        Date.now(),
        Date.now(),
      )
      .run();
    const built = buildProviderProjections({}, await loadedOverlay());
    const parsed = systemProviderProjectionsResponseSchema.parse(built);
    expect(parsed.catalog.configured).toBe(true);
    expect(parsed.catalog.decodeError).toBe(false);
    // Rows never declare a deployment-wide default (#450).
    expect(parsed.catalog.defaultProviderId).toBeNull();
    // The rig's own provider row projects alongside the suite-seeded one.
    expect(parsed.catalog.providers).toEqual(["projcat", "rig"]);
    expect(parsed.catalog.models).toEqual(["glm-5.3", "rig-model"]);
    // Ids only — display names/ladders/windows live on execution-options.
    expect(JSON.stringify(parsed.catalog)).not.toContain("GLM-5.3");
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
