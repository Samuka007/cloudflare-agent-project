import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

/**
 * previewLeases → Durable Object port (bb apps/server/src/routes/files.ts:
 * 363-386, commit 8473d8c33). bb kept `Map<leaseId, expiresAtMs>` in process
 * memory with a periodic eviction scan; here the map lives in DO storage and
 * the scan is an alarm. The files route family is OUT of the M0 face (ruling
 * #7); this DO exists to carry the component mapping and its TTL semantics
 * are exercised by L1 tests, ready for the files family to grow onto it.
 */
const LEASE_KEY_PREFIX = "lease:";

interface LeaseRecord {
  expiresAtMs: number;
}

export class LeaseStoreDO extends DurableObject {
  // this.ctx / this.env come from the DurableObject base (cloudflare:workers).
  declare readonly ctx: DurableObjectState;
  declare readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async createLease(args: {
    leaseId: string;
    ttlMs: number;
  }): Promise<{ expiresAtMs: number }> {
    const expiresAtMs = Date.now() + Math.max(0, args.ttlMs);
    await this.ctx.storage.put<LeaseRecord>(
      `${LEASE_KEY_PREFIX}${args.leaseId}`,
      { expiresAtMs },
    );
    await this.scheduleEvictionAlarm();
    return { expiresAtMs };
  }

  /** bb verifyPreviewLease: unknown or expired → false; expired is evicted. */
  async verifyLease(args: {
    leaseId: string;
  }): Promise<{ valid: boolean; expiresAtMs: number | null }> {
    const key = `${LEASE_KEY_PREFIX}${args.leaseId}`;
    const record = await this.ctx.storage.get<LeaseRecord>(key);
    if (!record) {
      return { valid: false, expiresAtMs: null };
    }
    if (Date.now() >= record.expiresAtMs) {
      await this.ctx.storage.delete(key);
      return { valid: false, expiresAtMs: record.expiresAtMs };
    }
    return { valid: true, expiresAtMs: record.expiresAtMs };
  }

  async evictExpired(): Promise<{ evicted: number }> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<LeaseRecord>({
      prefix: LEASE_KEY_PREFIX,
    });
    const expired: string[] = [];
    for (const [key, record] of entries) {
      if (now >= record.expiresAtMs) {
        expired.push(key);
      }
    }
    await this.ctx.storage.delete(expired);
    return { evicted: expired.length };
  }

  async alarm(): Promise<void> {
    const result = await this.evictExpired();
    const remaining = await this.ctx.storage.list({
      prefix: LEASE_KEY_PREFIX,
      limit: 1,
    });
    if (remaining.size > 0) {
      await this.scheduleEvictionAlarm();
    }
    void result;
  }

  private async scheduleEvictionAlarm(): Promise<void> {
    const entries = await this.ctx.storage.list<LeaseRecord>({
      prefix: LEASE_KEY_PREFIX,
    });
    if (entries.size === 0) {
      return;
    }
    const soonest = Math.min(
      ...[...entries.values()].map((record) => record.expiresAtMs),
    );
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > soonest) {
      await this.ctx.storage.setAlarm(soonest);
    }
  }
}

/** Typed accessor for the lease DO singleton. */
export function leaseStore(env: Env): DurableObjectStub & {
  createLease(args: { leaseId: string; ttlMs: number }): Promise<{ expiresAtMs: number }>;
  verifyLease(args: { leaseId: string }): Promise<{ valid: boolean; expiresAtMs: number | null }>;
  evictExpired(): Promise<{ evicted: number }>;
} {
  const id = env.LEASES.idFromName("leases");
  return env.LEASES.get(id) as DurableObjectStub & {
    createLease(args: { leaseId: string; ttlMs: number }): Promise<{ expiresAtMs: number }>;
    verifyLease(args: { leaseId: string }): Promise<{ valid: boolean; expiresAtMs: number | null }>;
    evictExpired(): Promise<{ evicted: number }>;
  };
}
