import {
  NEGATIVE_CACHE_TTL_MS,
  NEGOTIATE_BUCKET_CAPACITY,
  NEGOTIATE_REFILL_PER_SEC,
} from "./constants.js";

/**
 * Edge shielding (#36) — the front's DO-request budget (engineering.md
 * 横切实践 11). Three in-isolate gates sit in front of every DO touch on
 * the negotiation seam:
 *
 * 1. hostKey auth ladder: env compare (staging single-host / L1 rig) →
 *    KV hash cache → one DO authCheck fallback + KV backfill. The DO mirror
 *    (written at enroll) is the authority; KV is only a cache.
 * 2. Negative cache: a DO quota/overload-class failure arms a per-host
 *    window during which negotiation requests are answered 429+Retry-After
 *    with zero DO touches.
 * 3. Per-hostId token bucket: in-isolate, best-effort (isolate eviction
 *    resets it — fails open, per the ticket's explicit allowance).
 *
 * Deliberate non-feature (#36 item 4): successful session/open results are
 * NOT cached at the edge. openSession is the §8.5 sole recovery arbiter and
 * the place where I17 replace-on-reopen happens; serving a cached sessionId
 * would skip the reconcile and the replacement close. Only the AUTH decision
 * is cached. See the budget table in docs/engineering.md.
 */

/**
 * Thrown by the service DO when the L1 overload fault-injection is armed;
 * real platform overload surfaces as thrown errors with matching signatures
 * (see {@link isOverloadClass}).
 */
export class DoOverloadError extends Error {
  constructor(message = "durable object is overloaded") {
    super(message);
    this.name = "DoOverloadError";
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Bearer token of the daemon seam; null when the header is absent/malformed. */
export function authKeyOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : (match[1] ?? null);
}

/** KV key layout: hash-keyed so raw keys are never stored or logged. */
export function authKvKey(keyHash: string): string {
  return `auth:v1:${keyHash}`;
}

/**
 * #503 test-only tuning seam: the named constants are the sole production
 * authority; the L1 rig needs a real-clock short window (workerd isolates
 * cannot be fake-timed from the test realm). Module state is shared with
 * the front's fetch handler — tests MUST reset with `undefined` when done.
 */
let negativeCacheTtlMsOverride: number | undefined;

export function setNegativeCacheTtlMsForTest(ms: number | undefined): void {
  negativeCacheTtlMsOverride = ms;
}

export function negativeCacheTtlMs(): number {
  return negativeCacheTtlMsOverride ?? NEGATIVE_CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Negative cache (in-isolate, per hostId).
// ---------------------------------------------------------------------------

const negativeCache = new Map<string, number>();

/** Remaining negative-cache window for the host in ms, or null when clear. */
export function negativeRemainingMs(hostId: string, now: number = Date.now()): number | null {
  const until = negativeCache.get(hostId);
  if (until === undefined) return null;
  if (until <= now) {
    negativeCache.delete(hostId);
    return null;
  }
  return until - now;
}

export function armNegativeCache(hostId: string, ttlMs: number, now: number = Date.now()): void {
  negativeCache.set(hostId, now + ttlMs);
}

/**
 * Quota/overload-class failure classifier: what the negative cache may key
 * on. Business failures (protocol_version_mismatch, host_offline,
 * invalid_session) are deterministic host-level answers and deliberately
 * NOT classified — §8.5 recovery relies on repeated open attempts during a
 * client's own reconnection, which must reach the DO.
 */
export function isOverloadClass(error: unknown): boolean {
  if (error instanceof DoOverloadError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|503)\b|too many requests|overload|quota|rate limit/i.test(message);
}

/** 429 envelope. `rate_limited` is schema-valid per apiErrorSchema while the
 * frozen ApiErrorCode enum stays untouched (additive growth only). */
export function rateLimitedResponse(retryAfterSeconds: number, message: string): Response {
  return Response.json(
    { code: "rate_limited", message, retryable: true },
    { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) } },
  );
}

// ---------------------------------------------------------------------------
// Per-hostId token bucket (in-isolate, best-effort).
// ---------------------------------------------------------------------------

interface BucketState {
  tokens: number;
  refilledAt: number;
}

const buckets = new Map<string, BucketState>();

export interface BucketVerdict {
  allowed: boolean;
  /** Seconds until the next token (only meaningful when not allowed). */
  retryAfterS: number;
}

export function takeToken(hostId: string, now: number = Date.now()): BucketVerdict {
  const state = buckets.get(hostId) ?? { tokens: NEGOTIATE_BUCKET_CAPACITY, refilledAt: now };
  const refilled = Math.min(
    NEGOTIATE_BUCKET_CAPACITY,
    state.tokens + ((now - state.refilledAt) / 1000) * NEGOTIATE_REFILL_PER_SEC,
  );
  if (refilled >= 1) {
    buckets.set(hostId, { tokens: refilled - 1, refilledAt: now });
    return { allowed: true, retryAfterS: 0 };
  }
  buckets.set(hostId, { tokens: refilled, refilledAt: now });
  return { allowed: false, retryAfterS: (1 - refilled) / NEGOTIATE_REFILL_PER_SEC };
}

// ---------------------------------------------------------------------------
// Auth cache (KV) — authority is the DO mirror; KV is a pure cache.
// ---------------------------------------------------------------------------

/** Cached hostId for a key hash, or null on miss/no-binding/parse garbage. */
export async function loadCachedAuth(
  kv: KVNamespace | undefined,
  keyHash: string,
): Promise<string | null> {
  if (kv === undefined) return null;
  try {
    const raw = await kv.get(authKvKey(keyHash));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { hostId?: unknown };
    return typeof parsed.hostId === "string" ? parsed.hostId : null;
  } catch {
    // Cache reads never fail auth: fall through to the DO fallback.
    return null;
  }
}

/** Best-effort cache re-arm (enroll + DO-fallback backfill). A failed put
 * self-heals: the next miss pays one DO authCheck and retries the put. */
export async function backfillAuthCache(
  kv: KVNamespace | undefined,
  keyHash: string,
  hostId: string,
): Promise<void> {
  if (kv === undefined || hostId === "") return;
  try {
    await kv.put(authKvKey(keyHash), JSON.stringify({ hostId }), {
      expirationTtl: 60, // KV platform floor; see HOST_KEY_KV_TTL_S.
    });
  } catch {
    // Deliberate swallow: the DO mirror remains authoritative.
  }
}
