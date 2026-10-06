import type { ProjectAttachmentContentResult, ProjectAttachmentReader } from "@cap/daemon-service";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import { getThreadRow } from "../db/control-plane.js";
import { getEnvironmentRow } from "../db/environments.js";
import { readAttachment } from "./attachments.js";
import { ApiError } from "../shared/api-error.js";
import type { Env } from "../env.js";

/**
 * #318 attachment pickup bridge — the deployment half of the daemon face's
 * `/internal/session/project-attachment-content` route. bb upstream checks
 * (internal/session.ts:149-192) mapped onto the composed stack:
 *
 * - thread lookup: unknown thread → 404 (bb requirePublicThreadEnvironment);
 * - `thread.projectId !== query.projectId` → 403 "Thread does not belong to
 *   project" (upstream verbatim: attachment paths are project-scoped upload
 *   tokens, so cross-check projectId before reading bytes);
 * - the thread's bound host (environments.host_id; null = the cloud
 *   placeholder, #377 — thread-binding §2.1's resolution, trajectory half is
 *   thread.created.machineId) must be the daemon asking → 403 "Host is not
 *   assigned to thread environment" (upstream verbatim). A placeholder-bound
 *   thread has no daemon attachment by construction, so the cross-check
 *   denies any daemon — the honest face for a thread with no real host.
 * - the byte read is A1's R2 attachment face (#316) — escape/missing/binding
 *   ApiErrors surface verbatim.
 */
export function projectAttachmentReader(env: Env): ProjectAttachmentReader {
  return async ({ hostId, query }): Promise<ProjectAttachmentContentResult> => {
    const thread = await getThreadRow(env, query.threadId);
    if (thread === null) {
      return { ok: false, status: 404, code: "not_found", message: "Thread not found" };
    }
    if (thread.deletedAt !== null) {
      return { ok: false, status: 404, code: "not_found", message: "Thread not found" };
    }
    if (thread.projectId !== query.projectId) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "Thread does not belong to project",
      };
    }

    let boundHostId = CLOUD_PLACEHOLDER_HOST_ID;
    if (thread.environmentId !== null) {
      const environment = await getEnvironmentRow(env, thread.environmentId);
      if (environment === null) {
        return {
          ok: false,
          status: 404,
          code: "not_found",
          message: "Thread environment not found",
        };
      }
      boundHostId = environment.hostId;
    }
    if (boundHostId !== hostId) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "Host is not assigned to thread environment",
      };
    }

    try {
      const attachment = await readAttachment(env.BLOBS, query.projectId, query.path);
      return {
        ok: true,
        bytes: new Uint8Array(await attachment.object.arrayBuffer()),
        ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
      };
    } catch (error) {
      if (error instanceof ApiError) {
        return {
          ok: false,
          status: error.status,
          code: error.code,
          message: error.message,
        };
      }
      return { ok: false, status: 500, code: "internal", message: "attachment read failed" };
    }
  };
}
