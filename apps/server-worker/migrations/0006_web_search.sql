-- #449 the web_search engine-chain 正本: single row (id = 'web_search', the
-- image_source/app_theme precedent). `chain` is the ordered engine-id JSON
-- array; `timeout_seconds` the per-transport ceiling; `engines` the non-
-- secret engine settings JSON (searxng endpoint/categories/language/
-- safesearch); `secrets_enc` the AES-GCM JSON of the secret half (brave
-- apiKey, searxng token/basic*) with `secrets_meta` carrying the secret-
-- PRESENCE map for the zero-secret read faces. No row = ruled defaults —
-- there is NO env fallback (#450 zero-env ruling; #449 deletes the
-- AGENT_DO_WEB_SEARCH env path).
--
-- Idempotent by the #295 replay contract (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS web_search (
  id TEXT PRIMARY KEY NOT NULL,
  chain TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL DEFAULT 60,
  engines TEXT,
  secrets_enc TEXT,
  secrets_meta TEXT,
  updated_at INTEGER NOT NULL
);
