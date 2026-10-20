import { asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import { hostSchema } from "../../contract/domain/host";
import { hosts } from "../schema";

/**
 * Hosts aggregate repository — the drizzle-era data access for `hosts`
 * (#595, db campaign T3; schema: src/db/schema.ts, ruling: #593/#591).
 *
 * Deep module: callers see plain records and intent-named methods; every
 * drizzle query builder stays behind this file. Behavior ports the legacy
 * port verbatim (src/db/hosts.ts) so the T5 route/service re-point is
 * mechanical:
 *
 * - upsertAttached is the #49 daemon-face bridge (enroll + session/open):
 *   insert-if-absent; an existing row only refreshes presence (last_seen_at)
 *   and clears a stale protocol rejection on `clearRejected` — name, type and
 *   permission ceiling stay owner-controlled (bb upsertHost keeps the
 *   existing row's name, data/hosts.ts:70-91), and a destroyed host is never
 *   resurrected by a re-attach (setWhere on the upsert's conflict arm).
 * - #386 defense in depth: the cloud placeholder row is born once (ledger
 *   seed) and never becomes a machine — the attach bridge refuses the id
 *   outright (no insert, no presence refresh, no rejection clear).
 * - listActive is the bindable-host inventory: tombstoned rows excluded.
 *
 * The wire `Host` face carries the computed liveness `status` (a projection
 * assembled by services/host-records.ts, not a column); the stored record is
 * the zod twin of that face minus `status`, plus the two tombstone/provenance
 * columns the wire omits (#591: no hand-written second shape).
 */

export const hostRecordSchema = hostSchema.omit({ status: true }).extend({
  connectMachineId: z.string().nullable(),
  destroyedAt: z.number().nullable(),
});
export type HostRecord = z.infer<typeof hostRecordSchema>;

export interface HostAttachmentInfo {
  /** Daemon self-reported name; recorded on first sight only. */
  hostName?: string | null;
  /** A successful session/open clears a stale protocol rejection. */
  clearRejected?: boolean;
}

export interface UpdateHostArgs {
  name?: string;
  maxPermissionMode?: HostRecord["maxPermissionMode"];
  destroyedAt?: number | null;
  lastSeenAt?: number;
  lastRejectedProtocolVersion?: number | null;
}

export interface HostsRepo {
  get(hostId: string): Promise<HostRecord | null>;
  /** Non-destroyed hosts ordered by (createdAt, id) — the fleet inventory. */
  listActive(): Promise<HostRecord[]>;
  /** #49 daemon attach bridge: markHostSeen/upsert on enroll + session/open. */
  upsertAttached(hostId: string, info?: HostAttachmentInfo): Promise<void>;
  /**
   * #62 heartbeat liveness stamp (moved off the legacy env.DB write when the
   * hosts reader cut over to DB_V2). The ≥minIntervalMs SQL throttle is THIS
   * repository's policy (#591 ruling: markSeen 节流内聚 Hosts repo) — the
   * daemon side fires per heartbeat, the repo decides which stamps land.
   */
  markSeen(hostId: string, at: number, minIntervalMs: number): Promise<void>;
  update(hostId: string, update: UpdateHostArgs): Promise<HostRecord | null>;
}

export function createHostsRepo(db: D1Database): HostsRepo {
  const drizzleDb = drizzle(db);

  return {
    async get(hostId) {
      const row = await drizzleDb.select().from(hosts).where(eq(hosts.id, hostId)).get();
      return row ?? null;
    },

    async listActive() {
      return await drizzleDb
        .select()
        .from(hosts)
        .where(isNull(hosts.destroyedAt))
        .orderBy(asc(hosts.createdAt), asc(hosts.id))
        .all();
    },

    async markSeen(hostId, at, minIntervalMs) {
      await drizzleDb
        .update(hosts)
        .set({ lastSeenAt: at, updatedAt: at })
        .where(
          sql`${hosts.id} = ${hostId} and (${hosts.lastSeenAt} is null or ${at} - ${hosts.lastSeenAt} >= ${minIntervalMs})`,
        );
    },

    async upsertAttached(hostId, info) {
      // #386: the placeholder row is born once (ledger seed) and never becomes
      // a machine — enroll/session-open reserve the id (daemon-service
      // worker), so the attach bridge must never refresh its last_seen_at,
      // clear a rejection, or (re)insert it.
      if (hostId === CLOUD_PLACEHOLDER_HOST_ID) {
        return;
      }
      const now = Date.now();
      // bb inserts the daemon's self-reported name on first sight only
      // (internal/session.ts:93); with no name reported (raw-rig handshakes)
      // the hostId stays the display fallback.
      const name =
        typeof info?.hostName === "string" && info.hostName !== "" ? info.hostName : hostId;
      await drizzleDb
        .insert(hosts)
        .values({
          id: hostId,
          name,
          type: "persistent",
          connectMachineId: null,
          maxPermissionMode: "full",
          destroyedAt: null,
          lastSeenAt: now,
          lastRejectedProtocolVersion: null,
          createdAt: now,
          updatedAt: now,
        })
        // bb: enroll's upsert preserves the rejection (data/hosts.ts:84 keeps
        // existing columns); only a successful open clears it
        // (internal/session.ts:96-98) — and `clearRejected` rides only the
        // conflict-update arm, exactly like the port's conditional SET fragment.
        .onConflictDoUpdate({
          target: hosts.id,
          set: {
            lastSeenAt: now,
            updatedAt: now,
            ...(info?.clearRejected === true ? { lastRejectedProtocolVersion: null } : {}),
          },
          setWhere: isNull(hosts.destroyedAt),
        })
        .run();
    },

    async update(hostId, update) {
      await drizzleDb
        .update(hosts)
        .set({
          updatedAt: Date.now(),
          ...(update.name !== undefined ? { name: update.name } : {}),
          ...(update.maxPermissionMode !== undefined
            ? { maxPermissionMode: update.maxPermissionMode }
            : {}),
          ...(update.destroyedAt !== undefined ? { destroyedAt: update.destroyedAt } : {}),
          ...(update.lastSeenAt !== undefined ? { lastSeenAt: update.lastSeenAt } : {}),
          ...(update.lastRejectedProtocolVersion !== undefined
            ? { lastRejectedProtocolVersion: update.lastRejectedProtocolVersion }
            : {}),
        })
        .where(eq(hosts.id, hostId))
        .run();
      return await this.get(hostId);
    },
  };
}
