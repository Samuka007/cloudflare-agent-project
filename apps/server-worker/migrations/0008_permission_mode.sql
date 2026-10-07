-- #500 the permission-mode default 正本: the D1 seat behind GET/PUT
-- /system/permission-mode. A single row (id = 'permission_mode', the
-- image_source/web_search/tool_capabilities single-row precedent) carries
-- the session permission posture (accept-edits | auto | full) that turns
-- without an explicit thread-level mode dispatch under. The row is ABSENT
-- until an operator writes it — and the absent-row posture is the ruled
-- default "full" (the retired deployment env scalar's default). The
-- deployment env input is deleted (#500 zero-env ruling): D1 is the sole
-- 正本, so a write hot-applies on the next turn (no redeploy).
--
-- Idempotent by the #295 replay contract (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS permission_mode (
  id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
