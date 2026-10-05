/**
 * Provider-facing value vocabulary for the AdapterCommand seam — local M0
 * declarations (incident rule #0: the bb domain package was not ported as a
 * workspace package, and apps/server-worker is consume-only). Shapes are
 * ported structurally from bb @ 8473d8c33 with per-type provenance; enums are
 * copied verbatim. Growth happens additively; #28 owns the real provider app.
 *
 * bb provenance per type: `packages/domain/src/shared-types.ts`,
 * `provider-types.ts` (via apps/server-worker contract port), `provider-event.ts`,
 * `packages/agent-runtime/src/types.ts`.
 */

// ---------------------------------------------------------------------------
// Scalars and enums (bb shared-types.ts, verbatim values).
// ---------------------------------------------------------------------------

export const reasoningLevelValues = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;
export type ReasoningLevel = (typeof reasoningLevelValues)[number];

export const serviceTierValues = ["fast", "default"] as const;
export type ServiceTier = (typeof serviceTierValues)[number];

/** How server-owned instructions enter the provider system prompt. */
export const instructionModeValues = ["append", "replace"] as const;
export type InstructionMode = (typeof instructionModeValues)[number];

/**
 * Order is load-bearing: the index is the privilege rank bb compares
 * (`clampPermissionModeToCeiling`); "accept-edits" least, "full" most.
 */
export const permissionModeValues = ["accept-edits", "auto", "full"] as const;
export type PermissionMode = (typeof permissionModeValues)[number];

export const permissionEscalationValues = ["ask", "deny"] as const;
export type PermissionEscalation = (typeof permissionEscalationValues)[number];

export const promptInputVisibilityValues = ["agent-only"] as const;
export type PromptInputVisibility = (typeof promptInputVisibilityValues)[number];

export const promptMentionPathSourceValues = ["workspace", "thread-storage"] as const;
export type PromptMentionPathSource = (typeof promptMentionPathSourceValues)[number];

export const promptMentionPathEntryKindValues = ["file", "directory"] as const;
export type PromptMentionPathEntryKind = (typeof promptMentionPathEntryKindValues)[number];

export const promptMentionCommandTriggerValues = ["/"] as const;
export type PromptMentionCommandTrigger = (typeof promptMentionCommandTriggerValues)[number];

export const promptMentionCommandSourceValues = ["skill", "command"] as const;
export type PromptMentionCommandSource = (typeof promptMentionCommandSourceValues)[number];

export const promptMentionCommandOriginValues = ["builtin", "project", "user"] as const;
export type PromptMentionCommandOrigin = (typeof promptMentionCommandOriginValues)[number];

// ---------------------------------------------------------------------------
// Permission policy (bb runtimePermissionPolicySchema, structural port).
// ---------------------------------------------------------------------------

export type RuntimePermissionPolicy =
  | {
      permissionMode: "accept-edits";
      permissionScope: "workspace";
      approvalReviewer: "user";
      permissionEscalation: PermissionEscalation;
    }
  | {
      permissionMode: "auto";
      permissionScope: "workspace";
      approvalReviewer: "automatic";
      permissionEscalation: PermissionEscalation;
    }
  | {
      permissionMode: "full";
      permissionScope: "full";
      approvalReviewer: null;
      permissionEscalation: null;
    };

// ---------------------------------------------------------------------------
// Prompt input (bb promptInputSchema + canonicalPromptMentionResourceSchema,
// structural port without the legacy-preprocess step).
// ---------------------------------------------------------------------------

export type PromptMentionResource =
  | { kind: "thread"; threadId: string; projectId?: string; label: string }
  | { kind: "project"; projectId: string; label: string }
  | { kind: "section"; sectionId: string; label: string }
  | {
      kind: "path";
      source: PromptMentionPathSource;
      entryKind: PromptMentionPathEntryKind;
      path: string;
      label: string;
    }
  | {
      kind: "command";
      trigger: PromptMentionCommandTrigger;
      name: string;
      source: PromptMentionCommandSource;
      origin: PromptMentionCommandOrigin;
      label: string;
      argumentHint: string | null;
    }
  | {
      kind: "plugin";
      pluginId: string;
      icon?: string | null;
      /** Opaque `providerId:itemId` reference minted by server mention search. */
      itemId: string;
      label: string;
    };

