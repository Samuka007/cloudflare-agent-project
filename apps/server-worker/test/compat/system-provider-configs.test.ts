import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import type { z } from "zod";
import { decryptProviderSecret, resolveRelayCatalogWithOverlay } from "@cap/provider-app";
import type { AnyAgentEvent, RelayCatalogProvider } from "@cap/agent-do";
import { ensureMigrations } from "../migrate.js";
import {
  insertProviderConfig,
  type ProviderConfigEnv,
} from "../../src/db/provider-configs.js";
import {
  providerConfigDiscoverResponseSchema,
  providerConfigRowSchema,
  providerConfigsListResponseSchema,
  providerConfigTestResponseSchema,
  systemProviderProjectionsResponseSchema,
  systemExecutionOptionsResponseSchema,
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
 *   down to a real dispatched turn riding the row-level mock.
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

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
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
  return env.DB.prepare(
    "SELECT id, api_key_enc, models FROM provider_configs WHERE id = ?",
  )
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

afterEach(async () => {
  // The suite shares one worker (isolate:false): a leftover D1 row would
  // leak onto later files' execution-options faces.
  await env.DB.prepare("DELETE FROM provider_configs").run();
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

  it("PUT replaces the visible face and keeps the credential unless told otherwise", async () => {
    await postProvider({
      id: "putty",
      displayName: "Before",
      baseUrl: "https://before.example.com",
      api: "anthropic-messages",
      models: [{ id: "before-model" }],
      apiKey: PANEL_KEY,
    });

    // Omitted apiKey → KEEP (an edit that never mentions the key cannot wipe it).
    const kept = providerConfigRowSchema.parse(
      await (
        await request("PUT", "/api/v1/system/providers/putty", {
          displayName: "After",
          baseUrl: "https://after.example.com",
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
    expect(
      await decryptProviderSecret(RIG_MASTER_KEY, beforeKeep?.api_key_enc ?? ""),
    ).toBe(PANEL_KEY);

    // apiKey: string → ROTATE; the fresh IV makes the rotation observable.
    await request("PUT", "/api/v1/system/providers/putty", {
      displayName: "After",
      models: [{ id: "after-model" }],
      apiKey: PANEL_KEY_ROTATED,
    });
    const rotated = await rawD1Row("putty");
    expect(
      await decryptProviderSecret(RIG_MASTER_KEY, rotated?.api_key_enc ?? ""),
    ).toBe(PANEL_KEY_ROTATED);
    expect(rotated?.api_key_enc).not.toBe(beforeKeep?.api_key_enc);

    // apiKey: null → CLEAR.
    const cleared = providerConfigRowSchema.parse(
      await (
        await request("PUT", "/api/v1/system/providers/putty", {
          displayName: "After",
          models: [{ id: "after-model" }],
          apiKey: null,
        })
      ).json(),
    );
    expect(cleared.hasApiKey).toBe(false);
    expect((await rawD1Row("putty"))?.api_key_enc).toBeNull();
  });

  it("PATCH moves only the provided columns", async () => {
    await postProvider({
      id: "patchy",
      displayName: "Keep",
      baseUrl: "https://keep.example.com",
      api: "anthropic-messages",
      serviceTier: false,
      models: [{ id: "keep-model" }],
      apiKey: PANEL_KEY,
    });
    const patched = providerConfigRowSchema.parse(
      await (
        await request("PATCH", "/api/v1/system/providers/patchy", {
          baseUrl: "https://moved.example.com",
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
    envp: { displayName: "Panel Override", api: "openai-responses", models: [{ id: "panel-model" }] },
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
    // wholesale. The env-derived RUNNING model stays visible exactly once as
    // the synthesized wire-truth row (selection-less threads still run it),
    // under the default provider, as the default.
    const envModelRows = merged.models.filter((model) => model.id === "env-model");
    expect(envModelRows).toHaveLength(1);
    expect(envModelRows[0]?.displayName).toBe("env-model");
    expect(envModelRows[0]?.isDefault).toBe(true);
    expect(envModelRows[0]?.providerId).toBe("envp");
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
    expect(
      (await executionOptions()).providers.map((provider) => provider.id),
    ).toContain("panelp");
    await deleteRow("panelp");
    expect(
      (await executionOptions()).providers.map((provider) => provider.id),
    ).not.toContain("panelp");
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
  it("a panel provider is selectable at create and a dispatched turn rides its mock", async () => {
    // No key and no baseUrl → the row-level mock posture (standalone rows
    // never fall back to deployment credentials).
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
      `/api/v1/threads/${thread.id}/events/wait?type=${encodeURIComponent("turn/completed")}&afterSeq=0&waitMs=15000`,
    );
    expect(wait.status).toBe(200);
    const turnEvents = await rawEvents(thread.id);
    // Raw journal spells terminal events with a dot (UX projects a slash).
    expect(turnEvents.some((event) => event.type === "turn.completed")).toBe(true);
    // The fixed-reply mock names the row — the turn rode the D1 provider,
    // not the deployment relay slot.
    expect(JSON.stringify(turnEvents)).toContain('provider \\"mockrow\\"');
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

  it("raw-anchored discovery reports non-list upstream responses as ok:false", async () => {
    // A refused TCP connection (discard port) exercises the real outbound
    // fetch path and maps the transport failure to a null-status verdict.
    const verdict = providerConfigDiscoverResponseSchema.parse(
      await (
        await request("POST", "/api/v1/system/providers/discover-models", {
          baseUrl: "http://127.0.0.1:9",
        })
      ).json(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBeNull();
    expect(verdict.models).toEqual([]);
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
    const ladder = (await executionOptions()).models.find(
      (model) => model.id === "budget-model",
    );
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

  it("openai-images rows are image sources: off the LLM directory, on the projections presence bit, hot", async () => {
    await postProvider({
      id: "imagey",
      displayName: "Image Source",
      baseUrl: "https://images.example.com/v1",
      api: "openai-images",
      models: [{ id: "image-model" }],
      apiKey: PANEL_KEY,
    });
    // Off the selectable LLM directory…
    expect(
      (await executionOptions()).providers.map((provider) => provider.id),
    ).not.toContain("imagey");
    // …on the CRUD face…
    expect((await listProviders()).map((entry) => entry.id)).toContain("imagey");
    // …and gating the projections presence bit (hot; zero-secret).
    const projectionsPath = "/api/v1/system/provider-projections";
    let projections = systemProviderProjectionsResponseSchema.parse(
      await (await request("GET", projectionsPath)).json(),
    );
    expect(projections.catalog.imageGeneration.configured).toBe(true);
    expect(JSON.stringify(projections)).not.toContain(PANEL_KEY);
    await deleteRow("imagey");
    projections = systemProviderProjectionsResponseSchema.parse(
      await (await request("GET", projectionsPath)).json(),
    );
    expect(projections.catalog.imageGeneration.configured).toBe(false);
  });
});
