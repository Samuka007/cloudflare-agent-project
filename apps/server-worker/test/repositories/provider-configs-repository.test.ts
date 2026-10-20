import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "../migrations-ledger";
import { RIG_MASTER_KEY } from "../helpers";
import {
  createProviderConfigsRepository,
  type ProviderConfigsRepository,
  type ProviderConfigWriteFields,
} from "../../src/db/repositories/provider-configs";

/**
 * #596 the ProviderConfigs repository interface seam (W6 db campaign T4).
 *
 * The visible face stores verbatim, the credential column is AES-GCM
 * ciphertext only (never plaintext, never crossing the seam), PUT replaces
 * wholesale, PATCH moves only the provided columns, and the keep/clear/set
 * null protocol resolves the api_key_enc column exactly like the legacy
 * module the compat suites pin. Runs on the drizzle-era database (env.DB_V2,
 * ledger-applied); assertions go through the repository interface — the raw
 * D1 reads below only verify what must NEVER be observable through it
 * (ciphertext-at-rest shape).
 */

/** The rig's armed master key — the value vitest.config binds as
 * PROVIDER_CONFIG_MASTER_KEY (the secret is not in the generated Env type). */
const MASTER_KEY = RIG_MASTER_KEY;

let repo: ProviderConfigsRepository;

function writeFields(overrides?: Partial<ProviderConfigWriteFields>): ProviderConfigWriteFields {
  return {
    displayName: "Rig Relay",
    baseUrl: "https://rig-relay.example.com",
    api: "anthropic-messages",
    serviceTier: false,
    models: [{ id: "rig-model", name: "Rig Model" }],
    ...overrides,
  };
}

async function storedCiphertext(id: string): Promise<string | null> {
  const row = await env.DB_V2.prepare("SELECT api_key_enc FROM provider_configs WHERE id = ?")
    .bind(id)
    .first<{ api_key_enc: string | null }>();
  return row?.api_key_enc ?? null;
}

async function storedUpdatedAt(id: string): Promise<number | null> {
  const row = await env.DB_V2.prepare("SELECT updated_at FROM provider_configs WHERE id = ?")
    .bind(id)
    .first<{ updated_at: number }>();
  return row?.updated_at ?? null;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB_V2);
  repo = createProviderConfigsRepository(env.DB_V2, MASTER_KEY);
});

afterEach(async () => {
  await env.DB_V2.prepare("DELETE FROM provider_configs").run();
});

afterAll(async () => {
  await env.DB_V2.prepare("DELETE FROM provider_configs").run();
});

describe("provider_configs — insert + read faces", () => {
  it("round-trips the visible face verbatim (models kept as stored entries)", async () => {
    const models = [{ id: "m1", odd: { nested: [1, "two", null] } }, { id: "m2" }];
    await repo.insert("prov-1", writeFields({ models }), { kind: "clear" });
    expect(await repo.getTarget("prov-1")).toEqual({
      baseUrl: "https://rig-relay.example.com",
      api: "anthropic-messages",
      models,
    });
  });

  it("refuses a duplicate id (legacy INSERT parity, no silent upsert)", async () => {
    await repo.insert("prov-1", writeFields(), { kind: "clear" });
    await expect(repo.insert("prov-1", writeFields(), { kind: "clear" })).rejects.toThrow();
  });

  it("reads null faces for an absent row", async () => {
    expect(await repo.getTarget("absent")).toBeNull();
    expect(await repo.getMutationContext("absent")).toBeNull();
    expect(await repo.readSecret("absent")).toBeNull();
  });
});