export interface PromptTextMention {
  start: number;
  end: number;
  resource: PromptMentionResource;
}

interface PromptInputVisibilityFields {
  visibility?: PromptInputVisibility;
}

export type PromptInput =
  | ({
      type: "text";
      text: string;
      mentions: PromptTextMention[];
    } & PromptInputVisibilityFields)
  | ({ type: "image"; url: string } & PromptInputVisibilityFields)
  | ({
      /** Absolute paths pass through; relative paths are attachment refs. */
      type: "localImage";
      path: string;
    } & PromptInputVisibilityFields)
  | ({
      type: "localFile";
      path: string;
      name?: string;
      sizeBytes?: number;
      mimeType?: string;
    } & PromptInputVisibilityFields);

/** bb clientTurnRequestIdSchema: `creq_` + 10-char Crockford-style suffix. */
export type ClientTurnRequestId = string;

// ---------------------------------------------------------------------------
// Execution options (bb runtimeThreadExecutionOptionsSchema, structural port).
// ---------------------------------------------------------------------------

export interface ClaudeCodeMockCliTrafficConfig {
  enabled: boolean;
  endpoint: string;
}

export interface RuntimeThreadExecutionBaseOptions {
  model: string;
  serviceTier: ServiceTier;
  reasoningLevel: ReasoningLevel;
  claudeCodePermissionMode?: "plan";
  claudeCodeMockCliTraffic?: ClaudeCodeMockCliTrafficConfig;
  /** Server-owned policy, filled explicitly at the server boundary. */
  workflowsEnabled: boolean;
  memoryEnabled?: boolean;
  providerSubagentsEnabled?: boolean;
}

export type RuntimeThreadExecutionOptions = RuntimeThreadExecutionBaseOptions &
  RuntimePermissionPolicy;

// ---------------------------------------------------------------------------
// Provider metadata (bb provider-types.ts / agent-runtime types.ts).
// ---------------------------------------------------------------------------

// JSON-facing vocabulary uses type aliases (not interfaces) so result
// payloads satisfy the AdapterCommandResultValue index-signature union.
export type ModelReasoningEffort = {
  reasoningEffort: ReasoningLevel;
  description: string;
};

export type AvailableModel = {
  id: string;
  model: string;
  displayName: string;
  /** Route used when a nested model provider differs from the agent provider. */
  routeProviderId?: string;
  description: string;
  supportedReasoningEfforts: ModelReasoningEffort[];
  defaultReasoningEffort: ReasoningLevel;
  isDefault: boolean;
};

export interface ProviderCapabilities {
  supportsArchive: boolean;
  supportsRename: boolean;
  supportsServiceTier: boolean;
  supportsUserQuestion: boolean;
  supportsFork: boolean;
  /**
   * A4 image-consumption dispatch (#319): does the provider accept image
   * input? acp `session.supportsImageInput` anchor — a false verdict degrades
   * every prompt image to its `[image attachment on disk: path]` text.
   */
  supportsImageInput: boolean;
  supportedPermissionModes: PermissionMode[];
}

export interface DynamicTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export type AgentRuntimeSkillRoot =
  | {
      id: string;
      providerId: "acp";
      skillDirectoryRootPath: string;
      skills: readonly { name: string; description: string }[];
    }
  | { id: string; providerId: "claude-code"; localPluginPath: string }
  | { id: string; providerId: "codex"; skillDirectoryRootPath: string }
  | { id: string; providerId: "pi"; skillDirectoryRootPath: string };

/**
 * bb-side recovery descriptor for omp sessions (omp-engine-portability.md §2.4:
 * the descriptor is bb-authored, not omp-native; the stable recovery order is
 * switch_session(sessionFile) → open_session(sessionDir) → get_entries{since}).
 */
export type OmpSessionRecoveryDescriptor = {
  sessionId: string;
  sessionFile: string;
};
