import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import type { z } from "zod";
import { decryptProviderSecret, resolveRelayCatalogWithOverlay } from "@cap/provider-app";
import type { AnyAgentEvent, RelayCatalogProvider } from "@cap/agent-do";
import { ensureMigrations } from "../migrate.js";
import { restoreRigRelayCatalog, unsetRigRelayCatalog } from "../helpers.js";
import { insertProviderConfig, type ProviderConfigEnv } from "../../src/db/provider-configs.js";
import {
  PROBE_RATE_LIMIT_MAX,
  resetProbeRateLimiter,
} from "../../src/services/probe-rate-limit.js";
import {
  providerConfigDiscoverResponseSchema,
  providerConfigRowSchema,
  providerConfigsListResponseSchema,
  providerConfigTestResponseSchema,
  systemProviderProjectionsResponseSchema,
  systemExecutionOptionsResponseSchema,
  systemImageSourceResponseSchema,
} from "../../src/contract/api/system.js";

/**
 * Ticket #362: the provider configurable panel's user-face 正本 — the D1
 * provider_configs table behind /api/v1/system/providers. Acceptance faces
 * exercised here:
 *
 * - CRUD lifecycle with the credential null protocol (absent → keep,
 *   null → clear, string → set) and the visible-face PUT semantics.
 * - Key encryption at rest: a D1 direct read never yields plaintext (the
 *   column is AES-256-GCM payload), and the master-key gate refuses
 *   plaintext writes when the secret is missing (db-layer backstop).
 * - Bad rows skip WITH a warning and stay on the CRUD face unrepaired —
 *   never silently deleted; the effective catalog drops them only.
 * - The merged directory (env seed ⊕ D1 rows, same id → D1 wins) feeds
 *   execution-options / projections hot — a panel write appears on the
 *   next request — and the thread selection (#351 chain) consumes it,
 *   down to a keyless row's dispatch failing closed (#434 point ⑦: no
 *   row-level mock).
 * - The CRUD display face lists ONLY user rows (#434 point 6): the env
 *   seed's read faces are execution-options / provider-projections.
 * - Zero-secret discipline (#266 extension): no projection face carries a
 *   stored key value; hasApiKey presence only.
 */

beforeAll(ensureMigrations);

const BASE = "https://example.com";
// The L1 rig master key (vitest.config miniflare bindings) — the same value
// deployments inject via `wrangler secret put PROVIDER_CONFIG_MASTER_KEY`.
const RIG_MASTER_KEY = "l1-rig-master-key";
const PANEL_KEY = "sk-panel-secret-362-value";
const PANEL_KEY_ROTATED = "sk-panel-secret-362-rotated";

type ProviderRow = z.infer<typeof providerConfigRowSchema>;

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

async function postProvider(body: unknown): Promise<{ status: number; row?: ProviderRow }> {
  const response = await request("POST", "/api/v1/system/providers", body);
  const payload = await response.json<unknown>();
  return {
    status: response.status,
    ...(response.status === 201 ? { row: providerConfigRowSchema.parse(payload) } : {}),
  };
}

async function listProviders(): Promise<ProviderRow[]> {
  const response = await request("GET", "/api/v1/system/providers");
  expect(response.status).toBe(200);
  return providerConfigsListResponseSchema.parse(await response.json()).providers;
}

async function rawD1Row(
  id: string,
): Promise<{ id: string; api_key_enc: string | null; models: string | null } | null> {
  return env.DB.prepare("SELECT id, api_key_enc, models FROM provider_configs WHERE id = ?")
    .bind(id)
    .first<{ id: string; api_key_enc: string | null; models: string | null }>();
}

async function insertRawRow(id: string, models: string, baseUrl?: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO provider_configs (id, display_name, base_url, api, service_tier, api_key_enc, models, created_at, updated_at) VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)",
  )
    .bind(id, id, baseUrl ?? null, "anthropic", models, Date.now(), Date.now())
    .run();
}

async function executionOptions() {
  const response = await request("GET", "/api/v1/system/execution-options");
  expect(response.status).toBe(200);
  return systemExecutionOptionsResponseSchema.parse(await response.json());
}

async function deleteRow(id: string): Promise<void> {
  await request("DELETE", `/api/v1/system/providers/${id}`);
}

async function rawEvents(threadId: string): Promise<AnyAgentEvent[]> {
  // Boundary cast (verbatim from thread-execution-selection.test.ts): the DO
  // namespace RPC loses the event union to UxThreadEvent's `data: unknown`;
  // the raw projection IS AnyAgentEvent.
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as {
    getEvents(args: { sinceSeq: number; project: "raw" }): Promise<{ events: AnyAgentEvent[] }>;
  };
  const { events } = await stub.getEvents({ sinceSeq: 0, project: "raw" });
  return events;
}

async function expect422(response: Response, code: string): Promise<void> {
  expect(response.status).toBe(422);
  const body = await response.json<{ code: string }>();
  expect(body.code).toBe(code);
}

/**
 * Captures the probe faces' OUTBOUND calls (the exfil oracle SEC-W5-003
 * closes): stubbing global fetch intercepts the worker's wire requests in the
 * shared L1 isolate, while exports.default.fetch keeps driving the real app.
 * The stub body satisfies the discovery envelope so verdicts stay ok:true.
 */
function stubProbeFetch(calls: { url: string; init: RequestInit }[]): void {
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: href, init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }));
  });
}

/**
 * #388 the seed-face tests inject deployment vars onto the shared worker
 * env (isolate:false — restored in afterEach). The bindings type has no
 * index signature; the seam pins exactly the two seats the faces read.
 */
function setEnvVar(key: "MODEL_RELAY_CATALOG" | "MODEL_RELAY_MODEL", value: string): void {
  (env as unknown as Record<string, string>)[key] = value;
}

