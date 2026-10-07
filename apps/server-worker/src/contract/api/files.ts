//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic
// edits. Only the mkdir face of the family is mirrored here — the #494
// adjudication (routes/files.ts) defers the rest.
//
import { z } from "zod";

/**
 * #494: POST /files/mkdir request — bb hostMkdirRequestSchema
 * (server-contract/src/api/files.ts:63-71). `hostId` omission has real
 * semantics: the server resolves it to the primary host once at the route
 * boundary. `rootPath`, when set, confines the resolved target beneath that
 * absolute root on the daemon side.
 */
export const hostMkdirRequestSchema = z
  .object({
    hostId: z.string().min(1).optional(),
    path: z.string().min(1),
    rootPath: z.string().min(1).optional(),
    recursive: z.boolean().optional(),
  })
  .strict();
export type HostMkdirRequest = z.infer<typeof hostMkdirRequestSchema>;

/**
 * #494: the daemon `host.mkdir` result, mirrored from @cap/daemon-service
 * hostPathMutationResultSchema (bb hostPathMutationResultSchema,
 * host-daemon-contract commands.ts:1300-1302) — the route validates the RPC
 * answer with this before answering 200.
 */
export const hostPathMutationResultSchema = z.object({ ok: z.literal(true) });
export type HostPathMutationResult = z.infer<typeof hostPathMutationResultSchema>;
