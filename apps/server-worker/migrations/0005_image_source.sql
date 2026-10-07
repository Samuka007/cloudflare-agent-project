-- #448 the generate_image source 正本: the panel's explicit 产图源 seat.
-- A single row (id = 'image_source', the app_theme single-row precedent)
-- names the api=openai-images provider_configs row that supplies
-- generate_image; provider_id NULL = no source (the tool is unavailable —
-- no env fallback, #450 zero-env ruling: D1 is the only 正本).
--
-- Idempotent by the #295 replay contract (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS image_source (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT,
  updated_at INTEGER NOT NULL
);
