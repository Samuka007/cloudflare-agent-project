-- #288 (inventory #282 §2.A): the environments table — the binding unit of the
-- `threads → environments → (hosts × path)` chain (two-source map §1.1, bb
-- packages/db/src/schema.ts:485-536 at the pinned commit). Dialect is the same
-- SQLite subset as 0001: drizzle-era definitions port directly.
--
-- Producer: find-or-create at thread creation (services/thread-binding.ts);
-- reader: thread list/detail inlining + GET /environments. threads.environment_id
-- (0001) keeps no FK — the column predates this table, and SQLite cannot add an
-- FK by ALTER; integrity is app-level (resolution only stores ids it just read).

CREATE TABLE environments (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  path TEXT,
  managed INTEGER NOT NULL DEFAULT 0,
  is_git_repo INTEGER NOT NULL DEFAULT 0,
  is_worktree INTEGER NOT NULL DEFAULT 0,
  branch_name TEXT,
  base_branch TEXT,
  default_branch TEXT,
  merge_base_branch TEXT,
  destroy_attempt_id TEXT,
  -- Durable product-policy clock. Unlike updated_at, metadata polling cannot
  -- move the start of an accidental-archive recovery window (bb anchor).
  retire_requested_at INTEGER,
  workspace_provision_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A workspace path is claimed per project, not globally. Two projects may
-- point at the same folder; each gets its own environment for it (bb note).
CREATE UNIQUE INDEX environments_project_host_path_idx ON environments (project_id, host_id, path);
-- Host-leading lookups: every environment on a host, and every project's
-- environment for one physical directory (bb note).
CREATE INDEX environments_host_path_lookup_idx ON environments (host_id, path);
CREATE INDEX environments_project_idx ON environments (project_id);
CREATE INDEX environments_status_idx ON environments (status);
