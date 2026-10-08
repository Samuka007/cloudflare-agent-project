/**
 * #449 the web_search engine-chain persistence: the single-row D1 seat
 * (id = 'web_search', the image_source precedent) behind GET/PUT
 * /system/web-search. The row is the ONLY 正本 of the engine chain — the
 * `AGENT_DO_WEB_SEARCH` env path is deleted (#450 zero-env ruling): no row =
 * the ruled defaults, never an env override.
 *
 * Secret discipline mirrors provider_configs: the secret half (brave/exa
 * apiKey, searxng token/basic*) is AES-GCM encrypted into `secrets_enc` with
 * PROVIDER_CONFIG_MASTER_KEY and never read back; `secrets_meta` carries the
 * secret-PRESENCE map for the zero-secret read faces.
 */

import {
  encryptProviderSecret,
  type WebSearchSecretsMeta,
  type WebSearchStoredEngines,
  type WebSearchStoredSecrets,
} from "@cap/provider-app";

/** The capability slice this module needs (the provider-configs precedent). */
export interface WebSearchEnv {
  DB: D1Database;
  PROVIDER_CONFIG_MASTER_KEY?: string;
}

const WEB_SEARCH_ROW_ID = "web_search";

/** The full next state after a PUT (all tri-state fields already merged). */
export interface WebSearchWriteFields {
  chain: string[];
  timeoutSeconds: number;
  engines: WebSearchStoredEngines;
  secrets: WebSearchStoredSecrets;
  meta: WebSearchSecretsMeta;
}

/** True when at least one secret field is set (ciphertext required). */
export function webSearchHasSecrets(secrets: WebSearchStoredSecrets): boolean {
  return (
    secrets.brave?.apiKey !== undefined ||
    secrets.exa?.apiKey !== undefined ||
    secrets.searxng?.token !== undefined ||
    secrets.searxng?.basicUsername !== undefined ||
    secrets.searxng?.basicPassword !== undefined
  );
}

/** Upsert the seat row. `masterKey` is required when secrets are present. */
export async function setWebSearchConfig(
  env: WebSearchEnv,
  fields: WebSearchWriteFields,
  masterKey: string | undefined,
): Promise<void> {
  // DB-layer backstop (the provider_configs encryptedCredentialColumn rule):
  // a key-bearing write without the master secret is refused, never stored
  // in plaintext. The route pre-checks with the ApiError vocabulary; this
  // guards direct db-layer callers.
  let ciphertext: string | null = null;
  if (webSearchHasSecrets(fields.secrets)) {
    if (masterKey === undefined || masterKey === "") {
      throw new Error("master_key_missing");
    }
    ciphertext = await encryptProviderSecret(masterKey, JSON.stringify(fields.secrets));
  }
  await env.DB.prepare(
    `INSERT INTO ${WEB_SEARCH_ROW_ID} (id, chain, timeout_seconds, engines, secrets_enc, secrets_meta, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       chain = excluded.chain,
       timeout_seconds = excluded.timeout_seconds,
       engines = excluded.engines,
       secrets_enc = excluded.secrets_enc,
       secrets_meta = excluded.secrets_meta,
       updated_at = excluded.updated_at`,
  )
    .bind(
      WEB_SEARCH_ROW_ID,
      JSON.stringify(fields.chain),
      fields.timeoutSeconds,
      JSON.stringify(fields.engines),
      ciphertext,
      JSON.stringify(fields.meta),
      Date.now(),
    )
    .run();
}
