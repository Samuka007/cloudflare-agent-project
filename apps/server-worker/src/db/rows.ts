/**
 * D1 helpers. bb's drizzle rows are camelCase objects; D1 returns snake_case
 * columns. Mappers here reproduce the bb row shapes exactly (column lists from
 * packages/db/src/schema.ts at commit 8473d8c33).
 */
export function nowMs(): number {
  return Date.now();
}

type Row = Record<string, unknown>;

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new TypeError(`column ${key} is not a number: ${String(value)}`);
  }
  return value;
}

function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : (value as number);
}

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new TypeError(`column ${key} is not a string: ${String(value)}`);
  }
  return value;
}

export function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : (value as string);
}

// --- projects -----------------------------------------------------------------

export interface ProjectRow {
  id: string;
  kind: "standard" | "personal";
  name: string;
  gitRemoteUrl: string | null;
  sortKey: string;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function toProjectRow(row: Row): ProjectRow {
  return {
    id: str(row, "id"),
    kind: str(row, "kind") as ProjectRow["kind"],
    name: str(row, "name"),
    gitRemoteUrl: strOrNull(row, "git_remote_url"),
    sortKey: str(row, "sort_key"),
    deletedAt: numOrNull(row, "deleted_at"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

// --- thread sections ----------------------------------------------------------

export interface ThreadSectionRow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export function toThreadSectionRow(row: Row): ThreadSectionRow {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

// --- threads ------------------------------------------------------------------

export type ThreadStatus = "idle" | "starting" | "active" | "stopping" | "error";
export type ThreadVisibility = "visible" | "hidden";

export interface ThreadDbRow {
  id: string;
  projectId: string;
  environmentId: string | null;
  providerId: string;
  modelOverride: string | null;
  reasoningLevelOverride: string | null;
  title: string | null;
  titleFallback: string | null;
  sectionId: string | null;
  status: ThreadStatus;
  parentThreadId: string | null;
  sourceThreadId: string | null;
  originKind: "fork" | null;
  originPluginId: string | null;
  visibility: ThreadVisibility;
  archivedAt: number | null;
  pinnedAt: number | null;
  pinSortKey: string | null;
  deletedAt: number | null;
  lastReadAt: number | null;
  latestAttentionAt: number;
  createdAt: number;
  updatedAt: number;
}

const THREAD_COLUMNS = [
  "id",
  "project_id",
  "environment_id",
  "provider_id",
  "model_override",
  "reasoning_level_override",
  "title",
  "title_fallback",
  "section_id",
  "status",
  "parent_thread_id",
  "source_thread_id",
  "origin_kind",
  "origin_plugin_id",
  "visibility",
  "archived_at",
  "pinned_at",
  "pin_sort_key",
  "deleted_at",
  "last_read_at",
  "latest_attention_at",
  "created_at",
  "updated_at",
] as const;

export const THREAD_COLUMN_SQL = THREAD_COLUMNS.join(", ");

export function toThreadDbRow(row: Row): ThreadDbRow {
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    environmentId: strOrNull(row, "environment_id"),
    providerId: str(row, "provider_id"),
    modelOverride: strOrNull(row, "model_override"),
    reasoningLevelOverride: strOrNull(row, "reasoning_level_override"),
    title: strOrNull(row, "title"),
    titleFallback: strOrNull(row, "title_fallback"),
    sectionId: strOrNull(row, "section_id"),
    status: str(row, "status") as ThreadStatus,
    parentThreadId: strOrNull(row, "parent_thread_id"),
    sourceThreadId: strOrNull(row, "source_thread_id"),
    originKind: strOrNull(row, "origin_kind") as "fork" | null,
    originPluginId: strOrNull(row, "origin_plugin_id"),
    visibility: str(row, "visibility") as ThreadVisibility,
    archivedAt: numOrNull(row, "archived_at"),
    pinnedAt: numOrNull(row, "pinned_at"),
    pinSortKey: strOrNull(row, "pin_sort_key"),
    deletedAt: numOrNull(row, "deleted_at"),
    lastReadAt: numOrNull(row, "last_read_at"),
    latestAttentionAt: num(row, "latest_attention_at"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

// --- hosts --------------------------------------------------------------------

export interface HostDbRow {
  id: string;
  name: string;
  type: "persistent" | "placeholder";
  connectMachineId: string | null;
  maxPermissionMode: "accept-edits" | "auto" | "full";
  destroyedAt: number | null;
  lastSeenAt: number | null;
  lastRejectedProtocolVersion: number | null;
  createdAt: number;
  updatedAt: number;
}

export function toHostDbRow(row: Row): HostDbRow {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    type: str(row, "type") as HostDbRow["type"],
    connectMachineId: strOrNull(row, "connect_machine_id"),
    maxPermissionMode: str(row, "max_permission_mode") as HostDbRow["maxPermissionMode"],
    destroyedAt: numOrNull(row, "destroyed_at"),
    lastSeenAt: numOrNull(row, "last_seen_at"),
    lastRejectedProtocolVersion: numOrNull(row, "last_rejected_protocol_version"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

// --- environments (#288) -------------------------------------------------------

export type EnvironmentStatus =
  | "provisioning"
  | "ready"
  | "retiring"
  | "error"
  | "destroying"
  | "destroyed";
export type WorkspaceProvisionType = "unmanaged" | "managed-worktree" | "personal";

export interface EnvironmentDbRow {
  id: string;
  name: string | null;
  projectId: string;
  hostId: string;
  path: string | null;
  managed: boolean;
  isGitRepo: boolean;
  isWorktree: boolean;
  branchName: string | null;
  baseBranch: string | null;
  defaultBranch: string | null;
  mergeBaseBranch: string | null;
  destroyAttemptId: string | null;
  retireRequestedAt: number | null;
  workspaceProvisionType: WorkspaceProvisionType;
  status: EnvironmentStatus;
  createdAt: number;
  updatedAt: number;
}

const ENVIRONMENT_COLUMNS = [
  "id",
  "name",
  "project_id",
  "host_id",
  "path",
  "managed",
  "is_git_repo",
  "is_worktree",
  "branch_name",
  "base_branch",
  "default_branch",
  "merge_base_branch",
  "destroy_attempt_id",
  "retire_requested_at",
  "workspace_provision_type",
  "status",
  "created_at",
  "updated_at",
] as const;

export const ENVIRONMENT_COLUMN_SQL = ENVIRONMENT_COLUMNS.join(", ");

export function toEnvironmentDbRow(row: Row): EnvironmentDbRow {
  return {
    id: str(row, "id"),
    name: strOrNull(row, "name"),
    projectId: str(row, "project_id"),
    hostId: str(row, "host_id"),
    path: strOrNull(row, "path"),
    managed: bool(row, "managed"),
    isGitRepo: bool(row, "is_git_repo"),
    isWorktree: bool(row, "is_worktree"),
    branchName: strOrNull(row, "branch_name"),
    baseBranch: strOrNull(row, "base_branch"),
    defaultBranch: strOrNull(row, "default_branch"),
    mergeBaseBranch: strOrNull(row, "merge_base_branch"),
    destroyAttemptId: strOrNull(row, "destroy_attempt_id"),
    retireRequestedAt: numOrNull(row, "retire_requested_at"),
    workspaceProvisionType: str(row, "workspace_provision_type") as WorkspaceProvisionType,
    status: str(row, "status") as EnvironmentStatus,
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

// --- misc ----------------------------------------------------------------------

export interface ThreadTabsDbRow {
  threadId: string;
  tabsJson: string;
  revision: number;
  updatedAt: number;
}

export function toThreadTabsDbRow(row: Row): ThreadTabsDbRow {
  return {
    threadId: str(row, "thread_id"),
    tabsJson: str(row, "tabs_json"),
    revision: num(row, "revision"),
    updatedAt: num(row, "updated_at"),
  };
}

export interface AppSettingsDbRow {
  caffeinate: boolean;
  showKeyboardHints: boolean;
  steerActiveThreadOnEnter: boolean;
  showUnhandledProviderEvents: boolean;
  codexMemoryEnabled: boolean;
  claudeCodeMemoryEnabled: boolean;
  codexSubagentsDisabled: boolean;
  claudeCodeSubagentsDisabled: boolean;
  claudeCodeWorkflowsDisabled: boolean;
  keybindingOverridesJson: string;
  onboardingCompletedAt: string | null;
  updatedAt: number;
}

function bool(row: Row, key: string): boolean {
  return num(row, key) !== 0;
}

export function toAppSettingsDbRow(row: Row): AppSettingsDbRow {
  return {
    caffeinate: bool(row, "caffeinate"),
    showKeyboardHints: bool(row, "show_keyboard_hints"),
    steerActiveThreadOnEnter: bool(row, "steer_active_thread_on_enter"),
    showUnhandledProviderEvents: bool(row, "show_unhandled_provider_events"),
    codexMemoryEnabled: bool(row, "codex_memory_enabled"),
    claudeCodeMemoryEnabled: bool(row, "claude_code_memory_enabled"),
    codexSubagentsDisabled: bool(row, "codex_subagents_disabled"),
    claudeCodeSubagentsDisabled: bool(row, "claude_code_subagents_disabled"),
    claudeCodeWorkflowsDisabled: bool(row, "claude_code_workflows_disabled"),
    keybindingOverridesJson: str(row, "keybinding_overrides"),
    onboardingCompletedAt: strOrNull(row, "onboarding_completed_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export interface HostDaemonSessionDbRow {
  id: string;
  hostId: string;
  instanceId: string;
  hostName: string;
  hostType: string;
  dataDir: string;
  protocolVersion: number;
  heartbeatIntervalMs: number;
  leaseTimeoutMs: number;
  status: string;
  leaseExpiresAt: number;
  closedAt: number | null;
  closeReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export function toHostDaemonSessionDbRow(row: Row): HostDaemonSessionDbRow {
  return {
    id: str(row, "id"),
    hostId: str(row, "host_id"),
    instanceId: str(row, "instance_id"),
    hostName: str(row, "host_name"),
    hostType: str(row, "host_type"),
    dataDir: str(row, "data_dir"),
    protocolVersion: num(row, "protocol_version"),
    heartbeatIntervalMs: num(row, "heartbeat_interval_ms"),
    leaseTimeoutMs: num(row, "lease_timeout_ms"),
    status: str(row, "status"),
    leaseExpiresAt: num(row, "lease_expires_at"),
    closedAt: numOrNull(row, "closed_at"),
    closeReason: strOrNull(row, "close_reason"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}