describe("provider_configs — the credential null protocol", () => {
  it("keeps the stored ciphertext across replace(keep)", async () => {
    await repo.insert("prov-1", writeFields(), { kind: "set", plaintext: "sk-live-1" });
    const before = await storedCiphertext("prov-1");
    expect(before).not.toBeNull();
    await repo.replace("prov-1", writeFields({ baseUrl: "https://moved.example.com" }), {
      kind: "keep",
    });
    expect(await storedCiphertext("prov-1")).toBe(before);
    expect((await repo.getTarget("prov-1"))?.baseUrl).toBe("https://moved.example.com");
    expect(await repo.readSecret("prov-1")).toBe("sk-live-1");
  });

  it("clears the credential without touching the visible face", async () => {
    await repo.insert("prov-1", writeFields(), { kind: "set", plaintext: "sk-live-1" });
    await repo.replace("prov-1", writeFields(), { kind: "clear" });
    expect(await storedCiphertext("prov-1")).toBeNull();
    expect(await repo.readSecret("prov-1")).toBeNull();
    expect((await repo.getMutationContext("prov-1"))?.hasCredential).toBe(false);
  });

  it("refuses a credential set without the master key (never plaintext at rest)", async () => {
    const unarmed = createProviderConfigsRepository(env.DB_V2, undefined);
    await expect(
      unarmed.insert("prov-1", writeFields(), { kind: "set", plaintext: "sk-live-1" }),
    ).rejects.toThrow("master_key_missing");
    expect(
      await env.DB_V2.prepare("SELECT COUNT(*) AS n FROM provider_configs").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("encrypts at rest: the ciphertext column never contains the plaintext", async () => {
    await repo.insert("prov-1", writeFields(), { kind: "set", plaintext: "sk-live-secret" });
    const ciphertext = await storedCiphertext("prov-1");
    expect(ciphertext).not.toBeNull();
    expect(ciphertext).not.toContain("sk-live-secret");
    expect(await repo.readSecret("prov-1")).toBe("sk-live-secret");
  });

  it("reads null (not a throw) when the master key is absent at read time", async () => {
    const unarmed = createProviderConfigsRepository(env.DB_V2, undefined);
    await repo.insert("prov-1", writeFields(), { kind: "set", plaintext: "sk-live-secret" });
    expect(await unarmed.readSecret("prov-1")).toBeNull();
    expect(await repo.readSecret("prov-1")).toBe("sk-live-secret");
  });
});

describe("provider_configs — PUT replace semantics", () => {
  it("is a no-op when the row is absent", async () => {
    await repo.replace("prov-1", writeFields(), { kind: "set", plaintext: "sk-1" });
    expect(
      await env.DB_V2.prepare("SELECT COUNT(*) AS n FROM provider_configs").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("replaces the visible face wholesale and bumps updated_at", async () => {
    await repo.insert("prov-1", writeFields(), { kind: "clear" });
    // Anchor the clock in the past so the bump is provable without waiting
    // on real wall-clock time (no test timers).
    await env.DB_V2.prepare(
      "UPDATE provider_configs SET updated_at = 1000 WHERE id = 'prov-1'",
    ).run();
    await repo.replace(
      "prov-1",
      writeFields({ displayName: "Moved", baseUrl: null, serviceTier: true, models: [] }),
      { kind: "clear" },
    );
    expect(await repo.getTarget("prov-1")).toEqual({
      baseUrl: null,
      api: "anthropic-messages",
      models: [],
    });
    expect(
      await env.DB_V2.prepare(
        "SELECT display_name, service_tier FROM provider_configs WHERE id = 'prov-1'",
      ).first<{ display_name: string | null; service_tier: number }>(),
    ).toEqual({
      display_name: "Moved",
      service_tier: 1,
    });
    expect((await storedUpdatedAt("prov-1")) ?? 0).toBeGreaterThan(1000);
  });
});

describe("provider_configs — PATCH merge semantics", () => {
  it("moves only the provided columns; the rest stays byte-identical", async () => {
    const models = [{ id: "m1" }, { id: "m2" }];
    await repo.insert("prov-1", writeFields({ models }), { kind: "clear" });
    await repo.patch(
      "prov-1",
      { baseUrl: "https://patched.example.com", displayName: null },
      { kind: "clear" },
    );
    expect(await repo.getTarget("prov-1")).toEqual({
      baseUrl: "https://patched.example.com",
      api: "anthropic-messages",
      models,
    });
    expect(
      await env.DB_V2.prepare(
        "SELECT display_name FROM provider_configs WHERE id = 'prov-1'",
      ).first<{
        display_name: string | null;
      }>(),
    ).toEqual({ display_name: null });
  });

  it("resolves the omitted serviceTier with ?? against the stored strict value", async () => {
    await repo.insert("prov-1", writeFields({ serviceTier: true }), { kind: "clear" });
    await repo.patch("prov-1", { displayName: "X" }, { kind: "clear" });
    expect(
      await env.DB_V2.prepare(
        "SELECT service_tier FROM provider_configs WHERE id = 'prov-1'",
      ).first<{
        service_tier: number;
      }>(),
    ).toEqual({ service_tier: 1 });
    // A hand-edited 2 decodes strict (=== 1): an omitted serviceTier drops
    // the row to false instead of preserving the garbage.
    await env.DB_V2.prepare(
      "UPDATE provider_configs SET service_tier = 2 WHERE id = 'prov-1'",
    ).run();
    await repo.patch("prov-1", { displayName: "Y" }, { kind: "clear" });
    expect(
      await env.DB_V2.prepare(
        "SELECT service_tier FROM provider_configs WHERE id = 'prov-1'",
      ).first<{
        service_tier: number;
      }>(),
    ).toEqual({ service_tier: 0 });
  });

  it("degrades a corrupt stored models cell to [] when the PATCH omits them", async () => {
    await repo.insert("prov-1", writeFields(), { kind: "clear" });
    await env.DB_V2.prepare(
      "UPDATE provider_configs SET models = 'not-json' WHERE id = 'prov-1'",
    ).run();
    await repo.patch("prov-1", { displayName: "X" }, { kind: "clear" });
    // safeParseModels degrades the corrupt cell to [] (skip-with-warning);
    // the merged write normalizes the stored cell.
    expect(
      await env.DB_V2.prepare("SELECT models FROM provider_configs WHERE id = 'prov-1'").first<{
        models: string;
      }>(),
    ).toEqual({ models: "[]" });
  });

  it("is a no-op when the row is absent", async () => {
    await repo.patch("prov-1", { displayName: "X" }, { kind: "clear" });
    expect(
      await env.DB_V2.prepare("SELECT COUNT(*) AS n FROM provider_configs").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});

describe("provider_configs — mutation context + delete", () => {
  it("carries baseUrl/api and credential presence for the write gate", async () => {
    await repo.insert("prov-1", writeFields(), { kind: "set", plaintext: "sk-live-1" });
    expect(await repo.getMutationContext("prov-1")).toEqual({
      baseUrl: "https://rig-relay.example.com",
      api: "anthropic-messages",
      hasCredential: true,
    });
    await repo.patch("prov-1", {}, { kind: "clear" });
    expect((await repo.getMutationContext("prov-1"))?.hasCredential).toBe(false);
  });

  it("deletes the row and tolerates deleting an absent one", async () => {
    await repo.insert("prov-1", writeFields(), { kind: "clear" });
    await repo.delete("prov-1");
    expect(await repo.getTarget("prov-1")).toBeNull();
    await expect(repo.delete("prov-1")).resolves.toBeUndefined();
  });
});
