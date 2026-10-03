/**
 * Session mirror wire vocabulary — bb `packages/host-daemon-contract` M0
 * subset (session.ts:97-174 open shapes, :337-341/:587-602 server WS messages,
 * watch-set frames from watch-interests.ts). Declared here because
 * packages/protocol does not carry the daemon-plane shapes yet; promotion
 * target noted in the #27 report.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Session open (bb hostDaemonSessionOpenRequestSchema / ...ResponseSchema).
// ---------------------------------------------------------------------------

export const hostDaemonActiveThreadSchema = z.object({
  threadId: z.string().min(1),
});
export type HostDaemonActiveThread = z.infer<
  typeof hostDaemonActiveThreadSchema
>;

export const hostDaemonLoadedEnvironmentSchema = z.object({
  environmentId: z.string().min(1),
});

export const hostDaemonSessionOpenRequestSchema = z.object({
  hostId: z.string().min(1),
  instanceId: z.string().min(1),
  hostName: z.string(),
  hostType: z.string(),
  connectMachineId: z.string().optional(),
  hasMachineCredential: z.boolean(),
  platform: z.string(),
  dataDir: z.string(),
  /**
   * Deliberately loose (bb session.ts:106-108): an old daemon must receive
   * the actionable `protocol_version_mismatch` error, not a bare schema
   * validation failure. Strict equality is enforced by the session mirror.
   */
  protocolVersion: z.number().int().positive(),
  activeThreads: z.array(hostDaemonActiveThreadSchema),
  loadedEnvironments: z.array(hostDaemonLoadedEnvironmentSchema).optional(),
});
export type HostDaemonSessionOpenRequest = z.infer<
  typeof hostDaemonSessionOpenRequestSchema
>;

// ---------------------------------------------------------------------------
// Close reasons + server→daemon WS messages (M0 subset).
// ---------------------------------------------------------------------------

export const DAEMON_SESSION_CLOSE_REASONS = [
  "replaced",
  "expired",
  "daemon-disconnect",
] as const;
export const daemonSessionCloseReasonSchema = z.enum(
  DAEMON_SESSION_CLOSE_REASONS,
);
export type DaemonSessionCloseReason = z.infer<
  typeof daemonSessionCloseReasonSchema
>;

export const daemonWatchSetWorkspaceTargetSchema = z.object({
  environmentId: z.string().min(1),
  /** bb workspaceContextFromPath projection. */
  workspaceContext: z.string(),
});

export const daemonWatchSetThreadStorageTargetSchema = z.object({
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
});

export const daemonWatchSetSchema = z.object({
  generation: z.number().int().nonnegative(),
  workspaceTargets: z.array(daemonWatchSetWorkspaceTargetSchema),
  threadStorageTargets: z.array(daemonWatchSetThreadStorageTargetSchema),
});
export type DaemonWatchSetWire = z.infer<typeof daemonWatchSetSchema>;

export const watchSetReplaceMessageSchema = daemonWatchSetSchema.extend({
  type: z.literal("watch-set.replace"),
});
export type WatchSetReplaceMessageWire = z.infer<
  typeof watchSetReplaceMessageSchema
>;

export const sessionCloseMessageSchema = z.object({
  type: z.literal("session-close"),
  reason: daemonSessionCloseReasonSchema,
});
export type SessionCloseMessageWire = z.infer<typeof sessionCloseMessageSchema>;

/** bb hostDaemonServerWsMessageSchema, M0 subset. */
export const daemonServerMessageSchema = z.discriminatedUnion("type", [
  sessionCloseMessageSchema,
  watchSetReplaceMessageSchema,
]);
export type DaemonServerMessage = z.infer<typeof daemonServerMessageSchema>;
