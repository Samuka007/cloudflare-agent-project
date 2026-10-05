import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PromptContent } from "@cap/protocol";
import type { FetchProjectAttachment } from "./project-attachments.js";

/**
 * Attachment staging (#318) — bb
 * apps/host-daemon/src/command-handlers/prompt-attachments.ts (commit
 * d2ab40f0) ported onto the #317 prompt-content union. Upstream semantics
 * verbatim: relative-path localImage/localFile members are picked up over
 * the internal attachment route and landed under
 * `<threadStorageRoot>/<threadId>/Attachments/` with a sanitized filename,
 * a `-2`-style dedup suffix and mode 0600; size limits mirror the server's
 * (10MB images / 25MB files); every failure path cleans every staged file
 * and the staging directory, and failures surface as
 * `attachment_unavailable` (path escape → `invalid_path`).
 *
 * Deliberately not ported: `stagePromptAttachmentGroups` (the steer
 * inputGroups twin — our dispatch frame carries one flat input list) and the
 * unused `requestId` arg. Upstream's CommandDispatchError becomes
 * AttachmentStageError — same codes, same messages; the dispatch layer
 * renders the message into the tool result (the wire has no errorCode slot).
 *
 * Staged files intentionally OUTLIVE a successful dispatch (upstream cleans
 * only staging/post-staging-dispatch failures — thread storage is the
 * attachment's home for the rest of the thread's life).
 */

/** bb IMAGE_ATTACHMENT_LIMIT_BYTES / FILE_ATTACHMENT_LIMIT_BYTES (:15-16). */
const IMAGE_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;
const FILE_ATTACHMENT_LIMIT_BYTES = 25 * 1024 * 1024;
/** bb STAGED_ATTACHMENT_MODE (:17) — daemon-private files. */
const STAGED_ATTACHMENT_MODE = 0o600;

export type AttachmentPromptContent = Extract<PromptContent, { type: "localImage" | "localFile" }>;

/** Upstream CommandDispatchError shape, narrowed to the two staging codes. */
export class AttachmentStageError extends Error {
  constructor(
    readonly code: "attachment_unavailable" | "invalid_path",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentStageError";
  }
}

export interface StagePromptAttachmentsArgs {
  fetchProjectAttachment: FetchProjectAttachment;
  input: readonly PromptContent[];
  projectId: string;
  threadStorageRootPath: string;
  threadId: string;
}

export interface StagedPromptAttachments {
  cleanup: () => Promise<void>;
  input: PromptContent[];
}

/**
 * bb pathLooksRuntimeReadable (:55-61): absolute paths and URI-like values
 * ride to the runtime untouched. The twin pattern lives server-side
 * (server-worker attachments.ts RUNTIME_READABLE_PATH_PATTERN) — one
 * convention across the stack.
 */
export function pathLooksRuntimeReadable(rawPath: string): boolean {
  return /^(?:[\\/]|[a-zA-Z][a-zA-Z0-9+.-]*:)/u.test(rawPath);
}

/** bb shouldStageAttachment (:63-70). */
function shouldStageAttachment(input: PromptContent): input is AttachmentPromptContent {
  if (input.type !== "localFile" && input.type !== "localImage") {
    return false;
  }
  return !pathLooksRuntimeReadable(input.path);
}

/** bb attachmentFilename (:72-81): presentation name for localFile, else the
 * reference path; posix basename; sanitize; non-empty fallback. */
function attachmentFilename(attachment: AttachmentPromptContent): string {
  const rawName =
    attachment.type === "localFile" && attachment.name ? attachment.name : attachment.path;
  const normalized = rawName.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  const sanitized = basename.replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return sanitized.length > 0 ? sanitized : "attachment";
}

/** bb attachmentSizeLimitBytes (:87-91). */
function attachmentSizeLimitBytes(attachment: AttachmentPromptContent): number {
  return attachment.type === "localImage"
    ? IMAGE_ATTACHMENT_LIMIT_BYTES
    : FILE_ATTACHMENT_LIMIT_BYTES;
}

/** bb expectedAttachmentSizeBytes (:93-97): only localFile declares an
 * expected size; images verify against the limit alone. */
function expectedAttachmentSizeBytes(attachment: AttachmentPromptContent): number | undefined {
  return attachment.type === "localFile" ? attachment.sizeBytes : undefined;
}

/** bb validateExpectedAttachmentSize (:99-108). */
function validateExpectedAttachmentSize(args: StageAttachmentArgs): void {
  const expectedSizeBytes = expectedAttachmentSizeBytes(args.attachment);
  const maxBytes = attachmentSizeLimitBytes(args.attachment);
  if (expectedSizeBytes !== undefined && expectedSizeBytes > maxBytes) {
    throw new AttachmentStageError(
      "attachment_unavailable",
      `Attachment ${args.attachment.path} exceeds ${maxBytes} byte limit`,
    );
  }
}

/** bb validateFetchedAttachmentSize (:110-132). */
function validateFetchedAttachmentSize(
  attachment: AttachmentPromptContent,
  bytes: Uint8Array,
): void {
  const expectedSizeBytes = expectedAttachmentSizeBytes(attachment);
  if (expectedSizeBytes !== undefined && bytes.byteLength !== expectedSizeBytes) {
    throw new AttachmentStageError(
      "attachment_unavailable",
      `Attachment ${attachment.path} size mismatch: expected ${expectedSizeBytes} bytes, received ${bytes.byteLength}`,
    );
  }

  const maxBytes = attachmentSizeLimitBytes(attachment);
  if (bytes.byteLength > maxBytes) {
    throw new AttachmentStageError(
      "attachment_unavailable",
      `Attachment ${attachment.path} exceeds ${maxBytes} byte limit`,
    );
  }
}

