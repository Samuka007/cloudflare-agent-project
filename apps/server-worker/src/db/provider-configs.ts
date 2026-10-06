import { decryptProviderSecret, encryptProviderSecret } from "@cap/provider-app";

/**
 * The capability slice this module needs — structural, so routes pass their
 * full Env and the L1 rig can construct a deployment WITHOUT the master
 * secret (the master-key gate test) without dragging unrelated bindings in.
 */
export interface ProviderConfigEnv {
  DB: D1Database;
  PROVIDER_CONFIG_MASTER_KEY?: string;
}

/**
 * #362 provider_configs persistence (the user-face provider 正本). The row's
 * visible face is stored verbatim; the credential column is AES-GCM
 * ciphertext only (provider-app provider-config-crypto.ts) — no plaintext
 * key ever reaches this module, still less D1. The READ faces (list/single,
 * status + warnings) belong to the provider-app loader; this module owns
 * writes and the raw single-row reads the write routes need.
 */

interface ProviderConfigDbRow {
  id: string;
  display_name: string | null;
  base_url: string | null;
  api: string | null;
  service_tier: number | null;
  api_key_enc: string | null;
  models: string;
  created_at: number;
  updated_at: number;
}

export interface ProviderConfigWriteFields {
  displayName: string | null;
  baseUrl: string | null;
  api: string | null;
  serviceTier: boolean;
  /** Catalog-schema-validated entries, serialized for the JSON column. */
  models: unknown[];
}

/**
 * The encrypted column value, decrypted for wire use (test-connection).
 * Returns null when the row has no key or the master key is not configured.
 * The plaintext lives only in the caller's request scope.
 */
export async function readProviderConfigSecret(
  env: ProviderConfigEnv,
  id: string,
): Promise<string | null> {
  if (env.PROVIDER_CONFIG_MASTER_KEY === undefined || env.PROVIDER_CONFIG_MASTER_KEY === "") {
    return null;
  }
  const row = await env.DB.prepare("SELECT api_key_enc FROM provider_configs WHERE id = ?")
    .bind(id)
    .first<{ api_key_enc: string | null }>();
  if (row?.api_key_enc === null || row?.api_key_enc === undefined) return null;
  return decryptProviderSecret(env.PROVIDER_CONFIG_MASTER_KEY, row.api_key_enc);
}

/** The single-row wire target the test-connection probe builds from. */
export interface ProviderConfigTarget {
  baseUrl: string | null;
  api: string | null;
  models: unknown[];
}

export async function getProviderConfigTarget(
  env: ProviderConfigEnv,
  id: string,
): Promise<ProviderConfigTarget | null> {
  const row = await env.DB.prepare("SELECT base_url, api, models FROM provider_configs WHERE id = ?")
    .bind(id)
    .first<{ base_url: string | null; api: string | null; models: string }>();
  if (row === null) return null;
  let models: unknown = [];
  try {
    models = JSON.parse(row.models);
  } catch {
    models = [];
  }
  return {
    baseUrl: row.base_url,
    api: row.api,
    models: Array.isArray(models) ? models : [],
  };
}

/**
 * The write-gate read for PUT/PATCH (SEC-W5-003): the row's current baseUrl
 * plus whether a stored credential exists. The probe faces decrypt that
 * credential and put it on the wire toward the row's CURRENT baseUrl, so a
 * write that moves baseUrl while KEEPING the stored key would redirect the
 * key to a caller-chosen target — routes refuse that combination
 * (credential_reentry_required), forcing same-request re-entry or clear.
 */
export interface ProviderConfigMutationContext {
  baseUrl: string | null;
  hasCredential: boolean;
}

export async function getProviderConfigMutationContext(
  env: ProviderConfigEnv,
  id: string,
): Promise<ProviderConfigMutationContext | null> {
  const row = await env.DB.prepare(
    "SELECT base_url, api_key_enc IS NOT NULL AS has_credential FROM provider_configs WHERE id = ?",
  )
    .bind(id)
    .first<{ base_url: string | null; has_credential: number }>();
  if (row === null) return null;
  return { baseUrl: row.base_url, hasCredential: row.has_credential === 1 };
}

