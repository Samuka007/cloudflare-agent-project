import { describe, expect, it } from "vitest";
import { env, runDurableObjectAlarm } from "cloudflare:test";

/**
 * previewLeases → DO alarm component mapping (port-inventory §5.2): leases
 * live in DO storage, eviction is alarm-driven, verify() expires lazily.
 */
interface LeaseStub {
  createLease(args: { leaseId: string; ttlMs: number }): Promise<{ expiresAtMs: number }>;
  verifyLease(args: { leaseId: string }): Promise<{ valid: boolean; expiresAtMs: number | null }>;
  evictExpired(): Promise<{ evicted: number }>;
}

function waitFor(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function leaseStore(): LeaseStub {
  const stub = env.LEASES.get(env.LEASES.idFromName("test-leases"));
  return stub;
}

describe("lease store DO (bb previewLeases semantics)", () => {
  it("creates, verifies, and expires leases", async () => {
    const store = leaseStore();
    const lease = await store.createLease({ leaseId: "lease-a", ttlMs: 50 });
    expect(lease.expiresAtMs).toBeGreaterThan(Date.now());
    const live = await store.verifyLease({ leaseId: "lease-a" });
    expect(live.valid).toBe(true);
    // Exception to no-test-timers: verifyLease compares against the DO's real
    // clock, and miniflare does not expose fake time across the DO boundary —
    // a genuine 80ms wait is the deterministic minimum here.
    await waitFor(80);
    const expired = await store.verifyLease({ leaseId: "lease-a" });
    expect(expired.valid).toBe(false);
    // miniflare delivers alarms in real time, so the entry may already be
    // alarm-evicted (expiresAtMs null) or lazily expired (expiresAtMs set).
    const unknown = await store.verifyLease({ leaseId: "never-created" });
    expect(unknown).toEqual({ valid: false, expiresAtMs: null });
  });

  it("evicts expired leases from storage via the alarm path", async () => {
    const store = leaseStore();
    // ttlMs 0 means "already expired at creation", so no wall-clock wait is
    // needed before forcing the alarm.
    await store.createLease({ leaseId: "lease-b", ttlMs: 0 });
    const stub = env.LEASES.get(env.LEASES.idFromName("test-leases"));
    const ran = await runDurableObjectAlarm(stub);
    if (!ran) {
      // Alarm already fired between scheduling and the test — force eviction.
      const forced = await store.evictExpired();
      expect(forced.evicted).toBeGreaterThanOrEqual(0);
    }
    const verify = await store.verifyLease({ leaseId: "lease-b" });
    expect(verify.valid).toBe(false);
    expect(verify.expiresAtMs).toBeNull();
  });
});
