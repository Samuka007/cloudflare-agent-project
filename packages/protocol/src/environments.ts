import { z } from "zod";

/**
 * Workspace/environment binding vocabulary (#288, inventory #282 §2.A5). The
 * protocol package is the single home for protocol definitions (project
 * convention) — these schemas were ported verbatim from bb at the pinned
 * commit and previously lived duplicated in server-worker
 * `contract/api/shared.ts`; that file now re-exports from here.
 *
 * Scope ruling (inventory §4): ticket 1 lands only the `unmanaged` and
 * `personal` workspace types end to end. `managed-worktree` stays in the
 * vocabulary (bb-shape fidelity) but its provision execution body is a
 * separate ticket.
 */

// --- git branch name (bb packages/domain, via the server-worker port) -------

type GitBranchNameCandidate = string;

const gitBranchForbiddenCharacterPattern = /[\u0000-\u001f\u007f\\:~^?*\[]/u;
const gitBranchWhitespacePattern = /[ \t]/u;
const GIT_RESERVED_BRANCH_NAMES: Record<string, true> = {
  "AUTO_MERGE": true,
  BISECT_HEAD: true,
  CHERRY_PICK_HEAD: true,
  FETCH_HEAD: true,
  HEAD: true,
  MERGE_HEAD: true,
  ORIG_HEAD: true,
  REVERT_HEAD: true,
};

function isValidGitBranchName(name: GitBranchNameCandidate) {
  const components = name.split("/");
  return (
    name.length > 0 &&
    name.trim().length > 0 &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    name !== "@" &&
    !(name in GIT_RESERVED_BRANCH_NAMES) &&
    !gitBranchForbiddenCharacterPattern.test(name) &&
    !gitBranchWhitespacePattern.test(name) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    components.every(
      (component) =>
        component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"),
    )
  );
}

export const gitBranchNameSchema = z
  .string()
  .refine(isValidGitBranchName, { message: "Invalid git branch name" });
export type GitBranchName = z.infer<typeof gitBranchNameSchema>;

// --- workspace/environment args ---------------------------------------------

/**
 * Pre-thread checkout intent for an unmanaged workspace. Omitting the branch
 * spec means "don't touch HEAD"; including it asks the daemon to switch to the
 * named branch or create a server-named branch from `baseBranch` before the
 * thread starts.
 */
export const unmanagedBranchSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("existing"),
      name: gitBranchNameSchema,
    })
    .strict(),
  z.object({ kind: z.literal("new"), baseBranch: gitBranchNameSchema }).strict(),
]);
export type UnmanagedBranchSpec = z.infer<typeof unmanagedBranchSpecSchema>;

export const unmanagedWorkspaceSchema = z.object({
  type: z.literal("unmanaged"),
  path: z.string().min(1).nullable(),
  branch: unmanagedBranchSpecSchema.optional(),
});

/**
 * Identifies the base branch a managed worktree should be created from.
 * `named` carries an explicit branch name; `default` defers to the source's
 * default branch (resolved server-side so the daemon always receives a real
 * branch name).
 */
export const baseBranchSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: gitBranchNameSchema }),
  z.object({ kind: z.literal("default") }),
]);
export type BaseBranchSpec = z.infer<typeof baseBranchSpecSchema>;

export const managedWorktreeWorkspaceSchema = z.object({
  type: z.literal("managed-worktree"),
  /** Branch the new worktree should be based on. */
  baseBranch: baseBranchSpecSchema,
});

export const personalWorkspaceSchema = z.object({
  type: z.literal("personal"),
});

export const workspaceArgsSchema = z.discriminatedUnion("type", [
  unmanagedWorkspaceSchema,
  managedWorktreeWorkspaceSchema,
  personalWorkspaceSchema,
]);
export type WorkspaceArgs = z.infer<typeof workspaceArgsSchema>;

export const reuseEnvironmentSchema = z.object({
  type: z.literal("reuse"),
  environmentId: z.string().min(1),
});

export const hostEnvironmentSchema = z
  .object({
    type: z.literal("host"),
    hostId: z.string().min(1).optional(),
    workspace: workspaceArgsSchema,
  })
  .superRefine((value, ctx) => {
    if (value.workspace.type !== "personal" && value.hostId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "hostId is required unless workspace.type is personal",
        path: ["hostId"],
      });
    }
  });

export const environmentArgsSchema = z.discriminatedUnion("type", [
  reuseEnvironmentSchema,
  hostEnvironmentSchema,
]);
export type EnvironmentArgs = z.infer<typeof environmentArgsSchema>;

/**
 * Server-resolved environment default for thread creation: the server picks
 * the host and workspace using its own defaulting policy (the project's
 * default source checkout; personal workspace for the personal project). For
 * callers — plugins, scripts — that should not re-derive compose-flow policy.
 * Accepted only by thread creation; other surfaces keep the explicit
 * {@link environmentArgsSchema}.
 */
export const projectDefaultEnvironmentSchema = z.object({
  type: z.literal("project-default"),
});

export const createThreadEnvironmentArgsSchema = z.discriminatedUnion("type", [
  reuseEnvironmentSchema,
  hostEnvironmentSchema,
  projectDefaultEnvironmentSchema,
]);
export type CreateThreadEnvironmentArgs = z.infer<typeof createThreadEnvironmentArgsSchema>;

/**
 * #288 binding feed-through: the control-plane binding row inlined into thread
 * read faces. Minimal projection — ids and the fields the thread header needs
 * (bb inlines the full Environment/Host records via `include=`; those full
 * shapes stay server-worker contract types).
 */
export const environmentSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  hostId: z.string().min(1),
  path: z.string().nullable(),
  workspaceProvisionType: z.enum(["unmanaged", "managed-worktree", "personal"]),
  status: z.enum(["provisioning", "ready", "retiring", "error", "destroying", "destroyed"]),
});
export type EnvironmentSummary = z.infer<typeof environmentSummarySchema>;

export const hostSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: z.enum(["connected", "disconnected"]),
  lastSeenAt: z.number().nullable(),
});
export type HostSummary = z.infer<typeof hostSummarySchema>;

/**
 * #377 semantic placeholder for "no real host". The deployment-default
 * binding (personal workspace with no explicit host, or no project default
 * source) resolves here instead of a fabricated machine: zero enrolled hosts
 * is a first-class state, not a ghost "local" machine. The provider
 * conversation still runs on the edge; every host-tool dispatch answers the
 * honest `host_offline` until tier-0/tier-1 (#307) gives this id a real
 * cloud carrier. Deliberately NOT a hosts-table row — any row is
 * primary-protected when it is the fleet's only one (bb resolvePrimaryHostId,
 * services/hosts/primary-host.ts:70-76), which is exactly the un-deletable
 * machine shape the ruling forbids.
 */
export const CLOUD_PLACEHOLDER_HOST_ID = "cloud";