/** Credential-set resolution shared by POST/PUT/PATCH (the null protocol). */
export type CredentialUpdate =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; plaintext: string };

export async function insertProviderConfig(
  env: ProviderConfigEnv,
  id: string,
  fields: ProviderConfigWriteFields,
  credential: CredentialUpdate,
): Promise<void> {
  const apiKeyEnc = await encryptedCredentialColumn(env, null, credential);
  await env.DB.prepare(
    `INSERT INTO provider_configs (id, display_name, base_url, api, service_tier, api_key_enc, models, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      fields.displayName,
      fields.baseUrl,
      fields.api,
      fields.serviceTier ? 1 : 0,
      apiKeyEnc,
      JSON.stringify(fields.models),
      Date.now(),
      Date.now(),
    )
    .run();
}

/** PUT semantics: the visible face is replaced wholesale, updated_at bumps. */
export async function replaceProviderConfig(
  env: ProviderConfigEnv,
  id: string,
  fields: ProviderConfigWriteFields,
  credential: CredentialUpdate,
): Promise<void> {
  const current = await env.DB.prepare("SELECT api_key_enc FROM provider_configs WHERE id = ?")
    .bind(id)
    .first<{ api_key_enc: string | null }>();
  if (current === null) return;
  const apiKeyEnc = await encryptedCredentialColumn(env, current.api_key_enc, credential);
  await env.DB.prepare(
    `UPDATE provider_configs SET display_name = ?, base_url = ?, api = ?, service_tier = ?, api_key_enc = ?, models = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      fields.displayName,
      fields.baseUrl,
      fields.api,
      fields.serviceTier ? 1 : 0,
      apiKeyEnc,
      JSON.stringify(fields.models),
      Date.now(),
      id,
    )
    .run();
}

export interface ProviderConfigPatchColumns {
  displayName?: string | null;
  baseUrl?: string | null;
  api?: string | null;
  serviceTier?: boolean;
  models?: unknown[];
}

/** PATCH semantics: only the provided columns move; the rest stays. */
export async function patchProviderConfig(
  env: ProviderConfigEnv,
  id: string,
  columns: ProviderConfigPatchColumns,
  credential: CredentialUpdate,
): Promise<void> {
  const current = await env.DB.prepare(
    "SELECT display_name, base_url, api, service_tier, api_key_enc, models FROM provider_configs WHERE id = ?",
  )
    .bind(id)
    .first<ProviderConfigDbRow>();
  if (current === null) return;
  const merged: ProviderConfigWriteFields = {
    displayName: columns.displayName === undefined ? current.display_name : columns.displayName,
    baseUrl: columns.baseUrl === undefined ? current.base_url : columns.baseUrl,
    api: columns.api === undefined ? current.api : columns.api,
    // `??` is exact here: the PATCH schema admits no null for these two
    // (only the string columns use the explicit-clear null protocol).
    serviceTier: columns.serviceTier ?? current.service_tier === 1,
    models: columns.models ?? safeParseModels(current.models),
  };
  const apiKeyEnc = await encryptedCredentialColumn(env, current.api_key_enc, credential);
  await env.DB.prepare(
    `UPDATE provider_configs SET display_name = ?, base_url = ?, api = ?, service_tier = ?, api_key_enc = ?, models = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      merged.displayName,
      merged.baseUrl,
      merged.api,
      merged.serviceTier ? 1 : 0,
      apiKeyEnc,
      JSON.stringify(merged.models),
      Date.now(),
      id,
    )
    .run();
}

export async function deleteProviderConfig(env: ProviderConfigEnv, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_configs WHERE id = ?").bind(id).run();
}

/** Resolve the next api_key_enc column value under the null protocol. */
async function encryptedCredentialColumn(
  env: ProviderConfigEnv,
  current: string | null,
  credential: CredentialUpdate,
): Promise<string | null> {
  if (credential.kind === "clear") return null;
  if (credential.kind === "keep") return current;
  if (env.PROVIDER_CONFIG_MASTER_KEY === undefined || env.PROVIDER_CONFIG_MASTER_KEY === "") {
    throw new Error("master_key_missing");
  }
  return encryptProviderSecret(env.PROVIDER_CONFIG_MASTER_KEY, credential.plaintext);
}

function safeParseModels(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
