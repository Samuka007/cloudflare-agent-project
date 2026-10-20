/**
 * ProviderConfigs aggregate repository (#596, W6 db campaign T4).
 *
 * The `provider_configs` rows are the user-face provider 正本 (#362): the
 * visible face is stored verbatim; the credential column is AES-256-GCM
 * ciphertext only (provider-app provider-config-crypto.ts keyed by the
 * PROVIDER_CONFIG_MASTER_KEY secret) — no plaintext key ever reaches this
 * module, still less D1. The encrypted column shape is preserved exactly
 * (`api_key_enc`, base64(iv‖ct+tag)); encryption/decryption never crosses
 * this seam (the #591 ruling): callers speak `CredentialUpdate`
 * (keep/clear/set-plaintext) and read decrypted strings or presence
 * booleans, never ciphertext.
 *
 * Semantics are the legacy `src/db/provider-configs.ts` module verbatim (the
 * compat suites pin them as the behavior oracle): PUT replaces the visible
 * face wholesale, PATCH moves only the provided columns, `keep` preserves
 * the stored ciphertext, `clear` nulls it, `set` requires the master key.
 * The READ faces (list/single projections, status + warnings) belong to the
 * provider-app loader; this seam owns writes and the single-row reads the
 * write routes need.
 *
 * The legacy module itself stays untouched until the contract-retirement
 * ticket (#601) deletes it with the old tables; this repository serves the
 * drizzle-era database (DB_V2) beside it.
 */

import { eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { decryptProviderSecret, encryptProviderSecret } from "@cap/provider-app";
import { providerConfigs } from "../schema";

// ─── Faces ───────────────────────────────────────────────────────────────────

/** The visible-face write payload shared by POST/PUT. */
export interface ProviderConfigWriteFields {
  displayName: string | null;
  baseUrl: string | null;
  api: string | null;
  serviceTier: boolean;
  /** Catalog-schema-validated entries, serialized for the JSON column. */
  models: unknown[];
}

/** Credential-set resolution shared by POST/PUT/PATCH (the null protocol). */
export type CredentialUpdate =
  { kind: "keep" } | { kind: "clear" } | { kind: "set"; plaintext: string };

/** PATCH semantics: only the provided columns move; the rest stays. */
export interface ProviderConfigPatchColumns {
  displayName?: string | null;
  baseUrl?: string | null;
  api?: string | null;
  serviceTier?: boolean;
  models?: unknown[];
}

/** The single-row wire target the test-connection probe builds from. */
export interface ProviderConfigTarget {
  baseUrl: string | null;
  api: string | null;
  models: unknown[];
}

/** The write-gate read for PUT/PATCH (SEC-W5-003). */
export interface ProviderConfigMutationContext {
  baseUrl: string | null;
  hasCredential: boolean;
  /** #485 the stored api seat — PATCH resolves the model family from it. */
  api: string | null;
}

/**
 * One stored row in seam-neutral shape (the T6 route faces' list read): the
 * models JSON stays RAW text (a corrupt cell rides the CRUD face unrepaired —
 * skip-with-warning), and the credential crosses as PRESENCE only — zero
 * ciphertext leaves this seam.
 */
export interface ProviderConfigStoredRow {
  id: string;
  displayName: string | null;
  baseUrl: string | null;
  api: string | null;
  serviceTier: boolean;
  hasCredential: boolean;
  models: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * The snapshot-feed row (#600 wiring): identical to {@link ProviderConfigStoredRow}
 * but CIPHER-BEARING — the dispatch/overlay half decrypts api_key_enc downstream
 * (provider-app assembly), so the ciphertext crosses this seam by design. Never
 * serve this on a CRUD/display face.
 */
export interface ProviderConfigCipherRow {
  id: string;
  displayName: string | null;
  baseUrl: string | null;
  api: string | null;
  serviceTier: boolean;
  apiKeyEnc: string | null;
  models: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface ProviderConfigsRepository {
  /** Create the row; a duplicate id throws (legacy INSERT parity). */
  insert(
    id: string,
    fields: ProviderConfigWriteFields,
    credential: CredentialUpdate,
  ): Promise<void>;
  /** PUT semantics: the visible face is replaced wholesale; no-op when the row is absent. */
  replace(
    id: string,
    fields: ProviderConfigWriteFields,
    credential: CredentialUpdate,
  ): Promise<void>;
  /** PATCH semantics: only the provided columns move; no-op when the row is absent. */
  patch(
    id: string,
    columns: ProviderConfigPatchColumns,
    credential: CredentialUpdate,
  ): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Every stored row in (id) order — the CRUD display face's input (legacy
   * `SELECT … FROM provider_configs ORDER BY id` parity). Zero ciphertext:
   * `hasCredential` presence only.
   */
  list(): Promise<ProviderConfigStoredRow[]>;
  /** The snapshot feed (#591 agent-snapshot): cipher included, display faces need not apply. */
  listWithCipher(): Promise<ProviderConfigCipherRow[]>;
  /**
   * The stored credential, decrypted for wire use (test-connection). Null
   * when the row has no key or the master key is not configured. The
   * plaintext lives only in the caller's request scope.
   */
  readSecret(id: string): Promise<string | null>;
  /** The probe target: baseUrl/api plus the models JSON safe-parsed. */
  getTarget(id: string): Promise<ProviderConfigTarget | null>;
  /**
   * The write-gate read (SEC-W5-003): the row's current baseUrl/api plus
   * whether a stored credential exists. A write that moves baseUrl while
   * KEEPING the stored key would redirect the key to a caller-chosen target
   * — routes refuse that combination (credential_reentry_required).
   */
  getMutationContext(id: string): Promise<ProviderConfigMutationContext | null>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/** Safe-parse the models JSON cell: garbage degrades to [] (skip-with-warning shape). */
function safeParseModels(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildProviderConfigsRepository(
  db: DrizzleD1Database,
  masterKey: string | undefined,
): ProviderConfigsRepository {
  /** Resolve the next api_key_enc column value under the null protocol. */
  async function encryptedCredentialColumn(
    current: string | null,
    credential: CredentialUpdate,
  ): Promise<string | null> {
    if (credential.kind === "clear") return null;
    if (credential.kind === "keep") return current;
    if (masterKey === undefined || masterKey === "") {
      throw new Error("master_key_missing");
    }
    return encryptProviderSecret(masterKey, credential.plaintext);
  }

  return {
    async insert(id, fields, credential): Promise<void> {
      const apiKeyEnc = await encryptedCredentialColumn(null, credential);
      const now = Date.now();
      await db
        .insert(providerConfigs)
        .values({
          id,
          displayName: fields.displayName,
          baseUrl: fields.baseUrl,
          api: fields.api,
          serviceTier: fields.serviceTier,
          apiKeyEnc,
          models: JSON.stringify(fields.models),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    },

    async replace(id, fields, credential): Promise<void> {
      const rows = await db
        .select({ apiKeyEnc: providerConfigs.apiKeyEnc })
        .from(providerConfigs)
        .where(eq(providerConfigs.id, id))
        .limit(1);
      const current = rows[0];
      if (current === undefined) return;
      const apiKeyEnc = await encryptedCredentialColumn(current.apiKeyEnc, credential);
      await db
        .update(providerConfigs)
        .set({
          displayName: fields.displayName,
          baseUrl: fields.baseUrl,
          api: fields.api,
          serviceTier: fields.serviceTier,
          apiKeyEnc,
          models: JSON.stringify(fields.models),
          updatedAt: Date.now(),
        })
        .where(eq(providerConfigs.id, id))
        .run();
    },

    async patch(id, columns, credential): Promise<void> {
      const rows = await db
        .select()
        .from(providerConfigs)
        .where(eq(providerConfigs.id, id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return;
      const merged: ProviderConfigWriteFields = {
        displayName: columns.displayName === undefined ? row.displayName : columns.displayName,
        baseUrl: columns.baseUrl === undefined ? row.baseUrl : columns.baseUrl,
        api: columns.api === undefined ? row.api : columns.api,
        // `??` is exact here: the PATCH schema admits no null for these two
        // (only the string columns use the explicit-clear null protocol).
        serviceTier: columns.serviceTier ?? row.serviceTier,
        models: columns.models ?? safeParseModels(row.models),
      };
      const apiKeyEnc = await encryptedCredentialColumn(row.apiKeyEnc, credential);
      await db
        .update(providerConfigs)
        .set({
          displayName: merged.displayName,
          baseUrl: merged.baseUrl,
          api: merged.api,
          serviceTier: merged.serviceTier,
          apiKeyEnc,
          models: JSON.stringify(merged.models),
          updatedAt: Date.now(),
        })
        .where(eq(providerConfigs.id, id))
        .run();
    },

    async delete(id): Promise<void> {
      await db.delete(providerConfigs).where(eq(providerConfigs.id, id)).run();
    },

    async list(): Promise<ProviderConfigStoredRow[]> {
      const rows = await db.select().from(providerConfigs).orderBy(providerConfigs.id).all();
      return rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        baseUrl: row.baseUrl,
        api: row.api,
        serviceTier: row.serviceTier,
        hasCredential: row.apiKeyEnc !== null,
        models: row.models,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },

    async listWithCipher() {
      const rows = await db.select().from(providerConfigs).orderBy(providerConfigs.id).all();
      return rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        baseUrl: row.baseUrl,
        api: row.api,
        serviceTier: row.serviceTier,
        apiKeyEnc: row.apiKeyEnc,
        models: row.models,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },

    async readSecret(id): Promise<string | null> {
      if (masterKey === undefined || masterKey === "") {
        return null;
      }
      const rows = await db
        .select({ apiKeyEnc: providerConfigs.apiKeyEnc })
        .from(providerConfigs)
        .where(eq(providerConfigs.id, id))
        .limit(1);
      const row = rows[0];
      if (row?.apiKeyEnc == null) return null;
      return decryptProviderSecret(masterKey, row.apiKeyEnc);
    },

    async getTarget(id): Promise<ProviderConfigTarget | null> {
      const rows = await db
        .select({
          baseUrl: providerConfigs.baseUrl,
          api: providerConfigs.api,
          models: providerConfigs.models,
        })
        .from(providerConfigs)
        .where(eq(providerConfigs.id, id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        baseUrl: row.baseUrl,
        api: row.api,
        models: safeParseModels(row.models),
      };
    },

    async getMutationContext(id): Promise<ProviderConfigMutationContext | null> {
      const rows = await db
        .select({
          baseUrl: providerConfigs.baseUrl,
          api: providerConfigs.api,
          apiKeyEnc: providerConfigs.apiKeyEnc,
        })
        .from(providerConfigs)
        .where(eq(providerConfigs.id, id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        baseUrl: row.baseUrl,
        api: row.api,
        hasCredential: row.apiKeyEnc !== null,
      };
    },
  };
}

/**
 * The factory: drizzle stays inside; callers get the interface only.
 * `masterKey` is the PROVIDER_CONFIG_MASTER_KEY secret, exactly like the
 * legacy module took it.
 */
export function createProviderConfigsRepository(
  db: D1Database,
  masterKey?: string,
): ProviderConfigsRepository {
  return buildProviderConfigsRepository(drizzle(db), masterKey);
}