afterEach(async () => {
  // The suite shares one worker (isolate:false): a leftover D1 row would
  // leak onto later files' execution-options faces.
  await env.DB.prepare("DELETE FROM provider_configs").run();
  // The #448 产图源 seat is separate 正本 state — the same leak discipline.
  await env.DB.prepare("DELETE FROM image_source").run();
  // The display-face describe injects a seed catalog onto the worker env —
  // restore the RIG declaration for later files (#434: the rig is a
  // configured deployment).
  restoreRigRelayCatalog();
  delete (env as unknown as Record<string, string>).MODEL_RELAY_MODEL;
});

describe("#434 point 6: the CRUD display face lists ONLY user rows", () => {
  // The #388 merged-face posture is retired: the env seed is redeploy-managed
  // configuration, never a fake row on the write face.
  const SEED = JSON.stringify({
    defaultProvider: "omp",
    providers: {
      omp: {
        displayName: "newapi",
        baseUrl: "https://newapi.example.com/v1",
        api: "openai-responses",
        models: [{ id: "glm-5.3-flash", name: "GLM 5.3 Flash" }],
      },
    },
  });

  function injectSeed(): void {
    setEnvVar("MODEL_RELAY_CATALOG", SEED);
  }

  it("an env seed alone lists NOTHING on the CRUD face; execution-options still serves it", async () => {
    injectSeed();
    const providers = await listProviders();
    expect(providers).toEqual([]);
    // The declared catalog still serves the picker face — the declaration is
    // the seed's read face, not the CRUD list.
    expect((await executionOptions()).providers.map((provider) => provider.id)).toEqual(["omp"]);
  });

  it("a seed id is 404 on :id like any unknown id; the reserved id stays refused on create", async () => {
    injectSeed();
    const single = await request("GET", "/api/v1/system/providers/omp");
    expect(single.status).toBe(404);
    expect((await single.json<{ code: string }>()).code).toBe("provider_config_not_found");
    const reserved = await request("POST", "/api/v1/system/providers", {
      id: "omp",
      models: [{ id: "m" }],
    });
    expect(reserved.status).toBe(409);
    expect((await reserved.json<{ code: string }>()).code).toBe("provider_config_reserved");
    expect(
      (
        await request("PUT", "/api/v1/system/providers/omp", {
          displayName: "x",
          models: [{ id: "m" }],
        })
      ).status,
    ).toBe(404);
    expect((await request("DELETE", "/api/v1/system/providers/omp")).status).toBe(404);
  });

  it("user rows list alone; the D1 row shadows its env twin on execution-options", async () => {
    injectSeed();
    await postProvider({
      id: "panelp",
      api: "anthropic-messages",
      models: [{ id: "panel-only" }],
    });
    let providers = await listProviders();
    expect(providers.map((row) => row.id)).toEqual(["panelp"]);
    // The same-id wholesale replacement half is proven with a seed provider
    // the panel CAN shadow (id omp is reserved for the sentinel-era guard).
    setEnvVar(
      "MODEL_RELAY_CATALOG",
      JSON.stringify({
        defaultProvider: "panelp",
        providers: {
          panelp: { displayName: "Seed Panel", models: [{ id: "seed-panel-model" }] },
        },
      }),
    );
    providers = await listProviders();
    expect(providers.map((row) => row.id)).toEqual(["panelp"]);
    expect(providers[0]?.models).toEqual([{ id: "panel-only" }]);
  });

  it("a broken D1 row stays visible with its warning; the env row keeps serving the picker", async () => {
    injectSeed();
    // models column is not valid JSON → skip-with-warning, never in the
    // effective overlay — the env declaration keeps serving the picker while
    // the broken USER row stays visible for repair.
    await insertRawRow("omp", '{"id": "half');
    const providers = await listProviders();
    expect(providers.map((row) => [row.id, row.status])).toEqual([["omp", "warning"]]);
    expect((await executionOptions()).providers.map((provider) => provider.id)).toEqual(["omp"]);
  });

  it("no catalog anywhere: both faces are honestly empty", async () => {
    unsetRigRelayCatalog();
    setEnvVar("MODEL_RELAY_MODEL", "glm-5.3-flash");
    try {
      const providers = await listProviders();
      expect(providers).toEqual([]);
      expect((await executionOptions()).providers).toEqual([]);
      expect((await executionOptions()).models).toEqual([]);
    } finally {
      restoreRigRelayCatalog();
    }
  });
});

