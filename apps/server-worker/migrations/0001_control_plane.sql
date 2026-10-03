-- M0 control-plane subset (ticket #26, ruling #6): everything EXCEPT the
-- per-thread event log (owned by the agent DO, ticket #29). Column sets mirror
-- bb packages/db/src/schema.ts at commit 8473d8c33 (SQLite dialect, so
-- drizzle-era definitions port directly). OUT-of-M0-family tables that later
-- milestones need for joins (host_daemon_sessions, pending_interactions) are
-- created here so the ported queries stay single-dialect.

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL DEFAULT 'standard',
  name TEXT NOT NULL,
  git_remote_url TEXT,
  sort_key TEXT NOT NULL DEFAULT 'V',
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX projects_updated_idx ON projects (updated_at);
CREATE INDEX projects_deleted_idx ON projects (deleted_at);
CREATE INDEX projects_sort_idx ON projects (sort_key, id);
CREATE UNIQUE INDEX projects_personal_singleton_idx ON projects (kind) WHERE kind = 'personal';

-- bb requires the personal singleton to exist (sidebar bootstrap 500s
-- otherwise); seed it like bb's provisioning does.
INSERT INTO projects (id, kind, name, git_remote_url, sort_key, deleted_at, created_at, updated_at)
VALUES ('proj_personal', 'personal', 'Personal', NULL, 'V', NULL, strftime('%s','now') * 1000, strftime('%s','now') * 1000);

CREATE TABLE hosts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  connect_machine_id TEXT,
  max_permission_mode TEXT NOT NULL DEFAULT 'full',
  destroyed_at INTEGER,
  last_seen_at INTEGER,
  last_rejected_protocol_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX hosts_last_seen_idx ON hosts (last_seen_at);

CREATE TABLE host_daemon_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  host_type TEXT NOT NULL,
  data_dir TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  heartbeat_interval_ms INTEGER NOT NULL,
  lease_timeout_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX host_daemon_sessions_host_status_idx ON host_daemon_sessions (host_id, status);
CREATE INDEX host_daemon_sessions_host_latest_idx ON host_daemon_sessions (host_id, updated_at, created_at, id);
CREATE INDEX host_daemon_sessions_closed_prune_idx ON host_daemon_sessions (status, closed_at, id);

CREATE TABLE thread_sections (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX thread_sections_name_idx ON thread_sections (name);

CREATE TABLE threads (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment_id TEXT,
  provider_id TEXT NOT NULL,
  model_override TEXT,
  reasoning_level_override TEXT,
  title TEXT,
  title_fallback TEXT,
  section_id TEXT REFERENCES thread_sections (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'starting',
  parent_thread_id TEXT REFERENCES threads (id) ON DELETE SET NULL,
  source_thread_id TEXT REFERENCES threads (id) ON DELETE SET NULL,
  origin_kind TEXT,
  origin_plugin_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'visible',
  archived_at INTEGER,
  pinned_at INTEGER,
  pin_sort_key TEXT,
  deleted_at INTEGER,
  last_read_at INTEGER,
  latest_attention_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX threads_project_updated_idx ON threads (project_id, updated_at);
CREATE INDEX threads_project_archived_deleted_idx ON threads (project_id, archived_at, deleted_at, id);
CREATE INDEX threads_pin_sort_idx ON threads (archived_at, deleted_at, pin_sort_key, id) WHERE pinned_at IS NOT NULL;
CREATE INDEX threads_parent_idx ON threads (parent_thread_id);
CREATE INDEX threads_source_origin_idx ON threads (source_thread_id, origin_kind);
CREATE INDEX threads_section_archived_deleted_idx ON threads (section_id, archived_at, deleted_at, id);
CREATE INDEX threads_archived_status_idx ON threads (archived_at, status);

CREATE TABLE thread_tabs (
  thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  tabs_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE pending_interactions (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  origin_kind TEXT NOT NULL DEFAULT 'provider',
  turn_id TEXT,
  provider_id TEXT,
  provider_thread_id TEXT,
  provider_request_id TEXT,
  plugin_id TEXT,
  renderer_id TEXT,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  resolution TEXT,
  status_reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  resolved_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX pending_interactions_provider_request_idx ON pending_interactions (provider_id, provider_thread_id, provider_request_id);
CREATE INDEX pending_interactions_thread_created_idx ON pending_interactions (thread_id, created_at);
CREATE INDEX pending_interactions_thread_status_created_idx ON pending_interactions (thread_id, status, created_at);
CREATE INDEX pending_interactions_status_created_idx ON pending_interactions (status, created_at);

CREATE TABLE app_settings (
  id TEXT PRIMARY KEY NOT NULL,
  caffeinate INTEGER NOT NULL DEFAULT 0,
  show_keyboard_hints INTEGER NOT NULL DEFAULT 1,
  steer_active_thread_on_enter INTEGER NOT NULL DEFAULT 0,
  show_unhandled_provider_events INTEGER NOT NULL DEFAULT 0,
  codex_memory_enabled INTEGER NOT NULL DEFAULT 1,
  claude_code_memory_enabled INTEGER NOT NULL DEFAULT 1,
  codex_subagents_disabled INTEGER NOT NULL DEFAULT 0,
  claude_code_subagents_disabled INTEGER NOT NULL DEFAULT 0,
  claude_code_workflows_disabled INTEGER NOT NULL DEFAULT 0,
  keybinding_overrides TEXT NOT NULL DEFAULT '[]',
  onboarding_completed_at TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE system_experiments (
  key TEXT PRIMARY KEY NOT NULL,
  value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE app_theme (
  id TEXT PRIMARY KEY NOT NULL,
  theme_id TEXT NOT NULL,
  favicon_color TEXT
);

CREATE TABLE project_sources (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  is_default INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'local_path',
  host_id TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
