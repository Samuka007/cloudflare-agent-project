/**
 * SEC-W5-003 probe-face throttle: /system/providers/:id/test and
 * /system/providers/discover-models are the only API faces that fire
 * attacker-reachable outbound requests with server-held credentials, so each
 * principal gets a small fixed-window budget shared across BOTH endpoints.
 *
 * The buckets live in isolate memory: per-isolate enforcement is best-effort
 * at Workers scale (requests spread across isolates each get a budget), but
 * it removes the unlimited-hammer seam a single connection enjoys and costs
 * no cross-request storage. The principal is the Access JWT subject on
 * gate-on deployments (middleware/access.ts), falling back to the client IP.
 */

export const PROBE_RATE_LIMIT_WINDOW_MS = 60_000;
export const PROBE_RATE_LIMIT_MAX = 30;
/** Opportunistic bound: prune stale buckets once the map grows past this. */
const PRUNE_THRESHOLD = 10_000;

interface ProbeRateBucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, ProbeRateBucket>();

export interface ProbeSlotVerdict {
  allowed: boolean;
  /** Seconds until the current window resets (0 when allowed). */
  retryAfterSeconds: number;
}

export function consumeProbeSlot(principal: string, nowMs: number = Date.now()): ProbeSlotVerdict {
  if (buckets.size > PRUNE_THRESHOLD) {
    for (const [key, bucket] of buckets) {
      if (nowMs - bucket.windowStart >= PROBE_RATE_LIMIT_WINDOW_MS) buckets.delete(key);
    }
  }
  const bucket = buckets.get(principal);
  if (bucket === undefined || nowMs - bucket.windowStart >= PROBE_RATE_LIMIT_WINDOW_MS) {
    buckets.set(principal, { windowStart: nowMs, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  if (bucket.count > PROBE_RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(
        (bucket.windowStart + PROBE_RATE_LIMIT_WINDOW_MS - nowMs) / 1000,
      ),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** L1-rig seam: tests share one isolate (vitest.config isolate:false), so a
 * describe that exercises the limit resets buckets in its afterEach. */
export function resetProbeRateLimiter(): void {
  buckets.clear();
}
