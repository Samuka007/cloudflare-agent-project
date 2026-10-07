import { z } from "zod";
import {
  localFileContentSchema,
  localImageContentSchema,
  toolResultErrorCodeSchema,
} from "@cap/protocol";
import { DAEMON_PROTOCOL_VERSION } from "./constants.js";

/**
 * Daemon client ↔ daemon service DO WS frames (unified-turn-state §8).
 *
 * These shapes are NEW wire surface (the registry↔client sync protocol) and
 * therefore live in this package, not packages/protocol — promotion of the
 * settled subset into packages/protocol is the PM's call (single-source rule,
 * engineering.md practice 1). HTTP error envelopes reuse @cap/protocol.
 *
 * Two binding corrections from docs/research/omp-engine-portability.md §2 /
 * dead-end notes are baked in: every execution-bearing frame carries BOTH
 * `threadId` and `executionId` (omp frames lack threadId only because
 * process==session there — we have no such premise), and disconnect is an
 * explicit-abort policy (§8.5 judgment tree), never an implicit drain.
 */

export const PROTOCOL_VERSION = DAEMON_PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Shared fields.
// ---------------------------------------------------------------------------

export const observedStateSchema = z.enum(["running", "ended"]);
export type ObservedState = z.infer<typeof observedStateSchema>;

/** One entry of the boot.announce full snapshot (§8.2). */
export const observedExecutionSchema = z.object({
  executionId: z.string().min(1),
  threadId: z.string().min(1),
  pid: z.number().int(),
  pidStartedAt: z.number(),
  state: observedStateSchema,
  /** Client buffer base: bytes below this were evicted from the ring. */
  bufferedFromOffset: z.number().int().nonnegative(),
  finalOffset: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().nullable().optional(),
});
export type ObservedExecution = z.infer<typeof observedExecutionSchema>;

