-- #362/#450 provider configurable panel: the user-face provider
-- configuration 正本 (D1) — and since #450 the SOLE directory source (the
-- env MODEL_RELAY_CATALOG / MODEL_RELAY_PROVIDER_CREDENTIALS pair is
-- retired; provider-config-points.md §2). The CRUD API
-- (/api/v1/system/providers) writes this table, and every read face
-- projects these rows.
--
-- Secret discipline: api_key_enc is AES-256-GCM ciphertext
-- (base64(iv[12] || ct+tag), provider-app provider-config-crypto.ts) keyed
-- by the PROVIDER_CONFIG_MASTER_KEY Worker secret. No plaintext key column
-- exists anywhere; projection faces carry hasApiKey booleans only.
--
-- Idempotent by the #295 replay contract (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS provider_configs (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT,
  base_url TEXT,
  -- Declared API family (e.g. 'anthropic-messages', 'openai-responses') —
  -- dictionary parity with the #350 catalog provider entry; wire family
  -- selection is #361's adaptor surface, this column is the declaration.
  api TEXT,
  service_tier INTEGER NOT NULL DEFAULT 0,
  api_key_enc TEXT,
  -- JSON array of catalog model entries, validated against the
  -- relayCatalogModelSchema (packages/agent-do provider-catalog.ts).
  -- Invalid JSON decodes to a loud warning and the row rides the CRUD face
  -- unrepaired (skip-with-warning, never deleted).
  models TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
