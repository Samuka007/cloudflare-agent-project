import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { HostRpcCommandError } from "./host-directory.js";
import type {
  ProjectCloneCommand,
  ProjectInspectCommand,
  ProjectPathInspection,
  ProjectPathResult,
} from "../protocol.js";

/**
 * #445: the daemon face of the project online-RPC commands — verbatim port of
 * bb's command-handlers/project.ts (apps/host-daemon/src/command-handlers/
 * project.ts) plus the `runGit` slice of host-workspace/git.ts those handlers
 * need: `git clone` (20-minute window, stderr preserved) and the best-effort
 * `git remote get-url origin` inspection.
 *
 * Error discipline follows bb's command dispatch (command-dispatch-support.ts):
 * a command-level refusal carries a stable code (`target_not_empty`);
 * WorkspaceError-mapped git failures keep their code (`git_command_failed`,
 * `git_command_timeout`) — the SPA's setup dialog renders git stderr inline,
 * so the message carries it verbatim. The server maps the code into its
 * ApiError untouched.
 */

const execFileAsync = promisify(execFile);

/** bb PROJECT_CLONE_TIMEOUT_MS (command-handlers/project.ts:6). */
export const PROJECT_CLONE_TIMEOUT_MS = 20 * 60 * 1000;

const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** bb normalizeProjectSlug (command-handlers/project.ts:8-17). */
export function normalizeProjectSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/u, "");
  return slug || "project";
}

/** bb resolveProjectCloneDefaultPath (command-handlers/project.ts:19-24). */
export function resolveProjectCloneDefaultPath(
  dataDir: string,
  projectSlug: string,
): ProjectPathResult {
  return {
    path: path.resolve(dataDir, "checkouts", normalizeProjectSlug(projectSlug)),
  };
}

/**
 * bb runGit narrowed to the project face: exit codes are results, timeouts
 * and failures are WorkspaceError-shaped command errors (git.ts:253-311).
 */
async function runGit(
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const execError = error as {
      code?: unknown;
      signal?: unknown;
      killed?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const stderr = typeof execError.stderr === "string" ? execError.stderr : "";
    if (
      typeof options.timeoutMs === "number" &&
      execError.killed === true &&
      execError.signal === "SIGTERM"
    ) {
      // bb createGitCommandTimedOutError (git.ts:196-206).
      throw new HostRpcCommandError(
        "git_command_timeout",
        `git ${args.join(" ")} timed out after ${options.timeoutMs}ms`,
      );
    }
    const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
    // bb createGitCommandFailedError (git.ts:240-251); a numeric exit code
    // stays a failure result, anything else is the same command error.
    throw new HostRpcCommandError("git_command_failed", `git ${args.join(" ")} failed${detail}`);
  }
}

/** bb requireEmptyOrMissingTarget (command-handlers/project.ts:26-44). */
async function requireEmptyOrMissingTarget(targetPath: string): Promise<void> {
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory() || (await fs.readdir(targetPath)).length > 0) {
      throw new HostRpcCommandError("target_not_empty", `Clone target is not empty: ${targetPath}`);
    }
  } catch (error) {
    if (error instanceof HostRpcCommandError) {
      throw error;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/** bb inspectProjectPath (command-handlers/project.ts:46-60). */
export async function inspectProjectPath(
  command: ProjectInspectCommand,
): Promise<ProjectPathInspection> {
  const resolvedPath = path.resolve(command.path);
  const result = await runGit(["remote", "get-url", "origin"], {
    cwd: resolvedPath,
  }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const gitRemoteUrl = result.code === 0 ? result.stdout.trim() : "";
  return {
    path: resolvedPath,
    gitRemoteUrl: gitRemoteUrl || null,
  };
}

/** bb cloneProject (command-handlers/project.ts:62-86); the port carries the
 * daemon's dataDir argument explicitly (bb reads it from dispatch options). */
export async function cloneProject(
  command: ProjectCloneCommand,
  dataDir: string,
): Promise<ProjectPathInspection> {
  const targetPath = path.resolve(
    command.targetPath ?? resolveProjectCloneDefaultPath(dataDir, command.projectSlug).path,
  );
  await requireEmptyOrMissingTarget(targetPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await runGit(["clone", command.remoteUrl, targetPath], {
      cwd: path.dirname(targetPath),
      timeoutMs: PROJECT_CLONE_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof HostRpcCommandError) {
      throw error;
    }
    throw new HostRpcCommandError(
      "git_command_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  return inspectProjectPath({ type: "project.inspect", path: targetPath });
}

/** bb checkHostPathsExist (command-handlers/host-files.ts:186-193) with the
 * shared pathExists probe (host-workspace git.ts:575-579). */
export async function checkHostPathsExist(command: {
  paths: string[];
}): Promise<{ existence: Record<string, boolean> }> {
  const entries = await Promise.all(
    command.paths.map(async (path) => [path, await pathExists(path)] as const),
  );
  return { existence: Object.fromEntries(entries) };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