export const capabilitiesSchema = z.object({
  platform: z.string(),
  sandboxRoot: z.string(),
  protocolVersion: z.number().int(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

// ---------------------------------------------------------------------------
// Client → service frames.
// ---------------------------------------------------------------------------

export const bootAnnounceFrameSchema = z.object({
  type: z.literal("boot.announce"),
  bootId: z.string().min(1),
  protocolVersion: z.number().int(),
  capabilities: capabilitiesSchema,
  /** Monotonic per session, starts at 1 (§8.2). */
  generation: z.number().int().positive(),
  /** Full snapshot — never a delta (§8.2 watch-set.replace shape). */
  observed: z.array(observedExecutionSchema),
});
export type BootAnnounceFrame = z.infer<typeof bootAnnounceFrameSchema>;

export const heartbeatFrameSchema = z.object({
  type: z.literal("heartbeat"),
});

export const execStartedFrameSchema = z.object({
  type: z.literal("exec.started"),
  requestId: z.string(),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  pid: z.number().int(),
  pidStartedAt: z.number(),
});

export const execSpawnAckFrameSchema = z.object({
  type: z.literal("exec.spawn_ack"),
  requestId: z.string(),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  ok: z.boolean(),
  pid: z.number().int().optional(),
  pidStartedAt: z.number().optional(),
  error: z.string().optional(),
});

export const execOutputFrameSchema = z.object({
  type: z.literal("exec.output"),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  /** Absolute byte offset of this chunk in the merged output stream. */
  offset: z.number().int().nonnegative(),
  bytesBase64: z.string(),
});

export const execOutputGapFrameSchema = z.object({
  type: z.literal("exec.output_gap"),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

export const execExitedFrameSchema = z.object({
  type: z.literal("exec.exited"),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  finalOffset: z.number().int().nonnegative(),
  /** Set when the client's local timeout timer performed the kill. */
  reason: z.enum(["timeout"]).optional(),
});

/** Kill-list receipt, one per verified (or not) kill (§8.5). */
export const execKilledAckFrameSchema = z.object({
  type: z.literal("exec.killed_ack"),
  requestId: z.string(),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  /** true only when pid AND /proc start time matched (I22/I24 discipline). */
  verified: z.boolean(),
});

/**
 * Structured host-tool result (M1.5/T5'): the client's embedded omp runtime
 * projects omp AgentToolResult into the agent-do ToolResultPayload shape —
 * status/exitCode/output/outputTruncated travel verbatim. Bash (T9 #99)
 * carries the process exit code (omp details.exitCode — probe #4) so M0's
 * exit-code propagation survives the embedding; every other host tool pins
 * null. An omp isError or timeout is NOT an exit-code derivation.
 */
export const toolResultPayloadSchema = z.object({
  status: z.enum(["ok", "error", "timeout", "cancelled"]),
  exitCode: z.number().nullable(),
  output: z.string(),
  outputTruncated: z.boolean().optional(),
  /**
   * #454: structured refusal code when the tool never executed — the
   * @cap/protocol tool-results contract. The DO-side generation points
   * (dispatch host_offline placeholder, pre-dispatch rejections) set it;
   * a client never produces it today, the field keeps this wire twin
   * shape-identical with the agent-do ToolResultPayload seam.
   */
  errorCode: toolResultErrorCodeSchema.optional(),
  /**
   * B1 (#321): image artifacts the tool produced, by host-disk path — the
   * wire twin of agent-do ToolResultPayload.images. The DO folds each into
   * an `imageView` journal row (parentToolCallId = the executionId) before
   * the closing tool.result.
   */
  images: z.array(z.object({ path: z.string().min(1) })).optional(),
});

export const toolExitedFrameSchema = z.object({
  type: z.literal("tool.exited"),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  result: toolResultPayloadSchema,
});

// ---------------------------------------------------------------------------
// Host online RPC (#302) — bb's host-rpc transport (host-daemon-contract
// session.ts:359-492, commands.ts:623-692), command face subset: the control
// plane asks the connected daemon one-shot questions (directory browsing
// today). Wire names follow bb verbatim: `host-rpc.request` /
// `host-rpc.response`, failure carrying errorCode/errorMessage.
// ---------------------------------------------------------------------------

export const hostBrowseDirectoryCommandSchema = z.object({
  type: z.literal("host.browse_directory"),
  // Absolute directory to list. Omitted means the host's home directory,
  // which the daemon resolves — a remote caller has no way to know the
  // host's home (bb host-daemon-contract commands.ts:623-628).
  path: z.string().min(1).optional(),
});
export type HostBrowseDirectoryCommand = z.infer<typeof hostBrowseDirectoryCommandSchema>;

/**
 * B1 (#321): read one file at an absolute host path — the rootless subset of
 * bb `host.read_file` (host-daemon-contract commands.ts:487-491) that the
 * thread host-file content face needs. No `rootPath`/`ref` terms: those ride
 * the storage/workspace faces when a ticket opens them.
 */
export const hostReadFileCommandSchema = z.object({
  type: z.literal("host.read_file"),
  path: z.string().min(1),
});
export type HostReadFileCommand = z.infer<typeof hostReadFileCommandSchema>;

/**
 * B2 (#322): land one edge-produced image onto the host disk — the write
 * twin of the B1 read face. The command is thread-scoped, not
 * path-scoped: the daemon resolves `<sandboxRoot>/<threadId>/Generated/`
 * itself (a remote caller has no way to know the host's sandbox root —
 * same posture as browse_directory's home default), sanitizes the
 * filename and answers the ABSOLUTE path the bytes landed at, which is
 * what the imageView journal row and the host-file content face address.
 */
export const hostWriteFileCommandSchema = z.object({
  type: z.literal("host.write_file"),
  threadId: z.string().min(1),
  filename: z.string().min(1),
  /** Raw file bytes, base64 (the WS frame is JSON — there is no binary leg). */
  contentBase64: z.string().min(1),
});
export type HostWriteFileCommand = z.infer<typeof hostWriteFileCommandSchema>;

/**
 * #494: create one directory at an absolute host path — bb `host.mkdir`
 * (host-daemon-contract commands.ts:592-608; the Add-project folder
 * browser's "New folder"). `rootPath`, when declared, confines the
 * resolved target beneath that absolute root (bb path-mutations.ts:78-92);
 * omitted, the explicit absolute disk path is used as-is. Result:
 * hostPathMutationResultSchema.
 */
export const hostMkdirCommandSchema = z.object({
  type: z.literal("host.mkdir"),
  path: z.string().min(1),
  rootPath: z.string().min(1).optional(),
  recursive: z.boolean(),
});
export type HostMkdirCommand = z.infer<typeof hostMkdirCommandSchema>;

/** bb hostPathMutationResultSchema (commands.ts:1300-1302): the mkdir/move/
 * remove answer — nothing to report but success. */
export const hostPathMutationResultSchema = z.object({ ok: z.literal(true) });
export type HostPathMutationResult = z.infer<typeof hostPathMutationResultSchema>;

/**
 * #447: run provider /models discovery ON the host and return metadata-
 * enriched rows. The edge (Workers) cannot run omp's pi-catalog enrichment
 * face (bundled catalog + models.dev hydration need the Bun host —
 * `Bun.zstdDecompress`), so the control plane delegates the whole probe to
 * the connected daemon and consumes the enriched list. `api` is the row's
 * declared family hint ("anthropic" | "openai-responses" | …, free-form);
 * it selects the auth-header convention (anthropic → x-api-key +
 * anthropic-version, else Bearer — the probeProviderConnection family
 * conventions) and echoes onto every enriched row.
 */
export const hostDiscoverModelsCommandSchema = z.object({
  type: z.literal("host.discover_models"),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1).optional(),
  api: z.string().min(1).nullable().optional(),
});
export type HostDiscoverModelsCommand = z.infer<typeof hostDiscoverModelsCommandSchema>;

/**
 * #447: one discovered model row with the omp catalog metadata seats. Every
 * metadata seat is value-or-null (null = looked and unknown — the panel
 * renders "unknown", never an empty cell), and `metadataSource` names where
 * the metadata came from so partial knowledge stays honest:
 * - "models_dev": the live models.dev catalog (via pi-catalog hydration)
 *   matched the id (bundled catalog filled the seats models.dev prunes).
 * - "bundled": only the bundled snapshot knew the id (offline fallback).
 * - "none": no catalog knew the id — every seat is null.
 * - "unavailable": enrichment never ran (the bare edge fallback) — rows
 *   carry id/name only.
 * The seats mirror the panel's editor draft vocabulary plus the omp thinking
 * ladder verbatim; write-back to a provider row goes through the panel's
 * draft projection (the stored catalog schema rejects these display seats).
 */
export const discoveredModelEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  reasoning: z.boolean().nullable().optional(),
  input: z
    .array(z.enum(["text", "image"]))
    .nullable()
    .optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  cost: z
    .strictObject({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
    })
    .nullable()
    .optional(),
  thinking: z
    .object({
      /** omp ThinkingControlMode (e.g. "effort"); null when unresolvable. */
      mode: z.string().min(1).nullable(),
      /** omp effort ladder verbatim; empty = reasoning but ladder unknown. */
      efforts: z.array(z.string().min(1)),
    })
    .nullable()
    .optional(),
  metadataSource: z.enum(["models_dev", "bundled", "none", "unavailable"]),
});
export type DiscoveredModelEntry = z.infer<typeof discoveredModelEntrySchema>;

/**
 * #447: the discover verdict the daemon answers inside `host-rpc.response`.
 * Same verdict grammar as the server's own bare-discovery face: ok/verdict
 * envelope with skip-with-warning discipline for unusable entries.
 */
export const hostDiscoverModelsResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
  models: z.array(discoveredModelEntrySchema),
  warnings: z.array(z.string()),
});
export type HostDiscoverModelsResult = z.infer<typeof hostDiscoverModelsResultSchema>;