/**
 * bb requireContainedPath (:134-146) — the @bb/process-utils
 * resolveContainedPath dependency inlined: posix-resolve the candidate
 * against the root and reject anything that escapes it.
 */
function requireContainedPath(rootPath: string, candidatePath: string): string {
  const resolved = path.resolve(rootPath, candidatePath);
  if (resolved !== rootPath && !resolved.startsWith(rootPath + path.sep)) {
    throw new AttachmentStageError(
      "invalid_path",
      "Attachment staging path escapes the thread storage root",
    );
  }
  return resolved;
}

/** bb resolveStagingDir (:148-157): <root>/<threadId>/Attachments, both legs
 * containment-checked. */
function resolveStagingDir(args: StagePromptAttachmentsArgs): string {
  const threadDir = requireContainedPath(
    args.threadStorageRootPath,
    path.join(args.threadStorageRootPath, args.threadId),
  );
  return requireContainedPath(args.threadStorageRootPath, path.join(threadDir, "Attachments"));
}

/** bb appendFilenameSuffix (:159-165): suffix before the extension. */
function appendFilenameSuffix(filename: string, suffix: string): string {
  const extension = path.extname(filename);
  if (!extension) {
    return `${filename}${suffix}`;
  }
  return `${filename.slice(0, -extension.length)}${suffix}${extension}`;
}

/** bb uniqueStagedPath (:167-182): first collision-free candidate, `-2`,
 * `-3`, … (within one staging call; cross-dispatch re-staging is
 * deterministic and overwrites the same content-addressed bytes). */
function uniqueStagedPath(
  stagingDir: string,
  filename: string,
  stagedPaths: readonly string[],
): string {
  let candidate = path.join(stagingDir, filename);
  let suffix = 2;
  while (stagedPaths.includes(candidate)) {
    candidate = path.join(stagingDir, appendFilenameSuffix(filename, `-${suffix}`));
    suffix += 1;
  }
  return candidate;
}

/** bb cleanupStagedAttachments (:184-194): every file, then the directory
 * (best-effort — a non-empty rmdir means someone else's file lives there). */
async function cleanupStagedAttachments(
  stagingDir: string,
  stagedPaths: readonly string[],
): Promise<void> {
  await Promise.all(
    stagedPaths.map((stagedPath) => rm(stagedPath, { force: true, recursive: false })),
  );
  await rmdir(stagingDir).catch(() => undefined);
}

interface StageAttachmentArgs extends StagePromptAttachmentsArgs {
  attachment: AttachmentPromptContent;
  stagedPath: string;
}

/** bb stageAttachment (:196-219): pre-check, fetch (any failure →
 * attachment_unavailable with the upstream message), re-verify bytes, write
 * 0600. */
async function stageAttachment(args: StageAttachmentArgs): Promise<string> {
  validateExpectedAttachmentSize(args);

  let bytes: Uint8Array;
  try {
    const attachment = await args.fetchProjectAttachment({
      expectedSizeBytes: expectedAttachmentSizeBytes(args.attachment),
      maxBytes: attachmentSizeLimitBytes(args.attachment),
      projectId: args.projectId,
      threadId: args.threadId,
      path: args.attachment.path,
    });
    bytes = attachment.bytes;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AttachmentStageError(
      "attachment_unavailable",
      `Failed to fetch attachment ${args.attachment.path}: ${message}`,
    );
  }

  validateFetchedAttachmentSize(args.attachment, bytes);
  await writeFile(args.stagedPath, bytes, { mode: STAGED_ATTACHMENT_MODE });
  return args.stagedPath;
}

/** bb stagePromptInputList (:221-246): non-attachments (text/image,
 * absolute-path members) pass through; staged members carry their staged
 * absolute path. */
async function stagePromptInputList(
  args: StagePromptAttachmentsArgs & { stagedPaths: string[]; stagingDir: string },
): Promise<PromptContent[]> {
  const stagedInput: PromptContent[] = [];
  for (const input of args.input) {
    if (!shouldStageAttachment(input)) {
      stagedInput.push(input);
      continue;
    }
    const stagedPath = uniqueStagedPath(
      args.stagingDir,
      attachmentFilename(input),
      args.stagedPaths,
    );
    stagedInput.push({
      ...input,
      path: await stageAttachment({
        ...args,
        attachment: input,
        stagedPath,
      }),
    });
    args.stagedPaths.push(stagedPath);
  }
  return stagedInput;
}

/**
 * bb stagePromptAttachments (:248-276). Fast path: no member needs staging →
 * the input is returned untouched with a no-op cleanup. Otherwise the
 * staging dir is created and every member is staged; ANY failure cleans
 * every file staged so far and rethrows.
 */
export async function stagePromptAttachments(
  args: StagePromptAttachmentsArgs,
): Promise<StagedPromptAttachments> {
  if (!args.input.some(shouldStageAttachment)) {
    return {
      cleanup: () => Promise.resolve(undefined),
      input: [...args.input],
    };
  }

  const stagingDir = resolveStagingDir(args);
  await mkdir(stagingDir, { recursive: true });

  const stagedPaths: string[] = [];
  try {
    const input = await stagePromptInputList({
      ...args,
      stagedPaths,
      stagingDir,
    });
    return {
      cleanup: () => cleanupStagedAttachments(stagingDir, stagedPaths),
      input,
    };
  } catch (error) {
    await cleanupStagedAttachments(stagingDir, stagedPaths);
    throw error;
  }
}

/**
 * bb thread.ts:67-75 cleanupAfterPostStagingFailure: the cleanup runs when
 * the dispatch fails AFTER staging succeeded; a cleanup error never
 * replaces the original failure.
 */
export async function cleanupAfterPostStagingFailure(cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch {
    // Preserve the runtime/dispatch failure that triggered cleanup.
  }
}