describe("#362 CRUD face", () => {
  it("creates an openai-responses row and returns the zero-secret loader row", async () => {
    const { status, row } = await postProvider({
      id: "panel-openai",
      displayName: "Panel OpenAI",
      baseUrl: "https://upstream.example.com/v1",
      api: "openai-responses",
      models: [{ id: "panel-model", name: "Panel Model", input: ["text", "image"] }],
    });
    expect(status).toBe(201);
    expect(row).toMatchObject({
      id: "panel-openai",
      displayName: "Panel OpenAI",
      baseUrl: "https://upstream.example.com/v1",
      api: "openai-responses",
      serviceTier: false,
      hasApiKey: false,
      status: "ok",
      dispatchable: true,
    });
    expect(row?.models).toEqual([
      { id: "panel-model", name: "Panel Model", input: ["text", "image"] },
    ]);
    expect(JSON.stringify(row)).not.toContain("apiKey");
  });

  it("creates an anthropic row with a write-only key (presence only on the face)", async () => {
    const { status, row } = await postProvider({
      id: "panel-anthropic",
      api: "anthropic-messages",
      baseUrl: "https://anthropic.example.com",
      models: [{ id: "claude-panel" }],
      apiKey: PANEL_KEY,
    });
    expect(status).toBe(201);
    expect(row?.hasApiKey).toBe(true);
    // Write-only: the plaintext never round-trips through any response.
    expect(JSON.stringify(row)).not.toContain(PANEL_KEY);
  });

  it("rejects duplicates, the reserved seam id, malformed ids, and unknown fields", async () => {
    await postProvider({ id: "dup", models: [{ id: "m" }] });
    const duplicate = await request("POST", "/api/v1/system/providers", {
      id: "dup",
      models: [{ id: "m" }],
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json<{ code: string }>()).code).toBe("provider_config_exists");

    const reserved = await request("POST", "/api/v1/system/providers", {
      id: "omp",
      models: [{ id: "m" }],
    });
    expect(reserved.status).toBe(409);
    expect((await reserved.json<{ code: string }>()).code).toBe("provider_config_reserved");

    await expect422(
      await request("POST", "/api/v1/system/providers", { id: "has space", models: [] }),
      "validation_failed",
    );
    await expect422(
      await request("POST", "/api/v1/system/providers", { id: "-leading-dash", models: [] }),
      "validation_failed",
    );
    // strictObject: an unknown field has no seat on the write face.
    await expect422(
      await request("POST", "/api/v1/system/providers", {
        id: "strict",
        models: [],
        unknownField: true,
      }),
      "validation_failed",
    );
  });

  it("serves list and single faces; unknown ids 404", async () => {
    await postProvider({ id: "listy", models: [{ id: "m" }] });
    const single = await request("GET", "/api/v1/system/providers/listy");
    expect(single.status).toBe(200);
    expect(providerConfigRowSchema.parse(await single.json()).id).toBe("listy");
    const missing = await request("GET", "/api/v1/system/providers/ghost");
    expect(missing.status).toBe(404);
    expect((await missing.json<{ code: string }>()).code).toBe("provider_config_not_found");
    const list = await listProviders();
    expect(list.map((row) => row.id)).toContain("listy");
  });

  it("PUT replaces the visible face; the credential keeps only with an unmoved baseUrl", async () => {
    await postProvider({
      id: "putty",
      displayName: "Before",
      baseUrl: "https://before.example.com",
      api: "anthropic-messages",
      models: [{ id: "before-model" }],
      apiKey: PANEL_KEY,
    });

    // Omitted apiKey → KEEP (an edit that never mentions the key cannot wipe it) —
    // legal only while the visible face keeps the credential's own baseUrl.
    const kept = providerConfigRowSchema.parse(
      await (
        await request("PUT", "/api/v1/system/providers/putty", {
          displayName: "After",
          baseUrl: "https://before.example.com",
          api: "openai-responses",
          models: [{ id: "after-model" }],
        })
      ).json(),
    );
    expect(kept.hasApiKey).toBe(true);
    expect(kept.displayName).toBe("After");
    expect(kept.api).toBe("openai-responses");
    const beforeKeep = await rawD1Row("putty");
    expect(beforeKeep?.api_key_enc).not.toBeNull();
    expect(await decryptProviderSecret(RIG_MASTER_KEY, beforeKeep?.api_key_enc ?? "")).toBe(
      PANEL_KEY,
    );

    // SEC-W5-003: moving baseUrl while KEEPING the stored key is the exfil
    // vector — the probe faces would decrypt that key onto the new target.
    const rebased = await request("PUT", "/api/v1/system/providers/putty", {
      displayName: "After",
      baseUrl: "https://after.example.com",
      api: "openai-responses",
      models: [{ id: "after-model" }],
    });
    expect(rebased.status).toBe(422);
    expect((await rebased.json<{ code: string }>()).code).toBe("credential_reentry_required");
    const unmoved = await rawD1Row("putty");
    expect(await decryptProviderSecret(RIG_MASTER_KEY, unmoved?.api_key_enc ?? "")).toBe(PANEL_KEY);

    // apiKey: string → ROTATE; the fresh IV makes the rotation observable.
    await request("PUT", "/api/v1/system/providers/putty", {
      displayName: "After",
      baseUrl: "https://before.example.com",
      models: [{ id: "after-model" }],
      apiKey: PANEL_KEY_ROTATED,
    });
    const rotated = await rawD1Row("putty");
    expect(await decryptProviderSecret(RIG_MASTER_KEY, rotated?.api_key_enc ?? "")).toBe(
      PANEL_KEY_ROTATED,
    );
    expect(rotated?.api_key_enc).not.toBe(beforeKeep?.api_key_enc);

    // apiKey: null → CLEAR.
    const cleared = providerConfigRowSchema.parse(
      await (
        await request("PUT", "/api/v1/system/providers/putty", {
          displayName: "After",
          baseUrl: "https://before.example.com",
          models: [{ id: "after-model" }],
          apiKey: null,
        })
      ).json(),
    );
    expect(cleared.hasApiKey).toBe(false);
    expect((await rawD1Row("putty"))?.api_key_enc).toBeNull();
  });

  it("PATCH moves only the provided columns; a baseUrl move requires credential re-entry", async () => {
    await postProvider({
      id: "patchy",
      displayName: "Keep",
      baseUrl: "https://keep.example.com",
      api: "anthropic-messages",
      serviceTier: false,
      models: [{ id: "keep-model" }],
      apiKey: PANEL_KEY,
    });
    // A move WITHOUT re-entry is refused (the probe faces decrypt the stored
    // key onto the row's baseUrl — SEC-W5-003).
    const rebased = await request("PATCH", "/api/v1/system/providers/patchy", {
      baseUrl: "https://moved.example.com",
    });
    expect(rebased.status).toBe(422);
    expect((await rebased.json<{ code: string }>()).code).toBe("credential_reentry_required");

    // Same-request re-entry re-binds the credential to the new target.
    const patched = providerConfigRowSchema.parse(
      await (
        await request("PATCH", "/api/v1/system/providers/patchy", {
          baseUrl: "https://moved.example.com",
          apiKey: PANEL_KEY_ROTATED,
          serviceTier: true,
        })
      ).json(),
    );
    expect(patched.baseUrl).toBe("https://moved.example.com");
    expect(patched.displayName).toBe("Keep");
    expect(patched.api).toBe("anthropic-messages");
    expect(patched.serviceTier).toBe(true);
    expect(patched.models).toEqual([{ id: "keep-model" }]);
    expect(patched.hasApiKey).toBe(true);
    const rebound = await rawD1Row("patchy");
    expect(await decryptProviderSecret(RIG_MASTER_KEY, rebound?.api_key_enc ?? "")).toBe(
      PANEL_KEY_ROTATED,
    );
  });

  it("DELETE removes the row; subsequent reads and writes 404", async () => {
    await postProvider({ id: "goner", models: [{ id: "m" }] });
    const removed = await request("DELETE", "/api/v1/system/providers/goner");
    expect(removed.status).toBe(200);
    expect((await request("GET", "/api/v1/system/providers/goner")).status).toBe(404);
    expect(
      (
        await request("PUT", "/api/v1/system/providers/goner", {
          displayName: "x",
          models: [],
        })
      ).status,
    ).toBe(404);
    expect((await request("DELETE", "/api/v1/system/providers/goner")).status).toBe(404);
  });
});