/**
 * #445: probe absolute paths for existence — bb `host.paths_exist`
 * (host-daemon-contract commands.ts:630-634 over pathsExistRequestSchema):
 * deduped, bounded at 200 paths per ask. Answers the folder picker's
 * "does this checkout still exist" gate and the machine-setup dialog.
 */
export const hostPathsExistCommandSchema = z.object({
  type: z.literal("host.paths_exist"),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .transform((paths) => Array.from(new Set(paths))),
});
export type HostPathsExistCommand = z.infer<typeof hostPathsExistCommandSchema>;

export const hostPathsExistResultSchema = z.object({
  existence: z.record(z.string(), z.boolean()),
});
export type HostPathsExistResult = z.infer<typeof hostPathsExistResultSchema>;

/**
 * #445: read one project checkout's git anchor — bb `project.inspect`
 * (host-daemon-contract commands.ts:636-641): resolve the path and report
 * its `origin` remote, null when the checkout is not a git repo.
 */
export const projectInspectCommandSchema = z.object({
  type: z.literal("project.inspect"),
  path: z.string().min(1),
});
export type ProjectInspectCommand = z.infer<typeof projectInspectCommandSchema>;

/** bb projectInspectResultSchema (commands.ts) verbatim: resolved absolute
 * path plus the git remote anchor a project row may be missing. */
