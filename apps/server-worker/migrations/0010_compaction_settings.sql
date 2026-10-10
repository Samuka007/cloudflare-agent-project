-- #547 the compaction-settings 正本: the D1 seat behind GET/PUT
-- /system/compaction-settings (the tool_capabilities/permission_mode
-- single-row precedent). One row (id = 'compaction_settings') carries the
-- deployment's compact preference:
--
--   method_order      JSON array of the omp compact modes the port ships
--                     ("soft" | "remote" | "snap"), first entry tried first
--                     (omp DEFAULT_COMPACTION_METHOD_ORDER semantics; the
--                     absent-row default is ["remote","snap","soft"]).
--   remote_provider_id / remote_model
--                     the delegated summarizer the `remote` mode pins (omp
--                     RemoteCompactionConfig analog: the endpoint IS the
--                     row's existing relay channel config, so only the
--                     model selection is named here). NULL columns = the
--                     remote mode is ineligible; the modeless compact face
--                     walks the order and skips it.
--
-- The row is ABSENT until an operator writes the face — the absent-row
-- posture is the omp default order with remote ineligible. Idempotent by
-- the #295 replay contract (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS compaction_settings (
  id TEXT PRIMARY KEY NOT NULL,
  method_order TEXT NOT NULL,
  remote_provider_id TEXT,
  remote_model TEXT,
  updated_at INTEGER NOT NULL
);