describe("#362 key encryption at rest (D1 direct read)", () => {
  it("stores only AES-GCM ciphertext — the D1 column never carries plaintext", async () => {
    await postProvider({
      id: "cryptid",
      api: "anthropic-messages",
      models: [{ id: "m" }],
      apiKey: PANEL_KEY,
    });
    const row = await rawD1Row("cryptid");
    expect(row?.api_key_enc).not.toBeNull();
    const serializedRow = JSON.stringify(row);
    expect(serializedRow).not.toContain(PANEL_KEY);
    // Roundtrip through the rig master key proves the payload is OUR
    // ciphertext, not an accidentally-passthrough blob.
    expect(await decryptProviderSecret(RIG_MASTER_KEY, row?.api_key_enc ?? "")).toBe(PANEL_KEY);
  });

  it("re-encrypting the same plaintext yields a different column value (fresh IV)", async () => {
    await postProvider({
      id: "iv-a",
      api: "anthropic-messages",
      models: [{ id: "m" }],
      apiKey: PANEL_KEY,
    });
    await postProvider({
      id: "iv-b",
      api: "anthropic-messages",
      models: [{ id: "m" }],
      apiKey: PANEL_KEY,
    });
    const first = await rawD1Row("iv-a");
    const second = await rawD1Row("iv-b");
    expect(first?.api_key_enc).not.toBe(second?.api_key_enc);
    expect(await decryptProviderSecret(RIG_MASTER_KEY, first?.api_key_enc ?? "")).toBe(PANEL_KEY);
  });

  it("refuses plaintext key writes when the master secret is absent (db-layer backstop)", async () => {
    // The write half reads the secret off the passed env; a deployment
    // without it must not silently store plaintext.
    const envWithoutMasterKey: ProviderConfigEnv = {
      DB: env.DB,
      PROVIDER_CONFIG_MASTER_KEY: undefined,
    };
    await expect(
      insertProviderConfig(
        envWithoutMasterKey,
        "no-master",
        { displayName: null, baseUrl: null, api: null, serviceTier: false, models: [] },
        { kind: "set", plaintext: PANEL_KEY },
      ),
    ).rejects.toThrow("master_key_missing");
    // Fail-closed: the refused write left no row behind.
    expect(await rawD1Row("no-master")).toBeNull();
  });
});

describe("#362 bad rows skip-with-warning, never silently deleted", () => {
  it("keeps a non-JSON models column on the face with its raw value visible", async () => {
    const broken = '{"id": "half-written"';
    await insertRawRow("bad-json", broken);
    const response = await request("GET", "/api/v1/system/providers/bad-json");
    expect(response.status).toBe(200);
    const row = providerConfigRowSchema.parse(await response.json());
    expect(row.status).toBe("warning");
    expect(row.warnings[0]).toContain("models is not valid JSON");
    expect(row.warnings[0]).toContain("never silently deleted");
    // The raw column value rides for repair — the panel shows what is wrong.
    expect(row.models).toEqual([broken]);
    // Still listed: skip-with-warning, not deletion.
    expect((await listProviders()).map((entry) => entry.id)).toContain("bad-json");
  });

  it("keeps a schema-invalid models array with a named warning and stays off the catalog", async () => {
    await insertRawRow("bad-schema", JSON.stringify([{ id: 42 }, { nope: true }]));
    const row = providerConfigRowSchema.parse(
      await (await request("GET", "/api/v1/system/providers/bad-schema")).json(),
    );
    expect(row.status).toBe("warning");
    expect(row.warnings[0]).toContain("models failed the catalog schema");
    // The effective catalog never serves the broken declaration.
    const options = await executionOptions();
    expect(options.providers.map((provider) => provider.id)).not.toContain("bad-schema");
    expect((await listProviders()).map((entry) => entry.id)).toContain("bad-schema");
  });

  it("marks a zero-model row undispatchable with a warning instead of admitting it", async () => {
    await insertRawRow("empty-models", "[]");
    const row = providerConfigRowSchema.parse(
      await (await request("GET", "/api/v1/system/providers/empty-models")).json(),
    );
    expect(row.status).toBe("warning");
    expect(row.dispatchable).toBe(false);
    const options = await executionOptions();
    expect(options.providers.map((provider) => provider.id)).not.toContain("empty-models");
  });
});