export const projectPathInspectionSchema = z.object({
  path: z.string().min(1),
  gitRemoteUrl: z.string().nullable(),
});
export type ProjectPathInspection = z.infer<typeof projectPathInspectionSchema>;

/**
 * #445: the daemon-local checkout convention for a project slug — bb
 * `project.clone_default_path` (commands.ts:643-648). Discovery only:
 * nothing is created until the clone runs.
 */
export const projectCloneDefaultPathCommandSchema = z.object({
  type: z.literal("project.clone_default_path"),
  projectSlug: z.string().min(1),
});
export type ProjectCloneDefaultPathCommand = z.infer<typeof projectCloneDefaultPathCommandSchema>;

export const projectPathResultSchema = z.object({
  path: z.string().min(1),
});
export type ProjectPathResult = z.infer<typeof projectPathResultSchema>;

/**
 * #445: clone the project remote onto the daemon — bb `project.clone`
 * (commands.ts:650-657). Long-running (bb transport "settled", 20-minute
 * window): the control plane's clone route carries the same timeout on its
 * hostOnlineRpc ask.
 */
export const projectCloneCommandSchema = z.object({
  type: z.literal("project.clone"),
  remoteUrl: z.string().min(1),
  projectSlug: z.string().min(1),
  targetPath: z.string().min(1).optional(),
});
export type ProjectCloneCommand = z.infer<typeof projectCloneCommandSchema>;

export const hostRpcCommandSchema = z.discriminatedUnion("type", [
  hostBrowseDirectoryCommandSchema,
  hostReadFileCommandSchema,
  hostWriteFileCommandSchema,
  hostMkdirCommandSchema,
  hostDiscoverModelsCommandSchema,
  hostPathsExistCommandSchema,
  projectInspectCommandSchema,
  projectCloneDefaultPathCommandSchema,
  projectCloneCommandSchema,
]);
export type HostRpcCommand = z.infer<typeof hostRpcCommandSchema>;

export const hostDirectoryEntrySchema = z.object({
  kind: z.enum(["file", "directory"]),
  name: z.string(),
  path: z.string(),
});
export type HostDirectoryEntry = z.infer<typeof hostDirectoryEntrySchema>;

export const hostDirectoryListingSchema = z.object({
  // Resolved absolute directory that was listed (symlinks already followed).
  directory: z.string(),
  // Absolute parent directory, or null at the filesystem root.
  parent: z.string().nullable(),
  entries: z.array(hostDirectoryEntrySchema),
});
export type HostDirectoryListing = z.infer<typeof hostDirectoryListingSchema>;

/**
 * B1 (#321): bb `fileReadResultSchema` (host-daemon-contract
 * commands.ts:1147-1157) verbatim minus nothing — same field set, same
 * encodings. `contentEncoding` is "base64" for binary-image reads and for
 * non-UTF-8 bytes, "utf8" otherwise; `sha256` covers the returned bytes so a
 * later writer can compare-and-swap.
 */
export const hostFileReadResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  contentEncoding: z.enum(["base64", "utf8"]),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number().nonnegative().optional(),
  sha256: z.string(),
});
export type HostFileReadResult = z.infer<typeof hostFileReadResultSchema>;

/**
 * B2 (#322): where the written bytes landed. `path` is absolute and feeds
 * the imageView journal row verbatim; `sizeBytes` echoes the decoded
 * length so the caller can pin it in tool output without re-encoding.
 */
export const hostFileWriteResultSchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});
export type HostFileWriteResult = z.infer<typeof hostFileWriteResultSchema>;

