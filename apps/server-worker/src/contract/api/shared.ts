//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";
import {
  BRANCH_LIST_QUERY_MAX_LENGTH,
  changedMessageLenientSchema,
  changedMessageSchema,
  gitBranchNameSchema,
} from "../domain/index.js";
import type { GitBranchName } from "../domain/index.js";

export {
  BRANCH_LIST_LIMIT_MAX,
  BRANCH_LIST_QUERY_MAX_LENGTH,
  FILE_LIST_LIMIT_MAX,
  FILE_LIST_QUERY_MAX_LENGTH,
} from "../domain/index.js";

interface IncludeQueryValidationArgs {
  allowedValues: readonly string[];
  value: string;
}

export function isCommaSeparatedIncludeQueryValue(args: IncludeQueryValidationArgs): boolean {
  const requestedValues = args.value.split(",");
  return requestedValues.every((value) => value.length > 0 && args.allowedValues.includes(value));
}

export const threadContextWindowUsageSchema = z.object({
  usedTokens: z.number(),
  modelContextWindow: z.number(),
  estimated: z.boolean(),
});
export type ThreadContextWindowUsage = z.infer<typeof threadContextWindowUsageSchema>;

export { gitBranchNameSchema };
export type { GitBranchName };

// #288 (inventory §2.A5): the environment/workspace binding vocabulary lives
// in @cap/protocol — the single home for protocol definitions. Re-exported
// here under the historical local names so the bb-ported call sites compile
// unchanged; the definitions are no longer duplicated in this repo.
export {
  baseBranchSpecSchema,
  createThreadEnvironmentArgsSchema,
  environmentArgsSchema,
  hostEnvironmentSchema,
  managedWorktreeWorkspaceSchema,
  personalWorkspaceSchema,
  projectDefaultEnvironmentSchema,
  reuseEnvironmentSchema,
  unmanagedBranchSpecSchema,
  unmanagedWorkspaceSchema,
  workspaceArgsSchema,
  type BaseBranchSpec,
  type CreateThreadEnvironmentArgs,
  type EnvironmentArgs,
  type UnmanagedBranchSpec,
  type WorkspaceArgs,
} from "@cap/protocol";

export const pathListIncludeQueryValueSchema = z.enum(["true", "false"]);
export type PathListIncludeQueryValue = z.infer<typeof pathListIncludeQueryValueSchema>;

export const branchListQuerySchema = z.object({
  query: z.string().min(1).max(BRANCH_LIST_QUERY_MAX_LENGTH).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});
export type BranchListQuery = z.infer<typeof branchListQuerySchema>;

export const serverMessageSchema = changedMessageSchema;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/**
 * Lenient counterpart of {@link serverMessageSchema} for INBOUND parsing on
 * clients. The strict schema guards the server's outgoing boundary; clients
 * (SDK consumers, the web app) may be older than the server they talk to, so
 * they strip unknown fields and filter unknown change kinds instead of
 * dropping whole messages on additive server changes. Output stays assignable
 * to {@link ServerMessage}.
 */
export const serverMessageLenientSchema = changedMessageLenientSchema;

/**
 * Ephemeral server→client WebSocket message carrying a plugin's
 * `bb.realtime.publish(channel, payload)` signal. V1 broadcasts to every
 * connected client — there is no per-channel subscription yet (client-side
 * consumption lands with the plugin frontend runtime). Nothing is persisted;
 * clients that predate this message type ignore it. `payload` is a
 * JSON-serializable value (publish normalizes `undefined` to `null`). Strict
 * schema guards the server's outgoing boundary (mirrors the thread-open signal
 * in threads.ts).
 */
export const pluginSignalSchema = z
  .object({
    type: z.literal("plugin-signal"),
    pluginId: z.string().min(1),
    channel: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();
export type PluginSignal = z.infer<typeof pluginSignalSchema>;

/**
 * Lenient counterpart of {@link pluginSignalSchema} for INBOUND parsing on
 * clients (mirrors threadOpenSignalLenientSchema): unknown fields from a
 * newer server are stripped instead of dropping the whole signal.
 */
export const pluginSignalLenientSchema = z.object({
  type: z.literal("plugin-signal"),
  pluginId: z.string().min(1),
  channel: z.string().min(1),
  payload: z.unknown(),
});

export const workspaceFileSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const workspacePathEntryKindSchema = z.enum(["file", "directory"]);

export const workspacePathEntrySchema = z.object({
  kind: workspacePathEntryKindSchema,
  path: z.string(),
  name: z.string(),
  score: z.number(),
  positions: z.array(z.number().int().nonnegative()),
});
export type WorkspacePathEntry = z.infer<typeof workspacePathEntrySchema>;

export const workspaceFileListResponseSchema = z.object({
  files: z.array(workspaceFileSchema),
  truncated: z.boolean(),
});
export type WorkspaceFileListResponse = z.infer<typeof workspaceFileListResponseSchema>;

export const workspacePathListResponseSchema = z.object({
  paths: z.array(workspacePathEntrySchema),
  truncated: z.boolean(),
});
export type WorkspacePathListResponse = z.infer<typeof workspacePathListResponseSchema>;
