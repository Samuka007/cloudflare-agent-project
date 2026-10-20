import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

/**
 * Control-plane D1 schema — the drizzle-era single source (W6 db campaign,
 * #591 spec / #593 design-it-twice ruling 2026-10-20: design B skeleton).
 *
 * Contract phase (T9, #601): this schema IS the control plane. It applies to
 * its own D1 database (`cap-control-plane-v2`, binding DB_V2) through the
 * drizzle ledger (`drizzle/` + `wrangler d1 migrations apply`, CI deploy
 * hook). The legacy 14-file replay chain and the hand-written db layer are
 * deleted; the old cap-control-plane database's tables are torn down by the
 * deploy chain's DROP block.
 *
 * Rulings encoded here (see the #591 comment for the full record):
 * - 18 legacy tables → 10 + `system_experiments` kept as an open k/v table
 *   (experiments are an open set: type safety lives in the zod face, not the
 *   column — closed columns would force an ALTER per new experiment).
 * - The nine single-row seat tables (app_settings/app_theme/web_search/
 *   tool_capabilities/origin_allowlist/permission_mode/compaction_settings/
 *   image_source …) collapse into `settings_app` (request-path domain) +
 *   `settings_agent` (turn/dispatch domain, permissionMode included — same
 *   read-cadence principle). NULL column = "not configured"; the row is
 *   created lazily on first write. CHECK(id) pins each row to its singleton.
 * - `pending_interactions` (mirror table) is not ported: threads carry
 *   (pending_since, pending_fold_seq), pushed by the AgentDO fold loop with a
 *   monotonic seq CAS (out-of-order retries cannot resurrect stale flips —
 *   same discipline as thread_tabs.revision).
 * - `host_daemon_sessions` (#590 orphan, zero query sites) is not ported.
 * - FKs are declared at birth: environments.projectId / project_sources
 *   .projectId / thread_tabs.threadId cascade with their owner;
 *   threads.environmentId / sectionId / parent/source SET NULL on unbind;
 *   host references deliberately DON'T cascade — a host is only ever
 *   tombstoned (destroyed_at), never hard-deleted; orchestration owns any
 *   explicit cleanup. threads.providerId deliberately has no FK: the config
 *   row may go away while the thread (and its journal) must survive.
 * - JSON cells are plain text on purpose (drizzle json-mode would parse at the
 *   driver and turn the skip-with-warning discipline for a corrupt cell into a
 *   read-time crash): models, keybinding_overrides, origin_allowlist,
 *   compaction_method_order, web_search chain/engines.
 * - Timestamps are INTEGER ms-epoch everywhere except
 *   onboarding_completed_at, which keeps its legacy ISO-text shape (wire
 *   compatibility ruling).
 *
 * Maintenance contract: drizzle-kit owns every DDL byte. Change this file,
 * then `pnpm --filter @cap/server-worker db:generate` — never hand-edit
 * `drizzle/*.sql` DDL or the meta/ snapshots. Seeds are data, not DDL: they
 * ride a ledger-tracked custom migration (`drizzle/0001_*`) with insert-or-
 * ignore semantics, per the #591 ruling.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────
// Same value sets as the zod faces in src/contract/domain (permissionMode =
// shared-types, originKind = thread-origin-kind, …) but literalized here: the
// schema must bundle standalone under drizzle-kit without pulling the domain
// barrel in. The repo layer `$type<>`s these back onto the domain unions.
const threadStatusValues = ["idle", "starting", "active", "stopping", "error"] as const;
const threadVisibilityValues = ["visible", "hidden"] as const;
const threadOriginKindValues = ["fork"] as const;
const projectKindValues = ["standard", "personal"] as const;
const hostTypeValues = ["persistent", "placeholder"] as const;
const permissionModeValues = ["accept-edits", "auto", "full"] as const;
const environmentStatusValues = [
  "provisioning",
  "ready",
  "retiring",
  "error",
  "destroying",
  "destroyed",
] as const;
const workspaceProvisionTypeValues = ["unmanaged", "managed-worktree", "personal"] as const;

// ─── Projects aggregate (projects + project_sources) ────────────────────────
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: projectKindValues }).notNull().default("standard"),
    name: text("name").notNull(),
    gitRemoteUrl: text("git_remote_url"),
    sortKey: text("sort_key").notNull().default("V"),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("projects_updated_idx").on(t.updatedAt),
    index("projects_deleted_idx").on(t.deletedAt),
    index("projects_sort_idx").on(t.sortKey, t.id),
    // The personal singleton (seeded by the ledger migration): the partial
    // unique index is both the bb-parity invariant and the seed's idempotency
    // anchor (the insert-or-ignore seed rides it).
    uniqueIndex("projects_personal_singleton_idx")
      .on(t.kind)
      .where(sql`${t.kind} = 'personal'`),
  ],
);

// Sub-entity of Projects: lifecycle cascades with the project; the
// first-source-is-default / delete-default-promotes-earliest invariants are
// aggregate-internal protocol (repo layer, T3+).
export const projectSources = sqliteTable(
  "project_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    // $type<> is compile-time only (no DDL bytes, no ledger migration): the
    // repo layer types vocabulary columns back onto the domain unions (header).
    type: text("type").$type<"local_path">().notNull().default("local_path"),
    // No cascade: hosts are tombstoned, never hard-deleted (see header).
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    path: text("path").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("project_sources_project_host_idx").on(t.projectId, t.hostId)],
);

// ─── Hosts aggregate ─────────────────────────────────────────────────────────
// host_daemon_sessions is deliberately absent: #590 removed its only query
// sites; the table was an orphan by the time this schema was cut.
export const hosts = sqliteTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type", { enum: hostTypeValues }).notNull(),
    connectMachineId: text("connect_machine_id"),
    maxPermissionMode: text("max_permission_mode", { enum: permissionModeValues })
      .notNull()
      .default("full"),
    destroyedAt: integer("destroyed_at"),
    lastSeenAt: integer("last_seen_at"),
    lastRejectedProtocolVersion: integer("last_rejected_protocol_version"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("hosts_last_seen_idx").on(t.lastSeenAt)],
);

// ─── ThreadSections aggregate (standalone dictionary) ───────────────────────
// threads.sectionId SET NULLs on delete — unbinding is the database's job, no
// application-side sweep needed.
export const threadSections = sqliteTable(
  "thread_sections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("thread_sections_name_idx").on(t.name)],
);

// ─── Threads aggregate (threads + thread_tabs + pending push-write) ─────────
export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Greenfield FK the legacy chain could never ALTER into existence: a
    // destroyed environment unbinds its threads (SET NULL), which fall back to
    // the deployment-default binding.
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    // Deliberately no FK: provider_configs rows may be deleted while the
    // thread row (and its DO journal) must survive.
    providerId: text("provider_id").notNull(),
    modelOverride: text("model_override"),
    reasoningLevelOverride: text("reasoning_level_override"),
    title: text("title"),
    titleFallback: text("title_fallback"),
    sectionId: text("section_id").references(() => threadSections.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: threadStatusValues }).notNull().default("starting"),
    parentThreadId: text("parent_thread_id").references((): AnySQLiteColumn => threads.id, {
      onDelete: "set null",
    }),
    sourceThreadId: text("source_thread_id").references((): AnySQLiteColumn => threads.id, {
      onDelete: "set null",
    }),
    originKind: text("origin_kind", { enum: threadOriginKindValues }),
    originPluginId: text("origin_plugin_id"),
    visibility: text("visibility", { enum: threadVisibilityValues }).notNull().default("visible"),
    // ── pending badge fields (the pending_interactions mirror table's grave
    //    marker). pendingSince = createdAt of the earliest unresolved
    //    interaction; NULL = nothing pending (badge off, age signal on).
    //    pendingFoldSeq = the AgentDO journal seq the current values were
    //    folded from; the push-write is a monotonic CAS on it, so a late
    //    out-of-order retry lands nowhere.
    pendingSince: integer("pending_since"),
    pendingFoldSeq: integer("pending_fold_seq").notNull().default(0),
    archivedAt: integer("archived_at"),
    pinnedAt: integer("pinned_at"),
    pinSortKey: text("pin_sort_key"),
    deletedAt: integer("deleted_at"),
    lastReadAt: integer("last_read_at"),
    latestAttentionAt: integer("latest_attention_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("threads_project_updated_idx").on(t.projectId, t.updatedAt),
    index("threads_project_archived_deleted_idx").on(t.projectId, t.archivedAt, t.deletedAt, t.id),
    // The pinned block's sort key is CASE-scoped (#337 ruling): the partial
    // index only covers pinned rows.
    index("threads_pin_sort_idx")
      .on(t.archivedAt, t.deletedAt, t.pinSortKey, t.id)
      .where(sql`${t.pinnedAt} IS NOT NULL`),
    // bb parity: the port was missing the environment lookup index.
    index("threads_environment_idx").on(t.environmentId),
    index("threads_parent_idx").on(t.parentThreadId),
    index("threads_source_origin_idx").on(t.sourceThreadId, t.originKind),
    index("threads_section_archived_deleted_idx").on(t.sectionId, t.archivedAt, t.deletedAt, t.id),
    index("threads_archived_status_idx").on(t.archivedAt, t.status),
  ],
);

export const threadTabs = sqliteTable("thread_tabs", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  // Plain text on purpose: the repo parses and the face owns corrupt-cell
  // policy (see header — json-mode would crash at the driver).
  tabsJson: text("tabs_json").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ─── Environments aggregate ──────────────────────────────────────────────────
export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // No cascade: the host row only ever tombstones (see header); the list
    // face hides tombstoned hosts at query time (#445 ruling).
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    path: text("path"),
    managed: integer("managed", { mode: "boolean" }).notNull().default(false),
    isGitRepo: integer("is_git_repo", { mode: "boolean" }).notNull().default(false),
    isWorktree: integer("is_worktree", { mode: "boolean" }).notNull().default(false),
    branchName: text("branch_name"),
    baseBranch: text("base_branch"),
    defaultBranch: text("default_branch"),
    mergeBaseBranch: text("merge_base_branch"),
    destroyAttemptId: text("destroy_attempt_id"),
    // Durable product-policy clock: unlike updated_at, metadata polling must
    // not move the accidental-archive recovery window (bb anchor).
    retireRequestedAt: integer("retire_requested_at"),
    workspaceProvisionType: text("workspace_provision_type", {
      enum: workspaceProvisionTypeValues,
    }).notNull(),
    status: text("status", { enum: environmentStatusValues }).notNull().default("provisioning"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // A workspace path is claimed per project, not globally: two projects may
    // point at the same folder and each gets its own environment (bb note).
    uniqueIndex("environments_project_host_path_idx").on(t.projectId, t.hostId, t.path),
    index("environments_host_path_lookup_idx").on(t.hostId, t.path),
    index("environments_project_idx").on(t.projectId),
    index("environments_status_idx").on(t.status),
  ],
);

// ─── ProviderConfigs aggregate (encrypted-column shapes preserved) ───────────
export const providerConfigs = sqliteTable("provider_configs", {
  id: text("id").primaryKey(),
  displayName: text("display_name"),
  baseUrl: text("base_url"),
  // Declared API family (e.g. 'anthropic-messages', 'openai-responses').
  api: text("api"),
  serviceTier: integer("service_tier", { mode: "boolean" }).notNull().default(false),
  // AES-256-GCM ciphertext, base64(iv[12] || ct+tag), keyed by the
  // PROVIDER_CONFIG_MASTER_KEY secret. Never leaves the repo boundary in
  // projections; faces carry hasApiKey booleans only.
  apiKeyEnc: text("api_key_enc"),
  // Plain text on purpose: a corrupt models JSON must ride the CRUD face
  // unrepaired (skip-with-warning), not crash at the driver (see header).
  models: text("models").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ─── Settings aggregate: the nine seat tables collapse into two rows ─────────
// settings_app: the request-path domain (SPA bootstrap + per-request
// middleware). Missing row = every domain unconfigured (defaults) — the
// absent-row postures of the nine legacy seats, preserved one for one.
// The row is created lazily by the first write; CHECK(id) makes "two app
// rows" unrepresentable.
export const settingsApp = sqliteTable(
  "settings_app",
  {
    id: text("id").primaryKey(), // always 'app'
    // app_settings booleans
    caffeinate: integer("caffeinate", { mode: "boolean" }).notNull().default(false),
    showKeyboardHints: integer("show_keyboard_hints", { mode: "boolean" }).notNull().default(true),
    steerActiveThreadOnEnter: integer("steer_active_thread_on_enter", { mode: "boolean" })
      .notNull()
      .default(false),
    showUnhandledProviderEvents: integer("show_unhandled_provider_events", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    codexMemoryEnabled: integer("codex_memory_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    claudeCodeMemoryEnabled: integer("claude_code_memory_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    codexSubagentsDisabled: integer("codex_subagents_disabled", { mode: "boolean" })
      .notNull()
      .default(false),
    claudeCodeSubagentsDisabled: integer("claude_code_subagents_disabled", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    claudeCodeWorkflowsDisabled: integer("claude_code_workflows_disabled", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    keybindingOverrides: text("keybinding_overrides").notNull().default("[]"),
    // Legacy shape kept: ISO text, not ms-epoch (wire-compat ruling).
    onboardingCompletedAt: text("onboarding_completed_at"),
    // app_theme
    themeId: text("theme_id"),
    faviconColor: text("favicon_color"),
    // origin_allowlist (fail-closed decode lives in the repo/face layer).
    originAllowlist: text("origin_allowlist").notNull().default("[]"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [check("settings_app_singleton_check", sql`${t.id} = 'app'`)],
);

// settings_agent: the turn/dispatch-path domain (read in one batch at turn
// boundaries, hot-applied behind content fingerprints). Nullable column =
// that domain is unconfigured (legacy absent-seat semantics); the row is
// created lazily on first write.
export const settingsAgent = sqliteTable(
  "settings_agent",
  {
    id: text("id").primaryKey(), // always 'agent'
    // permission_mode: NULL = the ruled default 'full', never written.
    permissionMode: text("permission_mode", { enum: permissionModeValues }),
    // tool_capabilities: all NULL = the unconfigured omp posture (families
    // off); the write face is a three-boolean wholesale replace.
    externalThinking: integer("external_thinking", { mode: "boolean" }),
    contextNotes: integer("context_notes", { mode: "boolean" }),
    checkpoint: integer("checkpoint", { mode: "boolean" }),
    // compaction_settings: JSON-array text; NULL remote columns = the remote
    // mode is ineligible.
    compactionMethodOrder: text("compaction_method_order"),
    compactionRemoteProviderId: text("compaction_remote_provider_id"),
    compactionRemoteModel: text("compaction_remote_model"),
    // image_source
    imageSourceProviderId: text("image_source_provider_id"),
    // web_search (encrypted shapes preserved; JSON cells plain text — see
    // header).
    webSearchChain: text("web_search_chain"),
    webSearchTimeoutSeconds: integer("web_search_timeout_seconds"),
    webSearchEngines: text("web_search_engines"),
    webSearchSecretsEnc: text("web_search_secrets_enc"),
    webSearchSecretsMeta: text("web_search_secrets_meta"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [check("settings_agent_singleton_check", sql`${t.id} = 'agent'`)],
);

// ─── Experiments (open-set k/v, kept per the #591 ruling) ────────────────────
// The key set is the zod face's open registry (contract/domain/experiments.ts
// experimentKeys): adding an experiment is a face edit, NOT a schema migration.
// `value` is deliberately a bare integer — type safety lives in the zod face,
// not the column (closed columns would force an ALTER per experiment).
export const systemExperiments = sqliteTable("system_experiments", {
  key: text("key").primaryKey(),
  value: integer("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