export const hostRpcRequestFrameSchema = z.object({
  type: z.literal("host-rpc.request"),
  requestId: z.string().min(1),
  command: hostRpcCommandSchema,
});
export type HostRpcRequestFrame = z.infer<typeof hostRpcRequestFrameSchema>;

export const hostRpcResponseFrameSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("host-rpc.response"),
    requestId: z.string().min(1),
    commandType: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("host-rpc.response"),
    requestId: z.string().min(1),
    commandType: z.string().min(1),
    ok: z.literal(false),
    errorCode: z.string().min(1),
    errorMessage: z.string().min(1),
  }),
]);
export type HostRpcResponseFrame = z.infer<typeof hostRpcResponseFrameSchema>;

export const clientFrameSchema = z.discriminatedUnion("type", [
  bootAnnounceFrameSchema,
  heartbeatFrameSchema,
  execStartedFrameSchema,
  execSpawnAckFrameSchema,
  execOutputFrameSchema,
  execOutputGapFrameSchema,
  execExitedFrameSchema,
  execKilledAckFrameSchema,
  toolExitedFrameSchema,
  hostRpcResponseFrameSchema,
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type ExecStartedFrame = Extract<ClientFrame, { type: "exec.started" }>;
export type ExecSpawnAckFrame = Extract<ClientFrame, { type: "exec.spawn_ack" }>;
export type ExecOutputFrame = Extract<ClientFrame, { type: "exec.output" }>;
export type ExecOutputGapFrame = Extract<ClientFrame, { type: "exec.output_gap" }>;
export type ExecExitedFrame = Extract<ClientFrame, { type: "exec.exited" }>;
export type ExecKilledAckFrame = Extract<ClientFrame, { type: "exec.killed_ack" }>;
export type BootAnnounceReceived = Extract<ClientFrame, { type: "boot.announce" }>;
export type ToolExitedFrame = Extract<ClientFrame, { type: "tool.exited" }>;
export type HostRpcResponseReceived = Extract<ClientFrame, { type: "host-rpc.response" }>;

// ---------------------------------------------------------------------------
// Service → client frames.
// ---------------------------------------------------------------------------

export const sessionReadyFrameSchema = z.object({
  type: z.literal("session.ready"),
  sessionId: z.string(),
  heartbeatIntervalMs: z.number().int(),
  leaseTimeoutMs: z.number().int(),
});

/**
 * Workspace binding leg (#290 C1, bb `WorkspaceCommandTarget` anchor:
 * environmentId + workspaceContext.workspacePath). `id` names the binding —
 * stable across frames so the client keys its per-workspace runtime by it;
 * `path` is the workspace root on THIS host, validated against the binding
 * on every frame (drift is an explicit mismatch, never a silent re-route).
 * Absent → the daemon sandbox default (backward compatible; the producer is
 * the binding feed, inventory #282 §2.A).
 */
export const workspaceRefSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
});
export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;

export const execSpawnFrameSchema = z.object({
  type: z.literal("exec.spawn"),
  requestId: z.string(),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  command: z.string(),
  /**
   * Root-relative working directory — sandbox by default, the frame's
   * workspace root when `workspace` is present; the client clamps into that
   * root either way.
   */
  cwd: z.string(),
  timeoutMs: z.number().int().positive(),
  /** Optional workspace binding (#290 C1); absent = sandbox default. */
  workspace: workspaceRefSchema.optional(),
});

/**
 * Host-tool dispatch relay (M1.5/T5'): the tool-agnostic agent-do dispatch
 * frame carried verbatim to the client's embedded runtime. The machineId leg
 * of the agent-do frame is implicit — the WS session is bound to the machine
 * and dispatch() already rejected mis-routes (§5.1).
 */
export const toolExecFrameSchema = z.object({
  type: z.literal("tool.exec"),
  requestId: z.string(),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive(),
  /** Optional workspace binding (#290 C1); absent = sandbox default. */
  workspace: workspaceRefSchema.optional(),
  /**
   * #318 attachment staging leg: the dispatching turn's server-managed
   * attachment references (the #317 prompt-content vocabulary, attachment
   * members only). The client picks each member's bytes up over the
   * internal attachment route and stages them into
   * `<sandboxRoot>/<threadId>/Attachments/` (bb prompt-attachments.ts
   * semantics: sanitize + dedup suffix + 0600, failure cleans everything)
   * before the tool runs. Absent = plain dispatch, zero staging.
   */
  attachments: z
    .object({
      /** The project family the attachment paths resolve against. */
      projectId: z.string().min(1),
      items: z.array(
        z.discriminatedUnion("type", [localImageContentSchema, localFileContentSchema]),
      ),
    })
    .optional(),
});

