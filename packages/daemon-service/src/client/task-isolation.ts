import { mkdirSync, writeFile } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import type {
  IsolationBackendSetting,
  IsolationHandle,
  WorktreeBaseline,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import { log } from "./log.js";
import type { ToolDispatchFrame, ToolExecutionResult, ToolHost } from "./tool-runtime.js";

/**
 * Task isolation backend (M1.5/T20 #110) — the daemon half of `task.isolated`.
 *
 * The orchestration face (agent-do task executor) dispatches two reserved
 * verbs through the service DO; this manager owns the host-execution body,
 * reusing the vendored omp isolation machinery wholesale (spike verdict
 * "vendor-not-rewrite"; AGENTS.md reuse-three-questions: omp's
 * task/worktree.ts + task/isolation-runner.ts already implement the entire
 * lifecycle — the adaptation is this seam, not a reimplementation):
 *
 * - prepare (`task.isolation.prepare`): `ensureIsolation` → PAL candidate
 *   downgrade chain (overlayfs → clone → recursive-copy fallback, omp
 *   worktree.ts:554-603), then `captureIsolationBaseline` under the
 *   isolation-snapshot budget (≤1 GiB, omp worktree.ts:130) — over-budget
 *   throws `IsolationBaselineTooLargeError` BEFORE the child is driven
 *   (fail-before-spawn). The child thread's host-tool frames then resolve
 *   against the isolated merged view ({@link IsolationManager.hostFor}).
 * - release (`task.isolation.release`): capture the workspace delta —
 *   patch mode (`task.isolation.merge: "patch"`, omp default) writes
 *   `<artifactsDir>/<agentId>.patch` + nested patches; branch mode commits
 *   `omp/task/<agentId>` (omp worktree.ts:844-908) — then, when the apply
 *   gate is open (default on, omp `task.isolation.apply`), lands the delta
 *   on the source checkout: `repo.canApplyPatch` reverse/forward precheck +
 *   `applyPatch` (isolation-runner.ts:722-739), or `mergeTaskBranches`
 *   cherry-pick + branch cleanup (worktree.ts:929-964). A failed capture
 *   write retains the workspace under a unique `.retained-*` sibling
 *   (isolation-runner.ts:310-338) instead of destroying the only copy.
 *
 * Keep-alive semantics (omp isolation-runner.ts:377-381): sessions persist
 * across the child's idle/parked lifecycle — nothing tears the workspace at
 * settlement; only an explicit release (or the edge's failed-bring-up
 * cleanup) captures and merges. Resurrection (`write agent://<id>`) keeps
 * operating inside the retained workspace — see the #78 dead-point note in
 * the PR: task-follow-up.md's "isolated unrecoverable" template line is
 * stale against this lifecycle; the implementation wins.
 *
 * Policy input mirrors the #102 provider-config seam shape: a daemon-side
 * env JSON patch over omp defaults (`DAEMON_TASK_ISOLATION`), decoded once
 * at construction — deployment-time input, never model-reachable.
 */

/** omp `isolation.backend` setting values (task/worktree.ts:475). */
const BACKEND_IDS = [
  "auto",
  "apfs",
  "btrfs",
  "zfs",
  "reflink",
  "overlayfs",
  "projfs",
  "block-clone",
  "rcopy",
] as const;

export interface TaskIsolationConfig {
  /** omp `task.isolation.merge` (default "patch", task/settings.ts:120). */
  mergeMode: "patch" | "branch";
  /** omp `task.isolation.apply` (default true, task/settings.ts:105). */
  applyGate: boolean;
  /** omp `isolation.backend` (default "auto" — PAL picks the chain). */
  backend: IsolationBackendSetting;
  /**
   * Isolation-snapshot budget per repo (omp
   * ISOLATION_BASELINE_MAX_CONTENT_BYTES, worktree.ts:130 = 1 GiB). A
   * deployment may lower it; raising past the vendored pin is rejected.
   */
  baselineBudgetBytes: number;
}

/** omp defaults, verbatim (task/settings.ts:101-131, worktree.ts:130). */
export const DEFAULT_TASK_ISOLATION_CONFIG: TaskIsolationConfig = {
  mergeMode: "patch",
  applyGate: true,
  backend: "auto",
  baselineBudgetBytes: 1024 * 1024 * 1024,
};

const taskIsolationPatchSchema = z.object({
  mergeMode: z.enum(["patch", "branch"]).optional(),
  applyGate: z.boolean().optional(),
  backend: z.enum(BACKEND_IDS).optional(),
  baselineBudgetBytes: z.number().int().positive().optional(),
});

/**
 * Decode the `DAEMON_TASK_ISOLATION` env JSON patch over omp's defaults
 * (#102 decodeWebSearchConfig shape). Shape violations throw (zod); the
 * budget may only be lowered, never raised past the vendored 1 GiB pin.
 */
export function decodeTaskIsolationConfig(
  raw: string | undefined,
  base: TaskIsolationConfig = DEFAULT_TASK_ISOLATION_CONFIG,
): TaskIsolationConfig {
  if (raw === undefined || raw.trim() === "") return base;
  const patch = taskIsolationPatchSchema.parse(JSON.parse(raw));
  if (
    patch.baselineBudgetBytes !== undefined &&
    patch.baselineBudgetBytes > base.baselineBudgetBytes
  ) {
    throw new Error(
      `task isolation config: baselineBudgetBytes ${patch.baselineBudgetBytes} exceeds the ` +
        `vendored isolation-snapshot budget (${base.baselineBudgetBytes}); lowering only`,
    );
  }
  return {
    mergeMode: patch.mergeMode ?? base.mergeMode,
    applyGate: patch.applyGate ?? base.applyGate,
    backend: patch.backend ?? base.backend,
    baselineBudgetBytes: patch.baselineBudgetBytes ?? base.baselineBudgetBytes,
  };
}

/** Reserved dispatch verbs — daemon-side only, never on the model surface. */
export const ISOLATION_PREPARE_TOOL = "task.isolation.prepare";
export const ISOLATION_RELEASE_TOOL = "task.isolation.release";

export function isIsolationVerb(tool: string): boolean {
  return tool === ISOLATION_PREPARE_TOOL || tool === ISOLATION_RELEASE_TOOL;
}

const prepareArgsSchema = z.object({
  /** Child thread — its host-tool frames resolve inside the workspace. */
  threadId: z.string().min(1),
  /** Isolation namespace + branch suffix (omp structured-subagent.ts:876). */
  agentId: z.string().min(1),
  /** Human description carried onto the branch commit (branch mode). */
  description: z.string().min(1).optional(),
});

const releaseArgsSchema = z.object({
  threadId: z.string().min(1),
  /** Per-release gate override; omitted → the configured gate. */
  apply: z.boolean().optional(),
});

/** Patch-apply face of the vendored git natives (omp VcsGitRepo slice). */
interface IsolationGitRepo {
  canApplyPatch: (patch: string, options: Record<string, unknown>) => Promise<boolean>;
  applyPatch: (patch: string, options: Record<string, unknown>) => Promise<void>;
}

/** omp pi-tui/tools/task NestedRepoPatch structural slice (relativePath+patch). */
interface NestedRepoPatch {
  relativePath: string;
  patch: string;
}

interface OmpIsolationModules {
  ensureIsolation: (
    baseCwd: string,
    id: string,
    preferred?: IsolationHandle["backend"],
  ) => Promise<IsolationHandle>;
  cleanupIsolation: (handle: IsolationHandle) => Promise<void>;
  captureIsolationBaseline: (
    isolationDir: string,
    repoRoot: string,
    budgetBytes?: number,
  ) => Promise<WorktreeBaseline>;
  captureDeltaPatch: (
    isolationDir: string,
    baseline: WorktreeBaseline,
  ) => Promise<{ rootPatch: string; nestedPatches: NestedRepoPatch[] }>;
  commitToBranch: (
    isolationDir: string,
    baseline: WorktreeBaseline,
    taskId: string,
    description: string | undefined,
  ) => Promise<{
    branchName?: string;
    rootPatch: string;
    nestedPatches: NestedRepoPatch[];
    baseSha?: string;
  } | null>;
  mergeTaskBranches: (
    repoRoot: string,
    branches: { branchName: string; taskId: string; baseSha?: string }[],
  ) => Promise<{ merged: string[]; failed: string[]; conflict?: string }>;
  cleanupTaskBranches: (repoRoot: string, branches: string[]) => Promise<void>;
  applyNestedPatches: (repoRoot: string, patches: NestedRepoPatch[]) => Promise<string[]>;
  persistNestedPatches: (
    artifactsDir: string,
    agentId: string,
    nestedPatches: NestedRepoPatch[],
  ) => Promise<string[]>;
  retainIsolationWorkspace: (
    isolationDir: string,
    backend?: IsolationHandle["backend"],
  ) => Promise<{ dir: string; sidecarOk: boolean }>;
  parseIsolationBackend: (
    backend: IsolationBackendSetting,
  ) => IsolationHandle["backend"] | undefined;
  formatIsolationBackend: (backend: IsolationHandle["backend"]) => string;
  requireGit: (repoRoot: string) => IsolationGitRepo;
}

let ompIsolationPromise: Promise<OmpIsolationModules> | null = null;

/**
 * Dynamic imports are load-bearing here (rule exception, same discipline as
 * createToolHost): omp's module graph freezes the process-global agent-dir
 * resolver at first omp import, so these specifiers must not evaluate until
 * the PI_CODING_AGENT_DIR env pin has landed (ToolRuntime only reaches this
 * manager after ensureHost()).
 */
function loadOmpIsolation(): Promise<OmpIsolationModules> {
  ompIsolationPromise ??= (async () => {
    const [worktree, runner, vcs] = await Promise.all([
      import("@oh-my-pi/pi-coding-agent/task/worktree"),
      import("@oh-my-pi/pi-coding-agent/task/isolation-runner"),
      import("@oh-my-pi/pi-natives/vcs"),
    ]);
    return {
      ensureIsolation: worktree.ensureIsolation,
      cleanupIsolation: worktree.cleanupIsolation,
      captureIsolationBaseline: worktree.captureIsolationBaseline,
      captureDeltaPatch: worktree.captureDeltaPatch,
      commitToBranch: worktree.commitToBranch,
      mergeTaskBranches: worktree.mergeTaskBranches,
      cleanupTaskBranches: worktree.cleanupTaskBranches,
      applyNestedPatches: worktree.applyNestedPatches,
      persistNestedPatches: runner.persistNestedPatches,
      retainIsolationWorkspace: runner.retainIsolationWorkspace,
      parseIsolationBackend: worktree.parseIsolationBackend,
      formatIsolationBackend: worktree.formatIsolationBackend,
      requireGit: vcs.requireGit,
    };
  })();
  return ompIsolationPromise;
}

interface IsolationSession {
  agentId: string;
  handle: IsolationHandle;
  baseline: WorktreeBaseline;
  mergeMode: "patch" | "branch";
  applyGate: boolean;
  artifactsDir: string;
  description: string | undefined;
  /** cwd-redirected host view (omp tools rebuilt against the workspace). */
  view: ToolHost;
}

/** One prepare outcome, JSON-encoded into the ToolExecutionResult output. */
export interface IsolationPrepareInfo {
  workspaceDir: string;
  backend: string;
  fellBack: boolean;
  fallbackReason: string | null;
  mergeMode: "patch" | "branch";
  applyGate: boolean;
}

function errorResult(output: string): ToolExecutionResult {
  return { status: "error", exitCode: null, output };
}

function okResult(output: string): ToolExecutionResult {
  return { status: "ok", exitCode: 0, output };
}

const writeFileAsync = promisify(writeFile);

/**
 * Per-daemon isolation registry. Sessions key by the CHILD thread id — the
 * thread its host-tool frames arrive under — and persist in client-process
 * memory across parks (§3.4: disconnect never kills work).
 */
export class IsolationManager {
  private readonly sessions = new Map<string, IsolationSession>();

  constructor(
    private readonly base: ToolHost,
    private readonly config: TaskIsolationConfig,
  ) {}

  /**
   * The host view an isolated child's frames execute against; null when the
   * thread has no isolation session (frames fall through to the base host).
   */
  hostFor(threadId: string): ToolHost | null {
    return this.sessions.get(threadId)?.view ?? null;
  }

  /** Handle one reserved dispatch verb; other tools fall through. */
  async execute(frame: ToolDispatchFrame): Promise<ToolExecutionResult | null> {
    try {
      if (frame.tool === ISOLATION_PREPARE_TOOL) return await this.prepare(frame);
      if (frame.tool === ISOLATION_RELEASE_TOOL) return await this.release(frame);
      return null;
    } catch (error) {
      // Same contract as executeDispatch: a verb crash is an error RESULT,
      // never a rejected dispatch (the service DO's waiter only resolves on
      // tool.exited — a throw would leave it to the timeout timer).
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * `task.isolation.prepare`: materialize the workspace + baseline snapshot.
   * Over-budget throws inside omp (`IsolationBaselineTooLargeError`) and
   * surfaces as an error result — the edge settles the spawn failed without
   * ever driving the child (fail-before-spawn).
   */
  private async prepare(frame: ToolDispatchFrame): Promise<ToolExecutionResult> {
    const parsed = prepareArgsSchema.safeParse(frame.arguments);
    if (!parsed.success) {
      return errorResult(`invalid ${ISOLATION_PREPARE_TOOL} arguments: ${parsed.error.message}`);
    }
    const { threadId, agentId, description } = parsed.data;
    const omp = await loadOmpIsolation();
    // omp ensureIsolation wipes the deterministic (repoRoot, id) slot
    // unconditionally (worktree.ts:568); a same-id re-prepare destroys the
    // previous workspace the same way — capture is a release-time act.
    const existing = this.sessions.get(threadId);
    if (existing !== undefined) {
      this.sessions.delete(threadId);
      await omp.cleanupIsolation(existing.handle).catch(() => undefined);
    }
    const handle = await omp.ensureIsolation(
      this.base.workspaceRoot,
      agentId,
      omp.parseIsolationBackend(this.config.backend),
    );
    try {
      const baseline = await omp.captureIsolationBaseline(
        handle.mergedDir,
        this.base.workspaceRoot,
        this.config.baselineBudgetBytes,
      );
      const artifactsDir = join(this.base.artifactsRoot, "isolation");
      mkdirSync(artifactsDir, { recursive: true });
      this.sessions.set(threadId, {
        agentId,
        handle,
        baseline,
        mergeMode: this.config.mergeMode,
        applyGate: this.config.applyGate,
        artifactsDir,
        description,
        view: this.base.viewFor(handle.mergedDir),
      });
      const info: IsolationPrepareInfo = {
        workspaceDir: handle.mergedDir,
        backend: omp.formatIsolationBackend(handle.backend),
        fellBack: handle.fellBack,
        fallbackReason: handle.fallbackReason,
        mergeMode: this.config.mergeMode,
        applyGate: this.config.applyGate,
      };
      log(
        `isolation prepare ${agentId}: backend ${info.backend}` +
          (info.fellBack ? ` (fell back: ${info.fallbackReason ?? "unspecified"})` : "") +
          ` → ${info.workspaceDir}`,
      );
      return okResult(JSON.stringify(info, null, 2));
    } catch (error) {
      // Fail-before-spawn: the child was never driven; nothing retains a
      // half-prepared workspace (omp runIsolatedSubprocess startup path).
      await omp.cleanupIsolation(handle).catch(() => undefined);
      throw error;
    }
  }

  /**
   * `task.isolation.release`: capture → (gate) merge → cleanup. Errors
   * preserve the underlying artifacts per omp's contract: a failed capture
   * write retains the workspace (`.retained-*` sibling); a failed merge
   * keeps the branch and names the rescue patch.
   */
  private async release(frame: ToolDispatchFrame): Promise<ToolExecutionResult> {
    const parsed = releaseArgsSchema.safeParse(frame.arguments);
    if (!parsed.success) {
      return errorResult(`invalid ${ISOLATION_RELEASE_TOOL} arguments: ${parsed.error.message}`);
    }
    const { threadId, apply } = parsed.data;
    const session = this.sessions.get(threadId);
    if (session === undefined) {
      return errorResult(`no isolation session for thread ${threadId}`);
    }
    const omp = await loadOmpIsolation();
    const lines: string[] = [];
    let outcome: string;
    try {
      outcome = await this.captureAndMerge(session, apply ?? session.applyGate, lines);
    } catch (error) {
      // Capture failed — the workspace is the only other copy of the delta.
      // Retain it under a unique sibling and name the path (omp
      // isolation-runner.ts:414-425).
      const retained = await omp
        .retainIsolationWorkspace(session.handle.mergedDir, session.handle.backend)
        .catch(() => ({ dir: session.handle.mergedDir, sidecarOk: true }));
      this.sessions.delete(threadId);
      const message = error instanceof Error ? error.message : String(error);
      const suffix = retained.sidecarOk
        ? ""
        : " (mount teardown metadata missing — unmount manually before removing)";
      log(`isolation release ${session.agentId} FAILED: ${message}`);
      return errorResult(
        `Isolated changes could not be captured: ${message}\n` +
          `Workspace retained at ${retained.dir}${suffix}; its delta was NOT applied.`,
      );
    }
    this.sessions.delete(threadId);
    await omp.cleanupIsolation(session.handle);
    log(`isolation release ${session.agentId}: ${outcome}`);
    return okResult([outcome, ...lines].join("\n"));
  }

  /**
   * The reclamation matrix (omp mergeIsolatedChanges +
   * runIsolatedSubprocess capture half). Captures the delta artifact FIRST
   * (both modes — the patch file doubles as the `<agentId>.patch` failure
   * rescue), then applies when the gate is open.
   */
  private async captureAndMerge(
    session: IsolationSession,
    apply: boolean,
    lines: string[],
  ): Promise<string> {
    const omp = await loadOmpIsolation();
    const mergedDir = session.handle.mergedDir;
    const repoRoot = this.base.workspaceRoot;
    const patchPath = join(session.artifactsDir, `${session.agentId}.patch`);

    if (session.mergeMode === "branch") {
      // Patch artifact first (omp releaseIsolation:413): the rescue copy in
      // case the branch commit or the merge fails below.
      const delta = await omp.captureDeltaPatch(mergedDir, session.baseline);
      await writeFileAsync(patchPath, delta.rootPatch, "utf8");
      const nestedPaths = await omp.persistNestedPatches(
        session.artifactsDir,
        session.agentId,
        delta.nestedPatches,
      );
      if (nestedPaths.length > 0) {
        lines.push(`Nested repository patches: ${nestedPaths.join(", ")}`);
      }
      const commit = await omp.commitToBranch(
        mergedDir,
        session.baseline,
        session.agentId,
        session.description,
      );
      if (commit?.branchName === undefined) {
        lines.push(`Rescue patch: ${patchPath}`);
        return "No root changes to apply; delta captured to the rescue patch.";
      }
      if (!apply) {
        return `Captured branch ${commit.branchName} (apply gate closed — not applied).`;
      }
      const merge = await omp.mergeTaskBranches(repoRoot, [
        { branchName: commit.branchName, taskId: session.agentId, baseSha: commit.baseSha },
      ]);
      if (merge.failed.length > 0) {
        lines.push(`Rescue patch: ${patchPath}`);
        throw new Error(
          `branch merge failed, branch kept for manual resolution: ${merge.conflict ?? merge.failed.join(", ")}`,
        );
      }
      await omp.cleanupTaskBranches(repoRoot, [commit.branchName]);
      if (commit.nestedPatches.length > 0) {
        lines.push(...(await omp.applyNestedPatches(repoRoot, commit.nestedPatches)));
      }
      return `Merged branch: ${commit.branchName}`;
    }

    // Patch mode: capture, then the reverse/forward canApplyPatch precheck
    // (omp isolation-runner.ts:722-739 — reverse-applies AND forward fails ⇒
    // already applied; forward applies ⇒ apply; else not applied).
    const delta = await omp.captureDeltaPatch(mergedDir, session.baseline);
    await writeFileAsync(patchPath, delta.rootPatch, "utf8");
    const nestedPaths = await omp.persistNestedPatches(
      session.artifactsDir,
      session.agentId,
      delta.nestedPatches,
    );
    if (nestedPaths.length > 0) {
      lines.push(`Nested repository patches: ${nestedPaths.join(", ")}`);
    }
    if (!delta.rootPatch.trim() && delta.nestedPatches.length === 0) {
      return "No changes to apply.";
    }
    if (!apply) {
      return `Captured patch (apply gate closed — not applied): ${patchPath}`;
    }
    if (!delta.rootPatch.trim()) {
      return "No root changes to apply; nested repository patches captured.";
    }
    const normalized = delta.rootPatch.endsWith("\n") ? delta.rootPatch : `${delta.rootPatch}\n`;
    const repo = omp.requireGit(repoRoot);
    const [alreadyApplied, forwardApplies] = await Promise.all([
      repo.canApplyPatch(normalized, { reverse: true }).catch(() => false),
      repo.canApplyPatch(normalized, {}).catch(() => false),
    ]);
    if (alreadyApplied && !forwardApplies) {
      return "Applied patches: already applied (no-op).";
    }
    if (!forwardApplies) {
      lines.push(`Rescue patch: ${patchPath}`);
      throw new Error(`patch does not apply to the source checkout (rescue: ${patchPath})`);
    }
    await repo.applyPatch(normalized, {});
    if (delta.nestedPatches.length > 0) {
      lines.push(...(await omp.applyNestedPatches(repoRoot, delta.nestedPatches)));
    }
    return `Applied patches: yes (${patchPath})`;
  }
}