describe("#362 merged directory: env seed ⊕ D1 rows (D1 wins)", () => {
  // The env ⊕ overlay resolution is the exact production call the routes and
  // the registry make (builder-level, per the projections-test precedent);
  // the route wiring is covered by the hot add/remove case below.
  const ENV_CATALOG = {
    defaultProvider: "envp",
    providers: {
      envp: {
        displayName: "Env Provider",
        models: [{ id: "env-model", name: "Env Model" }],
      },
    },
  };
  const OVERLAY: Record<string, RelayCatalogProvider> = {
    envp: {
      displayName: "Panel Override",
      api: "openai-responses",
      models: [{ id: "panel-model" }],
    },
    panelp: { api: "anthropic-messages", models: [{ id: "panel-only" }] },
  };

  it("a same-id D1 row replaces the env declaration wholesale; new ids are added", () => {
    const merged = resolveRelayCatalogWithOverlay(
      { MODEL_RELAY_CATALOG: JSON.stringify(ENV_CATALOG) },
      OVERLAY,
    );
    const byId = new Map(merged.providers.map((provider) => [provider.id, provider]));
    expect(byId.get("envp")?.displayName).toBe("Panel Override");
    const modelRows = new Map(merged.models.map((model) => [model.id, model]));
    expect(modelRows.has("panel-model")).toBe(true);
    expect(modelRows.has("panel-only")).toBe(true);
    // The env DECLARED row ("Env Model") is gone — the D1 models replaced it
    // wholesale, and nothing is synthesized back (#434): no env-model row,
    // no wire-truth prepend.
    expect(merged.models.filter((model) => model.id === "env-model")).toHaveLength(0);
    expect(merged.models.map((model) => model.displayName)).not.toContain("Env Model");
    // The env catalog's default provider survives the overlay.
    expect(merged.defaultProviderId).toBe("envp");
  });

  it("hot effect: a panel write appears on the next request and a delete retracts it", async () => {
    await postProvider({
      id: "panelp",
      api: "anthropic-messages",
      models: [{ id: "panel-only" }],
    });
    expect((await executionOptions()).providers.map((provider) => provider.id)).toContain("panelp");
    await deleteRow("panelp");
    expect((await executionOptions()).providers.map((provider) => provider.id)).not.toContain(
      "panelp",
    );
  });

  it("keeps every projection face zero-secret (#266 extension)", async () => {
    await postProvider({
      id: "secretless",
      api: "anthropic-messages",
      models: [{ id: "m" }],
      apiKey: PANEL_KEY,
    });
    for (const path of [
      "/api/v1/system/providers",
      "/api/v1/system/execution-options",
      "/api/v1/system/provider-projections",
    ]) {
      const response = await request("GET", path);
      const serialized = JSON.stringify(await response.json());
      expect(serialized).not.toContain(PANEL_KEY);
    }
  });
});

describe("#362 thread selection consumes the merged directory (#351 chain)", () => {
  it("a panel provider is selectable at create and a keyless dispatch fails closed (#434 ⑦)", async () => {
    // No key and no baseUrl → NO row-level mock: the turn fails loudly with
    // the named credential error (standalone rows never fall back to
    // deployment credentials).
    await postProvider({
      id: "mockrow",
      displayName: "Mock Row",
      api: "anthropic-messages",
      models: [{ id: "mock-model" }],
    });

    const created = await request("POST", "/api/v1/threads", {
      projectId: "proj_personal",
      origin: "app",
      environment: { type: "host", workspace: { type: "personal" } },
      input: [{ type: "text", text: "panel provider turn" }],
      providerId: "mockrow",
      model: "mock-model",
      reasoningLevel: "none",
    });
    expect(created.status).toBe(201);
    const thread = await created.json<{ id: string }>();

    // The selection bridges into the journal (#351 shape) with the panel id.
    const events = await rawEvents(thread.id);
    const threadCreated = events.find((event) => event.type === "thread.created");
    expect(threadCreated?.data).toMatchObject({
      execution: { providerId: "mockrow", model: "mock-model" },
    });
    const wait = await request(
      "GET",
      // The UX projection names a failed turn system/error (turn.failed is
      // the raw journal spelling — asserted below).
      `/api/v1/threads/${thread.id}/events/wait?type=${encodeURIComponent("system/error")}&afterSeq=0&waitMs=15000`,
    );
    expect(wait.status).toBe(200);
    const turnEvents = await rawEvents(thread.id);
    console.log("TURN_EVENTS", JSON.stringify(turnEvents.map((event) => event.type)));
    console.log("TURN_DETAIL", JSON.stringify(turnEvents.slice(-6)));
    // Raw journal spells terminal events with a dot (UX projects a slash).
    expect(turnEvents.some((event) => event.type === "turn.failed")).toBe(true);
    // The failure names the row and the remedy — fail-closed, not a mock.
    expect(JSON.stringify(turnEvents)).toContain("no usable credential");
  });

  it("fail-closed: an unknown/deleted provider is 422 provider_unknown on the merged directory", async () => {
    await expect422(
      await request("POST", "/api/v1/threads", {
        projectId: "proj_personal",
        origin: "app",
        environment: { type: "host", workspace: { type: "personal" } },
        input: [{ type: "text", text: "x" }],
        providerId: "ghost-panel-provider",
      }),
      "provider_unknown",
    );
    await postProvider({
      id: "brief",
      api: "anthropic-messages",
      models: [{ id: "m" }],
    });
    await deleteRow("brief");
    await expect422(
      await request("POST", "/api/v1/threads", {
        projectId: "proj_personal",
        origin: "app",
        environment: { type: "host", workspace: { type: "personal" } },
        input: [{ type: "text", text: "x" }],
        providerId: "brief",
      }),
      "provider_unknown",
    );
  });
});

