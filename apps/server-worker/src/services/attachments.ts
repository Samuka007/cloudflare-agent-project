import type { UploadedPromptAttachment } from "../contract/api/projects.js";
import type { PromptInput } from "../contract/domain/shared-types.js";
import { ApiError } from "../shared/api-error.js";

/**
 * Project attachment storage on R2 — bb
 * apps/server/src/services/projects/attachments.ts (commit d2ab40f0) with the
 * "might move this to something like R2 or S3" comment made real (#316).
 *
 * bb stored files under
 * `<dataDir>/attachments/<projectId>/<stem>-<ts>-<rand><ext>` and resolved
 * client-supplied paths against that directory (resolveContainedPath). Here
 * the per-project directory is an R2 key family
 * `attachment/<projectId>/<sha256><ext>` (research §3 A1 对象键项目域): the
 * stored name is content-addressed, so the sha256 every path carries doubles
 * as the integrity check the daemon pickup face (A3) verifies bytes against,
 * and re-uploading identical bytes converges on the same object. Mime type
 * and the (sanitized) original filename ride R2 httpMetadata/customMetadata
 * instead of a filesystem extension lookup.
 *
 * This reuses the {@link https://github.com/Samuka007/cloudflare-agent-project | BlobRef}
 * precedent shape (key + size + sha256, packages/agent-do/src/event-log.ts)
 * but is a separate object family — never the `blob/<threadId>/...` event
 * string bypass.
 */

/** bb IMAGE_LIMIT_BYTES / FILE_LIMIT_BYTES (attachments.ts:10-11). */
export const IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;
export const FILE_LIMIT_BYTES = 25 * 1024 * 1024;

const ATTACHMENT_KEY_ROOT = "attachment";

function attachmentKey(projectId: string, name: string): string {
  return `${ATTACHMENT_KEY_ROOT}/${projectId}/${name}`;
}

function missingR2Binding(): ApiError {
  return new ApiError({
    status: 500,
    code: "internal",
    message: "attachment storage requires an R2 binding but none is configured",
    retryable: false,
  });
}

/** bb sanitizeFilename (attachments.ts:29-32), minus node:path basename. */
function sanitizeFilename(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1).replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return base.length > 0 ? base : "attachment";
}

/** node:path extname for already-basenames (leading dot is not an extension). */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * bb resolveAttachmentPath (attachments.ts:41-69) flattened onto the key
 * family: the caller's path is project-relative, so posix-resolve it against
 * the (virtual) project dir and reject anything that would escape
 * `attachment/<projectId>/`. The upstream error messages are preserved
 * verbatim; a contained-but-nonexistent path surfaces as the same 404 as a
 * plain absent attachment, exactly like the filesystem port did.
 */
export function resolveAttachmentName(projectId: string, path: string): string {
  // node resolve() anchors absolute candidates at the filesystem root, where
  // resolveContainedPath then rejects them.
  if (path.startsWith("/") || path.startsWith("\\")) {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: "Attachment path escapes project directory",
    });
  }
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.pop() === undefined) {
        throw new ApiError({
          status: 400,
          code: "invalid_request",
          message: "Attachment path escapes project directory",
        });
      }
      continue;
    }
    segments.push(segment);
  }
  const normalized = segments.join("/");
  // Resolving to the project dir itself is bb's "candidate === dir" case.
  if (normalized === "") {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: "Attachment path must refer to a file inside the project directory",
    });
  }
  return normalized;
}

/** bb pathLooksRuntimeReadable (attachments.ts:87-96): absolute paths and
 * URI-like (`scheme:`) values ride to the runtime untouched; everything else
 * is a server-managed attachment reference the send face must verify. */
const RUNTIME_READABLE_PATH_PATTERN = /^(?:[\\/]|[a-zA-Z][a-zA-Z0-9+.-]*:)/u;

/**
 * bb validatePromptAttachmentReferences (attachments.ts:97-138), ported onto
 * the R2 family: a relative localImage/localFile path must resolve inside the
 * sending project's attachment family (containment 400s from
 * resolveAttachmentName) and already exist there (the upload face minted it);
 * a contained-but-missing reference is bb's 400 "was not uploaded". Absolute
 * and URI-like paths are runtime-readable and pass through unvalidated.
 */
