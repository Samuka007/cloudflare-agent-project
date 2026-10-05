/**
 * Attachment pickup transport (#318) — the daemon client half of bb's
 * `/internal/session/project-attachment-content` face. Upstream anchors:
 * `FetchProjectAttachmentArgs` / `FetchedProjectAttachment` /
 * `FetchProjectAttachment` are bb apps/host-daemon/src/project-attachments.ts
 * verbatim; `usesSecureInternalFetchTransport`, the content-length byte
 * verification and the streamed body read are bb
 * apps/host-daemon/src/server-client.ts:203-219/221-296/397-435.
 *
 * Adaptation: the query carries `hostId` (env-key auth ladder has no
 * key→host inversion; the service DO's live session binding is the
 * authority — the same posture session/open takes), and `sessionId` comes
 * from the live session handle instead of a client-side session store.
 */

export interface FetchProjectAttachmentArgs {
  expectedSizeBytes?: number;
  maxBytes: number;
  path: string;
  projectId: string;
  threadId: string;
}

export interface FetchedProjectAttachment {
  bytes: Uint8Array;
}

export type FetchProjectAttachment = (
  args: FetchProjectAttachmentArgs,
) => Promise<FetchedProjectAttachment>;

/**
 * bb server-client.ts:203-219: attachment bytes move only over HTTPS;
 * loopback deployments (the local rig's http://127.0.0.1/localhost/::1) are
 * the declared trusted-LAN exception.
 */
export function usesSecureInternalFetchTransport(serverUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  return (
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1"
  );
}

/** bb parseContentLength (server-client.ts:221-230). */
function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

/** bb validateProjectAttachmentPartialByteLength (server-client.ts:232-249):
 * mid-stream abort — never buffer past the declared ceiling. */
function validateProjectAttachmentPartialByteLength(
  args: FetchProjectAttachmentArgs,
  byteLength: number,
): void {
  if (args.expectedSizeBytes !== undefined && byteLength > args.expectedSizeBytes) {
    throw new Error(
      `Project attachment size mismatch: expected ${args.expectedSizeBytes} bytes, received more than ${args.expectedSizeBytes}`,
    );
  }
  if (byteLength > args.maxBytes) {
    throw new Error(
      `Project attachment exceeds ${args.maxBytes} byte limit: received ${byteLength}`,
    );
  }
}

/** bb validateProjectAttachmentFinalByteLength (server-client.ts:251-264). */
function validateProjectAttachmentFinalByteLength(
  args: FetchProjectAttachmentArgs,
  byteLength: number,
): void {
  if (args.expectedSizeBytes !== undefined && byteLength !== args.expectedSizeBytes) {
    throw new Error(
      `Project attachment size mismatch: expected ${args.expectedSizeBytes} bytes, received ${byteLength}`,
    );
  }
  validateProjectAttachmentPartialByteLength(args, byteLength);
}

/** bb readProjectAttachmentBytes (server-client.ts:266-296): stream the body
 * with the partial check on every chunk — a lying or runaway response dies
 * before it can fill memory. */
async function readProjectAttachmentBytes(
  response: Response,
  args: FetchProjectAttachmentArgs,
): Promise<Uint8Array> {
  if (!response.body) {
    validateProjectAttachmentFinalByteLength(args, 0);
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    validateProjectAttachmentPartialByteLength(args, totalBytes + result.value.byteLength);
    chunks.push(result.value);
    totalBytes += result.value.byteLength;
  }
  validateProjectAttachmentFinalByteLength(args, totalBytes);

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface ProjectAttachmentFetcherOptions {
  baseUrl: string;
  hostId: string;
  hostKey: string;
  /** The live session handle; pickup is session-scoped (bb requireSessionId). */
  getSessionId: () => string | null;
  /** Injectable transport (L1 rigs); defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Builds the FetchProjectAttachment the staging step consumes (bb
 * server-client.ts:397-435): insecure transport refused outright, the query
 * names (hostId, sessionId, threadId, projectId, path), the response's
 * content-length is verified against the declared expectation BEFORE the
 * body is read, then the streamed read re-verifies partial and final
 * lengths. Non-2xx answers surface the status + body text — the staging
 * step wraps every failure as attachment_unavailable (upstream
 * prompt-attachments.ts:209-214).
 */
export function createProjectAttachmentFetcher(
  options: ProjectAttachmentFetcherOptions,
): FetchProjectAttachment {
  const fetchFn = options.fetchFn ?? fetch;

  return async (args: FetchProjectAttachmentArgs): Promise<FetchedProjectAttachment> => {
    if (!usesSecureInternalFetchTransport(options.baseUrl)) {
      throw new Error(
        `Refusing to fetch project attachment over insecure server URL: ${options.baseUrl}`,
      );
    }

    const sessionId = options.getSessionId();
    if (sessionId === null) {
      throw new Error("Server session is not open");
    }

    const url = new URL("/internal/session/project-attachment-content", options.baseUrl);
    for (const [key, value] of Object.entries({
      hostId: options.hostId,
      sessionId,
      threadId: args.threadId,
      projectId: args.projectId,
      path: args.path,
    })) {
      url.searchParams.set(key, value);
    }

    const response = await fetchFn(url, {
      method: "GET",
      headers: { authorization: `Bearer ${options.hostKey}` },
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `fetch project attachment failed with ${response.status}${bodyText ? `: ${bodyText}` : ""}`,
      );
    }

    const contentLength = parseContentLength(response.headers.get("content-length"));
    if (contentLength !== null) {
      validateProjectAttachmentFinalByteLength(args, contentLength);
    }

    const bytes = await readProjectAttachmentBytes(response, args);
    return { bytes };
  };
}
