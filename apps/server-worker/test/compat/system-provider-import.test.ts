import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import type { z } from "zod";
import { decryptProviderSecret } from "@cap/provider-app";
import { ensureMigrations } from "../migrate.js";
import {
  providerConfigImportResponseSchema,
  providerConfigRowSchema,
  providerConfigsListResponseSchema,
  systemExecutionOptionsResponseSchema,
} from "../../src/contract/api/system.js";

/**
 * Ticket #364: the omp models.yml paste-import route
 * (POST /api/v1/system/providers/import-models-yml). Acceptance faces:
 *
 * - Paste → provider rows created through the SAME insert path as the CRUD
 *   face, with #350 zod-validated model rows; bad model rows skip with
 *   warnings inside the verdict.
 * - apiKey plaintext rides the import request body exactly once: the D1
 *   direct read carries only AES-GCM ciphertext, the loader decrypts, and
 *   no response face ever echoes the value.
 * - Out-of-family api values produce an honest HTTP-grade 422
 *   unsupported_api verdict per provider — no row, no silent drop.
 * - Whole-fragment failures (invalid YAML, no providers) are honest 422s.
 */

beforeAll(ensureMigrations);

const BASE = "https://example.com";
const RIG_MASTER_KEY = "l1-rig-master-key";
const IMPORT_KEY = "sk-import-secret-364-value";

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

async function importYaml(yaml: string): Promise<{ status: number; body: z.infer<typeof providerConfigImportResponseSchema> }> {
  const response = await request("POST", "/api/v1/system/providers/import-models-yml", { yaml });
  const payload = await response.json<unknown>();
  return {
    status: response.status,
    body: providerConfigImportResponseSchema.parse(payload),
  };
}

async function listProviders(): Promise<ProviderRow[]> {
  const response = await request("GET", "/api/v1/system/providers");
  expect(response.status).toBe(200);
  return providerConfigsListResponseSchema.parse(await response.json()).providers;
}

async function rawD1Row(id: string): Promise<{ api_key_enc: string | null } | null> {
  return env.DB.prepare("SELECT api_key_enc FROM provider_configs WHERE id = ?")
    .bind(id)
    .first<{ api_key_enc: string | null }>();
}

afterEach(async () => {
  // The suite shares one worker (isolate:false): a leftover D1 row would
  // leak onto later files' execution-options faces.
  await env.DB.prepare("DELETE FROM provider_configs").run();
});

