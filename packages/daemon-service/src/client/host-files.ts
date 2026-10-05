import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { HostFileReadResult, HostReadFileCommand } from "../protocol.js";
import { HostRpcCommandError } from "./host-directory.js";

/**
 * B1 (#321): the daemon side of `host.read_file` — the rootless subset of bb
 * readHostFile (apps/host-daemon/src/command-handlers/host-files.ts:195-221)
 * + readFileForTransport (command-handlers/file-read.ts:302-341) behind the
 * thread host-file content face (`GET /threads/:id/host-files/content`).
 * Agent-produced images live on the host disk; this is the byte channel that
 * lets the SPA lightbox render them.
 *
 * bb verbatim terms: absolute-path assertion (file-read.ts:51-60), the
 * directory refusal (file-read.ts:309-314), the image/non-image size caps
 * (file-read.ts:15-16, 84-88), the base64/utf8 content-encoding split
 * (file-read.ts:98-110), and the result shape (contract fileReadResultSchema
 * → protocol hostFileReadResultSchema). ENOENT keeps its Node code so the
 * server's route remap (bb remapDaemonFileRouteError) answers 404.
 *
 * One port deviation: bb resolves mime via the `mime-types` package; this
 * runtime carries no such dependency, so lookupMimeType below ports the
 * subset the face serves (renderable images + common documents). Unknown
 * extensions surface as `application/octet-stream` — the same terminal value
 * bb reaches when mime-types misses.
 */

export const IMAGE_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
export const NON_IMAGE_FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;

/**
 * bb `isBinaryImageMimeType` (file-read.ts:78-82) on the local table: every
 * image/* entry except svg is a binary image for cap/encoding purposes.
 */
function isBinaryImageMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType && mimeType.startsWith("image/") && mimeType !== "image/svg+xml");
}

/** bb getFileSizeLimitBytes (file-read.ts:84-88). */
function getFileSizeLimitBytes(mimeType: string | undefined): number {
  return isBinaryImageMimeType(mimeType)
    ? IMAGE_FILE_SIZE_LIMIT_BYTES
    : NON_IMAGE_FILE_SIZE_LIMIT_BYTES;
}

/** bb getContentEncoding (file-read.ts:98-110): images ride base64; other
 * payloads stay utf8 while they are valid UTF-8, else base64. */
function getContentEncoding(contents: Buffer, mimeType: string | undefined): "base64" | "utf8" {
  if (isBinaryImageMimeType(mimeType)) return "base64";
  return isUtf8(contents) ? "utf8" : "base64";
}

/**
 * bb mimeTypes.lookup port, truncated to the face's population: images the
 * SPA renders plus common document/binary types. Lowercased extension →
 * mime; misses are undefined (octet-stream downstream), matching bb.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  xml: "application/xml",
  zip: "application/zip",
};

function lookupMimeType(filePath: string): string | undefined {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (extension === "") return undefined;
  return MIME_BY_EXTENSION[extension];
}

/** bb readHostFile (host-files.ts:195-221) minus the ref/rootPath terms this
 * face does not carry: the command path is the absolute disk path, read and
 * echoed verbatim. */
export async function readHostFile(command: HostReadFileCommand): Promise<HostFileReadResult> {
  if (!path.isAbsolute(command.path)) {
    throw new HostRpcCommandError("invalid_path", "Path must be absolute");
  }

  const stat = await fs.stat(command.path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // bb createMissingTargetError (file-read.ts:112-119) via the
      // throwMissingTargetOrRethrow normalizations: a missing target is a
      // stable ENOENT dispatch error, not a raw crash.
      throw new HostRpcCommandError("ENOENT", `Path does not exist: ${command.path}`);
    }
    throw error;
  });
  if (stat.isDirectory()) {
    throw new HostRpcCommandError("invalid_path", "Path is a directory, not a file");
  }

  const mimeType = lookupMimeType(command.path);
  const fileSizeLimitBytes = getFileSizeLimitBytes(mimeType);
  if (stat.size > fileSizeLimitBytes) {
    throw new HostRpcCommandError(
      "file_too_large",
      `File size ${stat.size} bytes exceeds the ${Math.floor(fileSizeLimitBytes / (1024 * 1024))} MB limit`,
    );
  }

  const contents = await fs.readFile(command.path);
  const contentEncoding = getContentEncoding(contents, mimeType);
  return {
    path: command.path,
    content:
      contentEncoding === "utf8" ? contents.toString("utf8") : contents.toString("base64"),
    contentEncoding,
    ...(mimeType !== undefined ? { mimeType } : {}),
    modifiedAtMs: stat.mtimeMs,
    sha256: createHash("sha256").update(contents).digest("hex"),
    sizeBytes: stat.size,
  };
}
