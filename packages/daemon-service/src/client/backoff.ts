/**
 * Unified negotiation backoff (issue #35): ONE exponential chain for every
 * session-establishment failure — enroll, session/open, WS attach, and WS
 * disconnect. Before the fix the chain covered only the WS path, and its
 * stable-reset guard misfired for never-connected clients
 * (`Date.now() - 0 > threshold` was always true), pinning the delay at
 * ~1–2s: the 2026-10-04 incident hammered /session/open 120+ times in 4
 * minutes against an exhausted staging DO.
 *
 * Shape (bb lineage — docs/research/bb-daemon-protocol.md §2.1: reconnect
 * 1s ×2 capped, stable >10s resets the attempt counter): ×2 growth with
 * ±20% jitter, cap raised 30s → 5min so a continuously rejecting endpoint
 * sees < 100 requests per hour (acceptance of #35). A 429/503 Retry-After
 * replaces the local schedule for that wait, clamped into the chain bounds
 * so a broken header can neither hammer (0s) nor hang (a year).
 *
 * Client-owned constants (engineering.md practice 4: durations from named
 * constants). Supersedes the RECONNECT_BACKOFF_* block in src/constants.ts.
 */

/** First wait after a failure; also the floor for server Retry-After. */
export const RECONNECT_BACKOFF_MIN_MS = 1_000;
/** Chain cap (raised from bb's 30s: bounded 1h-rejection request count). */
export const RECONNECT_BACKOFF_MAX_MS = 300_000;
/** A session that lived at least this long resets the attempt chain. */
export const RECONNECT_STABLE_RESET_MS = 10_000;
/** Symmetric multiplicative jitter applied to the local schedule. */
export const BACKOFF_JITTER_FRACTION = 0.2;

export interface BackoffClock {
  now(): number;
  /** Uniform [0, 1); injectable for deterministic tests. */
  random(): number;
}

export const realBackoffClock: BackoffClock = {
  now: () => Date.now(),
  random: () => Math.random(),
};

/**
 * A negotiation step failed while the server instructed a wait (429/503 +
 * parseable Retry-After). The unified loop honors `retryAfterMs` in place
 * of the local schedule for exactly that wait.
 */
export class NegotiationError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "NegotiationError";
  }
}

/** Retry-After per RFC 9110 §10.2.3: delta-seconds or HTTP-date. */
export function parseRetryAfterMs(header: string, nowMs: number): number | null {
  const trimmed = header.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }
  const atMs = Date.parse(trimmed);
  if (Number.isNaN(atMs)) return null;
  // Past date: the wait already elapsed — zero, the clamp handles the rest.
  return Math.max(0, atMs - nowMs);
}

function detailText(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine === "" ? "" : ` ${oneLine.slice(0, 200)}`;
}

/**
 * Seam normalization (engineering.md practice 2): translate a rejected
 * negotiation response into the error the unified loop consumes. Only
 * 429/503 carry a server-indicated delay; every other status (and an
 * unparseable header) is a plain failure the local schedule absorbs.
 */
export function negotiationFailure(
  what: string,
  status: number,
  retryAfterHeader: string | null,
  nowMs: number,
  body = "",
): Error {
  const message = `${what} failed: HTTP ${status}${detailText(body)}`;
  if ((status === 429 || status === 503) && retryAfterHeader !== null) {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader, nowMs);
    if (retryAfterMs !== null) {
      return new NegotiationError(
        `${message} (retry-after ${retryAfterHeader.trim()})`,
        retryAfterMs,
      );
    }
  }
  return new Error(message);
}

/**
 * One exponential chain, advanced by every failed establishment attempt.
 * The stable-session reset evaluates exactly the session handed to it — a
 * never-connected client (0) never resets, which is the incident fix.
 */
export class NegotiationBackoff {
  private nominalMs: number = RECONNECT_BACKOFF_MIN_MS;

  constructor(private readonly clock: BackoffClock = realBackoffClock) {}

  /**
   * The wait before the next attempt, consuming one rung of the chain. A
   * server Retry-After replaces the wait's duration (clamped to
   * [MIN, MAX]); the local rung advances either way so the chain keeps its
   * shape if the server stops guiding us.
   */
  nextDelayMs(retryAfterMs: number | null): number {
    const rungMs = this.nominalMs;
    this.nominalMs = Math.min(rungMs * 2, RECONNECT_BACKOFF_MAX_MS);
    if (retryAfterMs !== null) {
      return Math.min(Math.max(retryAfterMs, RECONNECT_BACKOFF_MIN_MS), RECONNECT_BACKOFF_MAX_MS);
    }
    const jitter = 1 + (this.clock.random() * 2 - 1) * BACKOFF_JITTER_FRACTION;
    return rungMs * jitter;
  }

  /** Full reset (boot, or a session that proved stable). */
  reset(): void {
    this.nominalMs = RECONNECT_BACKOFF_MIN_MS;
  }

  /**
   * Stable-boundary reset: only a session that actually existed
   * (`connectedAtMs > 0`) and outlived RECONNECT_STABLE_RESET_MS resets the
   * chain. Returns true when the reset fired.
   */
  resetAfterSessionEnd(connectedAtMs: number): boolean {
    if (connectedAtMs > 0 && this.clock.now() - connectedAtMs > RECONNECT_STABLE_RESET_MS) {
      this.reset();
      return true;
    }
    return false;
  }
}
