import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  HostFileReadResult,
  HostFileWriteResult,
  HostReadFileCommand,
  HostWriteFileCommand,
} from "../protocol.js";
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
 * B2 (#322): the write face serves agent-produced images only — the same
 * 10 MB image cap the read face enforces (a write over the cap could never
 * render through GET /threads/:id/host-files/content, so it fails closed
 * at the write, with the read face's own code and message shape).
 */
const THREAD_FILE_WRITE_LIMIT_BYTES = IMAGE_FILE_SIZE_LIMIT_BYTES;
/** bb STAGED_ATTACHMENT_MODE (prompt-attachments.ts:17) — daemon-private files. */
const WRITTEN_FILE_MODE = 0o600;
/** Thread-scoped file home under the sandbox root (bb threadStorageRootPath
 * posture: `<root>/<threadId>/…`; `Generated` separates agent-produced files
 * from the A3 user-attachment staging dir). */
const GENERATED_DIR_NAME = "Generated";

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

/**
 * B2 (#322): the daemon side of `host.write_file`. bb has no upstream
 * anchor for this command (agent-produced images are an omp edge-device
 * face, docs/tools/generate_image.md §Side Effects — omp writes the OS
 * tempdir because its edge IS the machine); the semantics port bb's
 * staging discipline instead (prompt-attachments.ts): a sanitized
 * filename, a containment-checked thread-scoped directory, `-2`-style
 * dedup on collision, mode 0600. The response's absolute path is what
 * the imageView row and the content face address — nothing else about
 * the location is caller-visible.
 */
export async function writeThreadFile(
  command: HostWriteFileCommand,
  sandboxRoot: string,
): Promise<HostFileWriteResult> {
  const root = path.resolve(sandboxRoot);
  const threadId = requirePathLeg(command.threadId);
  const generatedDir = requireContainedDir(root, path.join(threadId, GENERATED_DIR_NAME));

  const filename = sanitizeFilename(command.filename);
  const bytes = decodeBase64(command.contentBase64, filename);
  if (bytes.byteLength > THREAD_FILE_WRITE_LIMIT_BYTES) {
    throw new HostRpcCommandError(
      "file_too_large",
      `File size ${bytes.byteLength} bytes exceeds the ${Math.floor(THREAD_FILE_WRITE_LIMIT_BYTES / (1024 * 1024))} MB limit`,
    );
  }

  await fs.mkdir(generatedDir, { recursive: true });
  const target = await uniquePath(generatedDir, filename);
  await fs.writeFile(target, bytes, { mode: WRITTEN_FILE_MODE });
  return { path: target, sizeBytes: bytes.byteLength };
}

/** The threadId leg is remote input: it must be one plain path segment —
 * no separators, no dot legs — before any resolve happens. */
function requirePathLeg(leg: string): string {
  if (leg === "" || leg === "." || leg === ".." || leg.includes("/") || leg.includes("\\")) {
    throw new HostRpcCommandError("invalid_path", "Thread id must be a single path segment");
  }
  return leg;
}

/** Resolve a join under the sandbox root and reject anything that escapes
 * it (bb requireContainedPath, prompt-attachments.ts:134-146). */
function requireContainedDir(root: string, leg: string): string {
  const resolved = path.resolve(root, leg);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HostRpcCommandError("invalid_path", "Thread file path escapes the sandbox root");
  }
  return resolved;
}

/** bb attachmentFilename (:72-81) sanitize: posix basename, non-name
 * runs to `-`, non-empty fallback. Empty-after-sanitize input can never
 * smuggle separators or `..`. */
function sanitizeFilename(raw: string): string {
  const basename = path.posix.basename(raw.replaceAll("\\", "/"));
  const sanitized = basename.replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return sanitized.length > 0 && sanitized !== "." && sanitized !== ".."
    ? sanitized
    : "generated-image";
}

/** Strict base64 → bytes: whitespace-padded JSON strings tolerated, any
 * other corruption is a bad_request-class dispatch error, not a silent
 * truncation. */
function decodeBase64(contentBase64: string, filename: string): Buffer {
  const decoded = Buffer.from(contentBase64, "base64");
  // Node/bun ignore invalid characters silently; round-trip length is the
  // cheap integrity check (4 chars → 3 bytes, modulo padding).
  const expectedLength = Math.floor(contentBase64.trim().length * 0.75);
  if (decoded.length === 0 || decoded.length < expectedLength - 2) {
    throw new HostRpcCommandError(
      "invalid_path",
      `File ${filename} carries malformed base64 content`,
    );
  }
  return decoded;
}

/** bb uniqueStagedPath (:167-182) shape, existence-based: first
 * collision-free candidate on disk, `-2`, `-3`, … (cross-call writes to
 * the same second must not overwrite each other). */
async function uniquePath(dir: string, filename: string): Promise<string> {
  let candidate = path.join(dir, filename);
  let suffix = 2;
  for (;;) {
    const exists = await fs
      .access(candidate)
      .then(() => true)
      .catch(() => false);
    if (!exists) return candidate;
    candidate = path.join(dir, appendFilenameSuffix(filename, `-${suffix}`));
    suffix += 1;
  }
}

/** bb appendFilenameSuffix (:159-165): suffix before the extension. */
function appendFilenameSuffix(filename: string, suffix: string): string {
  const extension = path.extname(filename);
  if (!extension) {
    return `${filename}${suffix}`;
  }
  return `${filename.slice(0, -extension.length)}${suffix}${extension}`;
}
