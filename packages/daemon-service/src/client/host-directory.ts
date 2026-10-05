import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostBrowseDirectoryCommand, HostDirectoryListing } from "../protocol.js";

/**
 * #302: the daemon side of `host.browse_directory` — verbatim port of bb's
 * browseHostDirectory (apps/host-daemon/src/command-handlers/host-files.ts:
 * 130-184), the single-level listing behind the Add-project path browser.
 * bb contract anchors: home default (commands.ts:623-628), listing shape
 * (commands.ts:678-692), invalid_path dispatch errors (host-files.ts:130-147).
 *
 * Error discipline follows bb's command dispatch (command-dispatch-support.ts:
 * 159-180): a command-level refusal carries a stable code (invalid_path);
 * an fs-level failure keeps its Node code (ENOENT, EACCES); anything else is
 * command_failed. The server maps the code verbatim into its ApiError.
 */
export class HostRpcCommandError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "HostRpcCommandError";
  }
}

/** bb DIRECTORY_BROWSE_SKIP_NAMES (host-files.ts:121): noise a project
 * browser never needs, hidden regardless of dot visibility. */
const DIRECTORY_BROWSE_SKIP_NAMES: Record<string, true> = { node_modules: true };

/** bb compareDirectoryEntries (host-files.ts:123-128): directories first,
 * then case-insensitive locale order. */
function compareDirectoryEntries(
  a: { kind: "file" | "directory"; name: string },
  b: { kind: "file" | "directory"; name: string },
): number {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export async function browseHostDirectory(
  command: HostBrowseDirectoryCommand,
): Promise<HostDirectoryListing> {
  const requestedPath = command.path ?? os.homedir();
  if (!path.isAbsolute(requestedPath)) {
    throw new HostRpcCommandError("invalid_path", "Path must be absolute");
  }

  // Follow a symlinked base directory: single-level browsing has no recursion
  // loop risk (unlike the recursive lister), and users legitimately navigate
  // through symlinked folders (bb host-files.ts:138-141).
  const stat = await fs.stat(requestedPath).catch((error: unknown) => {
    throw hostFsError(error, requestedPath);
  });
  if (!stat.isDirectory()) {
    throw new HostRpcCommandError("invalid_path", `Path "${requestedPath}" is not a directory`);
  }
  const directory = await fs.realpath(requestedPath);

  const dirents = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    throw hostFsError(error, requestedPath);
  });
  const entries: HostDirectoryListing["entries"] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    if (Object.hasOwn(DIRECTORY_BROWSE_SKIP_NAMES, dirent.name)) continue;

    const fullPath = path.join(directory, dirent.name);
    let kind: "file" | "directory";
    if (dirent.isSymbolicLink()) {
      // Classify by the symlink target; skip broken links.
      try {
        kind = (await fs.stat(fullPath)).isDirectory() ? "directory" : "file";
      } catch {
        continue;
      }
    } else if (dirent.isDirectory()) {
      kind = "directory";
    } else if (dirent.isFile()) {
      kind = "file";
    } else {
      continue; // sockets, fifos, devices — not browsable
    }

    entries.push({ kind, name: dirent.name, path: fullPath });
  }

  entries.sort(compareDirectoryEntries);

  const parent = path.dirname(directory);
  return {
    directory,
    parent: parent === directory ? null : parent,
    entries,
  };
}

/** bb getErrorCode (command-dispatch-support.ts:159-180) narrowed to the fs
 * face: a Node fs error keeps its code, everything else is command_failed. */
function hostFsError(error: unknown, requestedPath: string): Error {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    if (error.code === "ENOENT") {
      return new HostRpcCommandError("invalid_path", `Path "${requestedPath}" does not exist`);
    }
    return new HostRpcCommandError(error.code, `Path "${requestedPath}" could not be read`);
  }
  return new HostRpcCommandError("command_failed", `Path "${requestedPath}" could not be read`);
}
