-- #506 the browser-origin allowlist 正本: the single-row D1 seat (id =
-- 'origin_allowlist', the image_source/web_search/tool_capabilities
-- single-row precedent) behind GET/PUT /system/origin-allowlist. `origins`
-- is a JSON array of strict http(s) browser origins — the extra origins the
-- Origin guard / CORS leg accept beyond the request-target derivation. The
-- row is ABSENT until an operator adds one, and the absent-row posture is
-- the ruled default: zero extra origins (plain same-origin behavior). The
-- APP_EXTRA_ORIGINS env input is deleted (#506 zero-env ruling): D1 is the
-- only 正本, so a face write hot-applies on the next Origin-carrying request
-- without a redeploy.
--
-- Idempotent by the #295 replay contract (CREATE ... IF NOT EXISTS).
-- Note: the #497 census wording "app_settings 单行" lands as its own seat
-- table because the replay contract forbids ALTER TABLE ADD COLUMN (SQLite
-- has no conditional DDL, and docs/ops/staging-d1-migrations.md 幂等契约
-- requires every statement to survive full replay); the #448/#449/#502
-- seats took the same shape for the same reason.

CREATE TABLE IF NOT EXISTS origin_allowlist (
  id TEXT PRIMARY KEY NOT NULL,
  origins TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