export async function validatePromptAttachmentReferences(
  blobs: R2Bucket | undefined,
  projectId: string,
  input: readonly PromptInput[],
): Promise<void> {
  for (const entry of input) {
    if (entry.type !== "localImage" && entry.type !== "localFile") {
      continue;
    }
    if (RUNTIME_READABLE_PATH_PATTERN.test(entry.path)) {
      continue;
    }
    if (blobs === undefined) {
      throw missingR2Binding();
    }
    const name = resolveAttachmentName(projectId, entry.path);
    const object = await blobs.head(attachmentKey(projectId, name));
    if (object === null) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: `attachment ${entry.path} was not uploaded`,
      });
    }
  }
}

async function getAttachment(
  blobs: R2Bucket,
  projectId: string,
  name: string,
): Promise<R2ObjectBody> {
  const object = await blobs.get(attachmentKey(projectId, name));
  if (object === null) {
    throw new ApiError({ status: 404, code: "invalid_request", message: "Attachment not found" });
  }
  return object;
}

/** bb storeAttachment (attachments.ts:122-153): sniff, limit, persist. */
export async function storeAttachment(
  blobs: R2Bucket | undefined,
  projectId: string,
  file: File,
): Promise<UploadedPromptAttachment> {
  const isImage = (file.type || "").startsWith("image/");
  const sizeLimit = isImage ? IMAGE_LIMIT_BYTES : FILE_LIMIT_BYTES;
  if (file.size > sizeLimit) {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: `Attachment exceeds ${Math.floor(sizeLimit / (1024 * 1024))}MB limit`,
    });
  }
  if (blobs === undefined) {
    throw missingR2Binding();
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = toHex(new Uint8Array(digest));
  const storedName = `${sha256}${extensionOf(sanitizeFilename(file.name))}`;
  await blobs.put(attachmentKey(projectId, storedName), bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { name: sanitizeFilename(file.name), sha256 },
  });

  return {
    type: isImage ? "localImage" : "localFile",
    path: storedName,
    name: file.name,
    mimeType: file.type || undefined,
    sizeBytes: file.size,
  };
}

export interface ReadAttachmentResult {
  /** Streamed straight into the response; never buffered. */
  object: R2ObjectBody;
  mimeType?: string;
}

/** bb readAttachment (attachments.ts:155-172); mime comes from R2 metadata. */
export async function readAttachment(
  blobs: R2Bucket | undefined,
  projectId: string,
  path: string,
): Promise<ReadAttachmentResult> {
  if (blobs === undefined) {
    throw missingR2Binding();
  }
  const name = resolveAttachmentName(projectId, path);
  const object = await getAttachment(blobs, projectId, name);
  return { object, mimeType: object.httpMetadata?.contentType ?? undefined };
}

/**
 * bb copyProjectAttachments (attachments.ts:174-208): re-anchor each source
 * path under the target project's family. Sequential per-path read→write
 * (not the upstream Promise.all) keeps peak memory at one object for the
 * schema-bounded ≤100 paths; the no-op rules are upstream verbatim.
 */
export async function copyProjectAttachments(
  blobs: R2Bucket | undefined,
  sourceProjectId: string,
  targetProjectId: string,
  attachmentPaths: readonly string[],
): Promise<void> {
  if (sourceProjectId === targetProjectId || attachmentPaths.length === 0) {
    return;
  }
  if (blobs === undefined) {
    throw missingR2Binding();
  }

  const seen: Record<string, true> = {};
  for (const attachmentPath of attachmentPaths) {
    if (seen[attachmentPath] === true) {
      continue;
    }
    seen[attachmentPath] = true;
    const name = resolveAttachmentName(sourceProjectId, attachmentPath);
    const source = await getAttachment(blobs, sourceProjectId, name);
    const bytes = new Uint8Array(await source.arrayBuffer());
    await blobs.put(attachmentKey(targetProjectId, name), bytes, {
      httpMetadata: source.httpMetadata,
      customMetadata: source.customMetadata,
    });
  }
}