export const execResumeFrameSchema = z.object({
  type: z.literal("exec.resume"),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  /** Client resends from here; overlaps are deduped service-side (§8.3). */
  ackedOffset: z.number().int().nonnegative(),
});

export const execKillFrameSchema = z.object({
  type: z.literal("exec.kill"),
  requestId: z.string(),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
});

/** Reconcile kill-list: one frame per new-boot reconnect (§8.5). */
export const killListFrameSchema = z.object({
  type: z.literal("kill.list"),
  requestId: z.string(),
  entries: z.array(
    z.object({
      threadId: z.string().min(1),
      executionId: z.string().min(1),
      pid: z.number().int(),
      pidStartedAt: z.number(),
    }),
  ),
});

/** Emitted after journal persistence (先落盘后 ack, §8.3). */
export const execOutputAckFrameSchema = z.object({
  type: z.literal("exec.output_ack"),
  threadId: z.string().min(1),
  executionId: z.string().min(1),
  ackedOffset: z.number().int().nonnegative(),
});

/** Post-ack buffer GC closure (§8.4). */
export const execForgetWindowSchema = z.object({
  threadId: z.string().min(1),
  executionId: z.string().min(1),
});
export const execForgetFrameSchema = z.object({
  type: z.literal("exec.forget"),
  ...execForgetWindowSchema.shape,
});

export const syncCompleteFrameSchema = z.object({
  type: z.literal("sync.complete"),
  generation: z.number().int().positive(),
});

export const errorFrameSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

export const serviceFrameSchema = z.discriminatedUnion("type", [
  sessionReadyFrameSchema,
  execSpawnFrameSchema,
  toolExecFrameSchema,
  execResumeFrameSchema,
  execKillFrameSchema,
  killListFrameSchema,
  execOutputAckFrameSchema,
  execForgetFrameSchema,
  syncCompleteFrameSchema,
  errorFrameSchema,
  hostRpcRequestFrameSchema,
]);
export type ServiceFrame = z.infer<typeof serviceFrameSchema>;
export type ExecSpawnServiceFrame = Extract<ServiceFrame, { type: "exec.spawn" }>;
export type ToolExecServiceFrame = Extract<ServiceFrame, { type: "tool.exec" }>;
export type KillListServiceFrame = Extract<ServiceFrame, { type: "kill.list" }>;
export type ExecOutputAckServiceFrame = Extract<ServiceFrame, { type: "exec.output_ack" }>;

// ---------------------------------------------------------------------------
// Internal attachment pickup (#318, daemon-face HTTP). bb
// `/internal/session/project-attachment-content` (host-daemon-contract
// session.ts:179-184) served by the service worker front for the client's
// staging step. `hostId` rides the query because the env-key auth ladder has
// no key→host inversion (one deployment key answers every rig host): the
// client claims its hostId and the service DO's live session binding is the
// authority — the same posture session/open takes with its body hostId.
// ---------------------------------------------------------------------------

export const projectAttachmentContentQuerySchema = z.object({
  hostId: z.string().min(1),
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  path: z.string().min(1),
});
export type ProjectAttachmentContentQuery = z.infer<typeof projectAttachmentContentQuerySchema>;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Canonical fingerprint of an observed snapshot (§8.2): stable JSON of the
 * sorted entry list. Same generation + same fingerprint ⇒ duplicate announce,
 * zero side effects (I23).
 */
export function observedFingerprint(observed: ObservedExecution[]): string {
  const canonical = [...observed]
    .sort((a, b) => (a.executionId < b.executionId ? -1 : 1))
    .map((entry) => JSON.stringify(entry))
    .join("|");

  // FNV-1a 32-bit change detection (bb watch-interests dedup shape); crypto
  // strength is not needed — the generation check is the primary gate, the
  // fingerprint only short-circuits no-op repeats.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
