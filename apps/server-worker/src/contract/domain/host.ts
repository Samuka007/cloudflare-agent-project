//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";
import { permissionModeSchema } from "./shared-types.js";

/** bb carries only "persistent" (domain/src/host.ts:4-5); #386 adds the
 * seeded cloud placeholder — a real row with empty-machine semantics (never
 * connected, never heartbeats, removal refused). */
export const hostTypeValues = ["persistent", "placeholder"] as const;
export const hostTypeSchema = z.enum(hostTypeValues);
export type HostType = z.infer<typeof hostTypeSchema>;

export const hostStatusValues = ["connected", "disconnected"] as const;
export const hostStatusSchema = z.enum(hostStatusValues);

export const hostSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: hostTypeSchema,
  status: hostStatusSchema,
  /**
   * Permission ceiling for work that runs on this machine. Threads resolve
   * down to this mode, so a sandbox machine can stay at "full" while a
   * personal laptop refuses to go above "accept-edits". Only an owner session
   * changes it; machine credentials cannot (see the hosts routes).
   */
  maxPermissionMode: permissionModeSchema,
  lastSeenAt: z.number().nullable(),
  lastRejectedProtocolVersion: z.number().int().positive().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Host = z.infer<typeof hostSchema>;