describe("#362 test-connection and /models discovery faces", () => {
  beforeEach(async () => {
    // #447: discovery now delegates to registered hosts first; the exact-url
    // assertions below need an EMPTY registry so the degraded fallback is
    // the deterministic path (same hygiene as wipeRealHosts in
    // cloud-placeholder-host.test.ts — the placeholder row stays).
    await env.DB.prepare("DELETE FROM hosts WHERE id <> 'cloud'").run();
  });

  it("test-connection answers honest pre-flight verdicts without hitting the wire", async () => {
    await postProvider({
      id: "nobase",
      api: "anthropic-messages",
      models: [{ id: "m" }],
    });
    const noBase = providerConfigTestResponseSchema.parse(
      await (await request("POST", "/api/v1/system/providers/nobase/test")).json(),
    );
    expect(noBase.ok).toBe(false);
    expect(noBase.error).toContain("no baseUrl");

    await insertRawRow("nomodel", "[]", "https://upstream.example.com");
    const noModel = providerConfigTestResponseSchema.parse(
      await (await request("POST", "/api/v1/system/providers/nomodel/test")).json(),
    );
    expect(noModel.ok).toBe(false);
    expect(noModel.error).toContain("no usable model id");
  });

  it("discovery validates its anchor: exactly one of providerId/baseUrl", async () => {
    await expect422(
      await request("POST", "/api/v1/system/providers/discover-models", {}),
      "validation_failed",
    );
    await expect422(
      await request("POST", "/api/v1/system/providers/discover-models", {
        providerId: "one",
        baseUrl: "https://x.example.com",
      }),
      "validation_failed",
    );
    const missing = await request("POST", "/api/v1/system/providers/discover-models", {
      providerId: "ghost-row",
    });
    expect(missing.status).toBe(404);
  });

  it("row-anchored discovery answers a no-baseUrl verdict without a wire call", async () => {
    await postProvider({
      id: "nourl",
      api: "anthropic-messages",
      models: [{ id: "m" }],
    });
    const verdict = providerConfigDiscoverResponseSchema.parse(
      await (
        await request("POST", "/api/v1/system/providers/discover-models", {
          providerId: "nourl",
        })
      ).json(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("no baseUrl");
    expect(verdict.models).toEqual([]);
  });

  // The transport-failure verdict mapping stays covered at the service seam
  // (unit/provider-config-wire.test.ts); at the route face the raw anchor now
  // meets the same https/public-origin rule as every other baseUrl input.
});

describe("#447 discover enrichment: host delegation + degradation fallback", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM hosts WHERE id <> 'cloud'").run();
    resetProbeRateLimiter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an empty registry degrades to the bare edge probe with unavailable rows", async () => {
    await postProvider({
      id: "enrich-empty",
      api: "anthropic-messages",
      baseUrl: "https://enrich.example.com",
      models: [{ id: "m" }],
      apiKey: PANEL_KEY,
    });
    const calls: { url: string; init: RequestInit }[] = [];
    stubProbeFetch(calls);
    const verdict = providerConfigDiscoverResponseSchema.parse(
      await (
        await request("POST", "/api/v1/system/providers/discover-models", {
          providerId: "enrich-empty",
        })
      ).json(),
    );
    expect(verdict.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual(["https://enrich.example.com/models"]);
    expect(verdict.models).toHaveLength(1);
    expect(verdict.models[0]).toMatchObject({ id: "m", metadataSource: "unavailable" });
    expect(
      verdict.warnings.some((warning) => warning.includes("metadata enrichment unavailable")),
    ).toBe(true);
  });

  it("a pinned host that cannot serve falls back with a per-host note", async () => {
    await postProvider({
      id: "enrich-pinned",
      api: "anthropic-messages",
      baseUrl: "https://enrich2.example.com",
      models: [{ id: "m" }],
      apiKey: PANEL_KEY,
    });
    const calls: { url: string; init: RequestInit }[] = [];
    stubProbeFetch(calls);
    const verdict = providerConfigDiscoverResponseSchema.parse(
      await (
        await request("POST", "/api/v1/system/providers/discover-models", {
          providerId: "enrich-pinned",
          hostId: "local-447-offline",
        })
      ).json(),
    );
    expect(verdict.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual(["https://enrich2.example.com/models"]);
    expect(verdict.warnings.some((warning) => warning.includes("host local-447-offline"))).toBe(
      true,
    );
  });

  it("the response schema round-trips a fully enriched host verdict", () => {
    const verdict = providerConfigDiscoverResponseSchema.parse({
      ok: true,
      status: 200,
      latencyMs: 12,
      error: null,
      models: [
        {
          id: "meta-llama-3",
          name: "Llama 3",
          api: "openai-completions",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 131072,
          maxTokens: 8192,
          cost: { input: 0.5, output: 1.5, cacheRead: 0.25, cacheWrite: 0.6 },
          thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
          metadataSource: "models_dev",
        },
        { id: "bare", metadataSource: "unavailable" },
      ],
      warnings: [],
    });
    expect(verdict.models[0]?.thinking?.efforts).toEqual(["low", "medium", "high"]);
    expect(verdict.models[1]?.metadataSource).toBe("unavailable");
  });
});

describe("SEC-W5-003: baseUrl must name a public https origin", () => {
  it("write and discovery faces 422 non-https, IP-literal, and intranet targets", async () => {
    const rejected = [
      "http://attacker.example.com",
      "https://192.168.1.1",
      "https://[::1]/",
      "https://127.0.0.1:8080",
      "https://intranet",
      "https://foo.internal",
      "https://panel.local",
      "https://user@attacker.example.com",
      "not a url",
    ];
    for (const bad of rejected) {
      await expect422(
        await request("POST", "/api/v1/system/providers", {
          id: "badurl",
          baseUrl: bad,
          models: [],
        }),
        "validation_failed",
      );
      await expect422(
        await request("POST", "/api/v1/system/providers/discover-models", { baseUrl: bad }),
        "validation_failed",
      );
      await postProvider({ id: "seeded", models: [{ id: "m" }] });
      await expect422(
        await request("PATCH", "/api/v1/system/providers/seeded", { baseUrl: bad }),
        "validation_failed",
      );
      await request("DELETE", "/api/v1/system/providers/seeded");
    }
  });
});

describe("SEC-W5-003: stored-credential probe binding", () => {
  beforeEach(async () => {
    // #447: the discovery face's exact-url assertions assume the degraded
    // no-host path (the enrichment delegation never touches the wire).
    await env.DB.prepare("DELETE FROM hosts WHERE id <> 'cloud'").run();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses to re-anchor a stored credential onto a new baseUrl without re-entry", async () => {
    await postProvider({
      id: "exfil-gate",
      api: "anthropic-messages",
      baseUrl: "https://old.example.com",
      models: [{ id: "m" }],
      apiKey: PANEL_KEY,
    });
    const patchRefused = await request("PATCH", "/api/v1/system/providers/exfil-gate", {
      baseUrl: "https://attacker.example.com",
    });
    expect(patchRefused.status).toBe(422);
    expect((await patchRefused.json<{ code: string }>()).code).toBe("credential_reentry_required");
    // PUT is the same gate: a wholesale visible-face write moves the target too.
    const putRefused = await request("PUT", "/api/v1/system/providers/exfil-gate", {
      displayName: "x",
      baseUrl: "https://attacker.example.com",
      models: [{ id: "m" }],
    });
    expect(putRefused.status).toBe(422);
    const row = await rawD1Row("exfil-gate");
    expect(await decryptProviderSecret(RIG_MASTER_KEY, row?.api_key_enc ?? "")).toBe(PANEL_KEY);
  });

  it("probes release the stored key ONLY toward the credential's own baseUrl", async () => {
    await postProvider({
      id: "exfil-probe",
      api: "anthropic-messages",
      baseUrl: "https://old.example.com",
      models: [{ id: "m" }],
      apiKey: PANEL_KEY,
    });
    const calls: { url: string; init: RequestInit }[] = [];
    stubProbeFetch(calls);

    const verdict = providerConfigTestResponseSchema.parse(
      await (await request("POST", "/api/v1/system/providers/exfil-probe/test")).json(),
    );
    expect(verdict.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual(["https://old.example.com/v1/messages"]);
    expect(new Headers(calls[0]?.init.headers).get("x-api-key")).toBe(PANEL_KEY);

    // The providerId discovery branch rides the same binding.
    calls.length = 0;
    const discovery = providerConfigDiscoverResponseSchema.parse(
      await (
        await request("POST", "/api/v1/system/providers/discover-models", {
          providerId: "exfil-probe",
        })
      ).json(),
    );
    expect(discovery.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual(["https://old.example.com/models"]);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${PANEL_KEY}`);
  });

  it("same-request re-entry re-binds deliberately; clearing releases the target", async () => {
    await postProvider({
      id: "exfil-rebind",
      api: "anthropic-messages",
      baseUrl: "https://old.example.com",
      models: [{ id: "m" }],
      apiKey: PANEL_KEY,
    });
    const moved = providerConfigRowSchema.parse(
      await (
        await request("PATCH", "/api/v1/system/providers/exfil-rebind", {
          baseUrl: "https://new.example.com",
          apiKey: PANEL_KEY_ROTATED,
        })
      ).json(),
    );
    expect(moved.baseUrl).toBe("https://new.example.com");
    const rebound = await rawD1Row("exfil-rebind");
    expect(await decryptProviderSecret(RIG_MASTER_KEY, rebound?.api_key_enc ?? "")).toBe(
      PANEL_KEY_ROTATED,
    );
    // Clearing in the same request is the other legal exit: the target moves,
    // the credential is gone.
    const cleared = providerConfigRowSchema.parse(
      await (
        await request("PATCH", "/api/v1/system/providers/exfil-rebind", {
          baseUrl: "https://third.example.com",
          apiKey: null,
        })
      ).json(),
    );
    expect(cleared.baseUrl).toBe("https://third.example.com");
    expect(cleared.hasApiKey).toBe(false);
    expect((await rawD1Row("exfil-rebind"))?.api_key_enc).toBeNull();
  });
});

describe("SEC-W5-003: probe-face rate limit", () => {
  afterEach(() => {
    resetProbeRateLimiter();
    vi.unstubAllGlobals();
  });

  it("429s past the per-principal window with a shared budget across both faces", async () => {
    resetProbeRateLimiter();
    await postProvider({
      id: "throttled",
      api: "anthropic-messages",
      baseUrl: "https://throttle.example.com",
      models: [{ id: "m" }],
    });
    stubProbeFetch([]);
    for (let i = 0; i < PROBE_RATE_LIMIT_MAX; i++) {
      expect((await request("POST", "/api/v1/system/providers/throttled/test")).status).toBe(200);
    }
    const overLimit = await request("POST", "/api/v1/system/providers/throttled/test");
    expect(overLimit.status).toBe(429);
    const body = await overLimit.json<{
      code: string;
      retryable: boolean;
      details: { retryAfterSeconds: number };
    }>();
    expect(body.code).toBe("probe_rate_limited");
    expect(body.retryable).toBe(true);
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    // The bucket is shared across BOTH probe faces.
    const discoverBlocked = await request("POST", "/api/v1/system/providers/discover-models", {
      baseUrl: "https://throttle.example.com",
    });
    expect(discoverBlocked.status).toBe(429);
  });
});

describe("#362 scope absorption: per-model thinking budget + openai-images rows", () => {
  it("a row budget opens the declared ladder without the env scalar, and hot-collapses when removed", async () => {
    await postProvider({
      id: "budgeted",
      api: "anthropic-messages",
      models: [
        {
          id: "budget-model",
          reasoningLevels: ["none", "high"],
          defaultReasoningLevel: "high",
          thinkingBudgetTokens: 4096,
        },
      ],
    });
    const ladder = (await executionOptions()).models.find((model) => model.id === "budget-model");
    expect(ladder?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort)).toContain(
      "high",
    );

    // Hot: rewriting the row without the budget collapses the ladder on the
    // next request (env scalar unset — the deprecated fallback is absent).
    await request("PUT", "/api/v1/system/providers/budgeted", {
      models: [{ id: "budget-model", reasoningLevels: ["none", "high"] }],
    });
    const collapsed = (await executionOptions()).models.find(
      (model) => model.id === "budget-model",
    );
    expect(collapsed?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort)).toEqual([
      "none",
    ]);
  });

  it("openai-images rows become image sources ONLY through the explicit seat (#448)", async () => {
    await postProvider({
      id: "imagey",
      displayName: "Image Source",
      baseUrl: "https://images.example.com/v1",
      api: "openai-images",
      models: [{ id: "image-model" }],
      apiKey: PANEL_KEY,
    });
    // Off the selectable LLM directory…
    expect((await executionOptions()).providers.map((provider) => provider.id)).not.toContain(
      "imagey",
    );
    // …on the CRUD face…
    expect((await listProviders()).map((entry) => entry.id)).toContain("imagey");
    // …but the projections presence bit stays OFF: a row alone is a
    // candidate, not a selection (#448/#450 — zero env fallback).
    const projectionsPath = "/api/v1/system/provider-projections";
    let projections = systemProviderProjectionsResponseSchema.parse(
      await (await request("GET", projectionsPath)).json(),
    );
    expect(projections.catalog.imageGeneration).toEqual({ configured: false, providerId: null });

    // The image-source face: the row is a candidate, the seat is empty.
    const imageSourcePath = "/api/v1/system/image-source";
    const seatOf = async () =>
      systemImageSourceResponseSchema.parse(await (await request("GET", imageSourcePath)).json());
    expect(await seatOf()).toEqual({ providerId: null, candidates: ["imagey"] });

    // Selecting the row flips both faces (hot; zero-secret).
    const put = await request("PUT", imageSourcePath, { providerId: "imagey" });
    expect(put.status).toBe(200);
    expect(systemImageSourceResponseSchema.parse(await put.json()).providerId).toBe("imagey");
    projections = systemProviderProjectionsResponseSchema.parse(
      await (await request("GET", projectionsPath)).json(),
    );
    expect(projections.catalog.imageGeneration).toEqual({ configured: true, providerId: "imagey" });
    expect(JSON.stringify(projections)).not.toContain(PANEL_KEY);
  });

  it("the seat switches, validates, clears, and dangles honestly (#448)", async () => {
    const imageSourcePath = "/api/v1/system/image-source";
    const seatOf = async () =>
      systemImageSourceResponseSchema.parse(await (await request("GET", imageSourcePath)).json());
    const projectionsPath = "/api/v1/system/provider-projections";
    const projectionsOf = async () =>
      systemProviderProjectionsResponseSchema.parse(
        await (await request("GET", projectionsPath)).json(),
      );
    await postProvider({
      id: "imagey",
      api: "openai-images",
      baseUrl: "https://images.example.com/v1",
      models: [{ id: "image-model" }],
    });
    await postProvider({
      id: "imagey-2",
      api: "openai-images",
      baseUrl: "https://images-two.example.com/v1",
      models: [{ id: "image-model-2" }],
    });
    // Switch between the two candidate rows.
    await request("PUT", imageSourcePath, { providerId: "imagey" });
    await request("PUT", imageSourcePath, { providerId: "imagey-2" });
    expect((await seatOf()).providerId).toBe("imagey-2");
    expect((await seatOf()).candidates).toEqual(["imagey", "imagey-2"]);
    expect((await projectionsOf()).catalog.imageGeneration.providerId).toBe("imagey-2");

    // Invalid seats refuse with named codes; the seat never moves.
    const missing = await request("PUT", imageSourcePath, { providerId: "imagey-missing" });
    expect(missing.status).toBe(404);
    expect((await missing.json<{ code: string }>()).code).toBe("provider_config_not_found");
    await postProvider({ id: "texty", api: "anthropic-messages", models: [{ id: "m" }] });
    const wrongFamily = await request("PUT", imageSourcePath, { providerId: "texty" });
    expect(wrongFamily.status).toBe(422);
    expect((await wrongFamily.json<{ code: string }>()).code).toBe("not_an_image_source");
    await postProvider({ id: "hollow", api: "openai-images", models: [] });
    const hollow = await request("PUT", imageSourcePath, { providerId: "hollow" });
    expect(hollow.status).toBe(422);
    expect((await hollow.json<{ code: string }>()).code).toBe("not_dispatchable");
    expect((await seatOf()).providerId).toBe("imagey-2");

    // Clearing is the only not-configured state…
    await request("PUT", imageSourcePath, { providerId: null });
    // (hollow is NOT a candidate: the loader drops zero-model rows from the
    // effective catalog — the same row PUT refuses with not_dispatchable.)
    expect(await seatOf()).toEqual({
      providerId: null,
      candidates: ["imagey", "imagey-2"],
    });
    expect((await projectionsOf()).catalog.imageGeneration).toEqual({
      configured: false,
      providerId: null,
    });
    // …and deleting the seated row dangles it honestly (repair seat intact).
    await request("PUT", imageSourcePath, { providerId: "imagey-2" });
    await deleteRow("imagey-2");
    expect((await projectionsOf()).catalog.imageGeneration).toEqual({
      configured: false,
      providerId: "imagey-2",
    });
    await request("PUT", imageSourcePath, { providerId: null });
  });
});
