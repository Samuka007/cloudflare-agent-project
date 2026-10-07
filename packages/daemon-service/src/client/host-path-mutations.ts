import fs from "node:fs/promises";
import path from "node:path";

import type { HostMkdirCommand, HostPathMutationResult } from "../protocol.js";
import { HostRpcCommandError } from "./host-directory.js";

/**
 * #494: the daemon side of `host.mkdir` — the Add-project folder browser's
 * "New folder" primitive (POST /api/v1/files/mkdir). Verbatim port of bb
 * mkdirHostPath (apps/host-daemon/src/command-handlers/path-mutations.ts:
 * 78-92) plus the containment helpers it rides: resolveNonSymlinkDirectoryPath
 * (root-path.ts:9-27), resolveWriteTarget + isPathWithinRoot
 * (file-write.ts:46-106). Only the mkdir arm is ported — bb's move/remove
 * arms stay deferred with the #494 family adjudication (routes/files.ts).
 *
 * Error discipline matches host-directory.ts: a command-level refusal
 * carries a stable code (invalid_path, ENOENT); an fs-level failure keeps its
 * Node code verbatim (ENOENT, EEXIST, EACCES — the dispatch failure mapping
 * preserves it); anything else is command_failed.
 */

/** bb resolveNonSymlinkDirectoryPath (root-path.ts:9-27): the declared root
 * must be a real directory — a symlinked root would make the containment
 * check below meaningless. */
async function requireRoot(rootPath: string | undefined): Promise<string | null> {
  if (rootPath === undefined) return null;
  if (!path.isAbsolute(rootPath)) {
    throw new HostRpcCommandError("invalid_path", "rootPath must be absolute");
  }
  const rootStat = await fs.lstat(rootPath);
  if (rootStat.isSymbolicLink()) {
    throw new HostRpcCommandError("invalid_path", `Root path "${rootPath}" must not be a symlink`);
  }
  if (!rootStat.isDirectory()) {
    throw new HostRpcCommandError("invalid_path", `Root path "${rootPath}" is not a directory`);
  }
  return fs.realpath(rootPath);
}

/** bb isPathWithinRoot (file-write.ts:46-55): the containment predicate every
 * root-confined write face shares. */
export function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/**
 * bb resolveWriteTarget (file-write.ts:73-106), minus the `parentMissing`
 * flag mkdir does not consume: resolve the target through symlinks even
 * though it may not exist yet — realpath the nearest existing ancestor and
 * re-append the missing segments. Containment (when a root is declared) is
 * checked against this resolved path, so a symlinked directory inside the
 * root cannot smuggle a write outside it.
 */
export async function resolveWriteTarget(
  resolvedPath: string,
  resultPath: string,
): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = resolvedPath;
  for (;;) {
    const real = await fs.realpath(candidate).catch((error: unknown) => {
      // bb isFsErrorWithCode(error, "ENOENT"): missing is the normal walk
      // state; anything else (EACCES, ENOTDIR) is a real failure.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (real !== null) {
      return path.join(real, ...missingSegments);
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      // bb createMissingTargetError (file-write.ts:57-64): no existing
      // ancestor all the way up — a stable ENOENT dispatch error.
      throw new HostRpcCommandError("ENOENT", `Path does not exist: ${resultPath}`);
    }
    missingSegments.unshift(path.basename(candidate));
    candidate = parent;
  }
}

/** bb mkdirHostPath (path-mutations.ts:78-92): absolute path in, one
 * directory created (recursive arm decides whether parents come along). */
export async function mkdirHostPath(command: HostMkdirCommand): Promise<HostPathMutationResult> {
  if (!path.isAbsolute(command.path)) {
    throw new HostRpcCommandError("invalid_path", "Path must be absolute");
  }
  const root = await requireRoot(command.rootPath);
  const target = await resolveWriteTarget(command.path, command.path);
  if (root !== null && !isPathWithinRoot(target, root)) {
    throw new HostRpcCommandError("invalid_path", `Path "${command.path}" escapes root`);
  }
  await fs.mkdir(target, { recursive: command.recursive });
  return { ok: true };
}