describe("#364 import face", () => {
  it("creates rows from a pasted fragment through the CRUD insert path", async () => {
    const { status, body } = await importYaml(`
providers:
  imported-relay:
    baseUrl: https://upstream.example.com/v1
    api: openai-responses
    apiKey: ${IMPORT_KEY}
    models:
      - id: imported-model
        name: Imported Model
        input: [text, image]
        contextWindow: 200000
        maxTokens: 8192
        thinking:
          efforts: [low, high]
          defaultLevel: high
`);
    expect(status).toBe(200);
    expect(body.created).toBe(1);
    expect(body.skipped).toBe(0);
    const entry = body.providers[0];
    expect(entry).toMatchObject({
      id: "imported-relay",
      verdict: "created",
      status: 201,
      code: "created",
      modelCount: 1,
      hasApiKey: true,
    });
    // The stored truth rides the loader face: dispatchable, schema-valid.
    const rows = await listProviders();
    const row = rows.find((candidate) => candidate.id === "imported-relay");
    expect(row).toBeDefined();
    expect(row?.dispatchable).toBe(true);
    expect(row?.models[0]).toMatchObject({
      id: "imported-model",
      reasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
    });
  });

  it("encrypts the pasted key at rest and never echoes plaintext on any face", async () => {
    const { body } = await importYaml(`
providers:
  keyed:
    baseUrl: https://upstream.example.com/v1
    api: anthropic-messages
    apiKey: ${IMPORT_KEY}
    models:
      - id: keyed-model
`);
    expect(body.providers[0]?.hasApiKey).toBe(true);
    // Zero-secret: the response transcript carries presence only.
    expect(JSON.stringify(body)).not.toContain(IMPORT_KEY);
    // D1 direct read: ciphertext only — the AES-GCM payload (#362 chain).
    const raw = await rawD1Row("keyed");
    expect(raw?.api_key_enc).not.toBeNull();
    expect(raw?.api_key_enc).not.toContain(IMPORT_KEY);
    // And the rig master key decrypts it back to the pasted value.
    await expect(
      decryptProviderSecret(RIG_MASTER_KEY, raw?.api_key_enc ?? ""),
    ).resolves.toBe(IMPORT_KEY);
    const row = (await listProviders()).find((candidate) => candidate.id === "keyed");
    expect(row?.hasApiKey).toBe(true);
    expect(JSON.stringify(row)).not.toContain(IMPORT_KEY);
  });

  it("verdicts out-of-family api values with an honest 422 and creates no row", async () => {
    const { status, body } = await importYaml(`
providers:
  azure-row:
    baseUrl: https://upstream.example.com
    api: azure-openai-responses
    models:
      - id: unreachable
  good-row:
    baseUrl: https://upstream.example.com/v1
    api: anthropic-messages
    models:
      - id: reachable
`);
    expect(status).toBe(200);
    expect(body.created).toBe(1);
    expect(body.skipped).toBe(1);
    const skip = body.providers.find((entry) => entry.id === "azure-row");
    expect(skip).toMatchObject({
      verdict: "skipped",
      status: 422,
      code: "unsupported_api",
    });
    expect(skip?.message).toContain("azure-openai-responses");
    expect(skip?.message).toContain("no cloud adaptor");
    // The honest verdict is not silent: the message names the supported set.
    expect(skip?.message).toContain("anthropic-messages");
    expect((await listProviders()).map((row) => row.id)).toEqual(["good-row"]);
  });

  it("verdicts non-https or intranet baseUrls with an invalid_base_url skip (SEC-W5-003)", async () => {
    const { status, body } = await importYaml(`
providers:
  plain-http:
    baseUrl: http://attacker.example.com
    api: anthropic-messages
    models:
      - id: intercepted
  intranet-row:
    baseUrl: https://gateway.internal
    api: anthropic-messages
    models:
      - id: unreachable
  public-row:
    baseUrl: https://upstream.example.com/v1
    api: anthropic-messages
    models:
      - id: reachable
`);
    expect(status).toBe(200);
    expect(body.created).toBe(1);
    expect(body.skipped).toBe(2);
    for (const id of ["plain-http", "intranet-row"]) {
      const skip = body.providers.find((entry) => entry.id === id);
      expect(skip).toMatchObject({ verdict: "skipped", status: 422, code: "invalid_base_url" });
      expect(skip?.message).toContain("https");
    }
    expect((await listProviders()).map((row) => row.id)).toContain("public-row");
  });

  it("skips existing ids with 409 and reserved ids without touching stored rows", async () => {
    await importYaml(`
providers:
  dup:
    baseUrl: https://upstream.example.com/v1
    api: anthropic-messages
    models:
      - id: first
`);
    const before = (await listProviders()).find((row) => row.id === "dup");
    const { body } = await importYaml(`
providers:
  dup:
    baseUrl: https://other.example.com/v1
    api: anthropic-messages
    models:
      - id: second
  omp:
    baseUrl: https://upstream.example.com
    api: anthropic-messages
    models:
      - id: seam
`);
    const dup = body.providers.find((entry) => entry.id === "dup");
    const seam = body.providers.find((entry) => entry.id === "omp");
    expect(dup).toMatchObject({ verdict: "skipped", status: 409, code: "already_exists" });
    expect(seam).toMatchObject({ verdict: "skipped", status: 409, code: "reserved_id" });
    // The stored row is untouched by the skipped re-import.
    const after = (await listProviders()).find((row) => row.id === "dup");
    expect(after?.baseUrl).toBe(before?.baseUrl);
    expect(after?.models[0]).toMatchObject({ id: "first" });
    expect(body.created).toBe(0);
  });

  it("passes bad model rows through as skip-with-warning verdicts, not failures", async () => {
    const { body } = await importYaml(`
providers:
  mixed:
    baseUrl: https://upstream.example.com/v1
    api: anthropic-messages
    models:
      - id: fine
      - name: missing id
`);
    const entry = body.providers[0];
    expect(entry?.verdict).toBe("created");
    expect(entry?.modelCount).toBe(1);
    expect(entry?.warnings.join("\n")).toContain("missing id");
    expect(entry?.warnings.join("\n")).toContain("skipped");
  });

  it("reports invalid YAML and provider-less fragments as honest 422s", async () => {
    const invalid = await request("POST", "/api/v1/system/providers/import-models-yml", {
      yaml: "providers: [unclosed",
    });
    expect(invalid.status).toBe(422);
    expect((await invalid.json<{ code: string }>()).code).toBe("import_yaml_invalid");

    const empty = await request("POST", "/api/v1/system/providers/import-models-yml", {
      yaml: "providers: {}\n",
    });
    expect(empty.status).toBe(422);
    expect((await empty.json<{ code: string }>()).code).toBe("import_no_providers");
  });

  it("feeds the merged execution-options directory hot (no redeploy)", async () => {
    await importYaml(`
providers:
  hot-row:
    baseUrl: https://upstream.example.com/v1
    api: openai-responses
    models:
      - id: hot-model
`);
    const response = await request("GET", "/api/v1/system/execution-options");
    expect(response.status).toBe(200);
    const options = systemExecutionOptionsResponseSchema.parse(await response.json());
    const providers = JSON.stringify(options);
    expect(providers).toContain("hot-row");
    expect(providers).toContain("hot-model");
  });
});
