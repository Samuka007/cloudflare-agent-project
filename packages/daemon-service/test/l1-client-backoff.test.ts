import { describe, expect, test } from "vitest";
import {
  BACKOFF_JITTER_FRACTION,
  NegotiationBackoff,
  NegotiationError,
  negotiationFailure,
  parseRetryAfterMs,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS,
} from "../src/client/backoff.js";
import { runSessionLoop, type SessionLoopClock } from "../src/client/session-loop.js";

/**
 * L1 negotiation backoff (issue #35): ONE exponential chain (×2, ±20%
 * jitter, 5min cap) covers enroll, session/open, WS attach, and WS
 * disconnect. Acceptance: the rejecting-endpoint interval sequence climbs
 * monotonically and a simulated hour of continuous rejection stays under
 * 100 requests — the incident shape (fixed ~2s hammer, 120+ DO RPCs in
 * 4 minutes) cannot recur.
 *
 * The loop runs unchanged against a virtual clock and in-memory endpoint
 * fakes: sleeps are recorded, not awaited, so an hour of wall time costs
 * milliseconds and every interval is exactly observable.
 */

const HOUR_MS = 3_600_000;
const DEFAULT_IDENTITY: CredentialBundle = { hostId: "host_test", hostKey: "key_test" };

/** Structural stand-in for identity.ts's ClientIdentity (kept node-free). */
interface CredentialBundle {
  hostId: string;
  hostKey: string;
}

class HourElapsed extends Error {
  constructor(
    readonly elapsedMs: number,
    readonly sleeps: number[],
  ) {
    super(`simulated time reached ${elapsedMs}ms`);
  }
}

interface VirtualClock {
  clock: SessionLoopClock;
  sleeps: number[];
  now: () => number;
  advance: (ms: number) => void;
}

function virtualClock(horizonMs: number, random: () => number): VirtualClock {
  let now = 0;
  const sleeps: number[] = [];
  return {
    clock: {
      now: () => now,
      random,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
        if (now > horizonMs) throw new HourElapsed(now, sleeps);
      },
    },
    sleeps,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

interface LoopScript {
  ensureIdentity?: () => Promise<CredentialBundle>;
  establishSession: (virtual: VirtualClock) => Promise<number>;
  sessionLifetime?: (virtual: VirtualClock) => Promise<void>;
}

interface LoopRun {
  sleeps: number[];
  elapsedMs: number;
  counts: { enrollCalls: number; openCalls: number };
}

async function runLoop(
  horizonMs: number,
  random: () => number,
  script: LoopScript,
): Promise<LoopRun> {
  const virtual = virtualClock(horizonMs, random);
  const counts = { enrollCalls: 0, openCalls: 0 };
  try {
    await runSessionLoop(
      {
        ensureIdentity: async () => {
          counts.enrollCalls += 1;
          return script.ensureIdentity === undefined
            ? DEFAULT_IDENTITY
            : await script.ensureIdentity();
        },
        establishSession: async () => {
          counts.openCalls += 1;
          return script.establishSession(virtual);
        },
        sessionLifetime: async () => {
          await script.sessionLifetime?.(virtual);
        },
        teardownSession: () => {},
      },
      virtual.clock,
    );
  } catch (error) {
    if (!(error instanceof HourElapsed)) throw error;
    return { sleeps: error.sleeps, elapsedMs: error.elapsedMs, counts };
  }
  throw new Error("runSessionLoop returned before the simulated horizon elapsed");
}

function rejectOpen503(): never {
  throw negotiationFailure("session/open", 503, null, 0);
}

function rejectOpen429(retryAfter: string): never {
  throw negotiationFailure("session/open", 429, retryAfter, 0);
}

describe("L1 client negotiation backoff (issue #35)", () => {
  test("continuous 503 rejection: chain climbs to the 5min cap; a simulated hour costs < 100 requests", async () => {
    const { sleeps, counts } = await runLoop(HOUR_MS, () => 0.5, {
      establishSession: () => rejectOpen503(),
    });
    // random() = 0.5 cancels the jitter: the observed sequence IS the
    // nominal chain — 1s doubling to the 5min cap and pinning there.
    const expected: number[] = [
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000,
    ];
    while (expected.length < sleeps.length) expected.push(RECONNECT_BACKOFF_MAX_MS);
    expect(sleeps).toEqual(expected);
    expect(counts.openCalls).toBe(sleeps.length);
    expect(counts.openCalls).toBeLessThan(100);
  });

  test("jitter stays within ±20% and adjacent waits still climb monotonically", async () => {
    for (const random of [() => 0, () => 1, Math.random]) {
      const { sleeps } = await runLoop(700_000, random, {
        establishSession: () => rejectOpen503(),
      });
      let rung = RECONNECT_BACKOFF_MIN_MS;
      let prevRung = RECONNECT_BACKOFF_MIN_MS;
      let prev: number | null = null;
      for (const observed of sleeps) {
        expect(observed).toBeGreaterThanOrEqual(rung * (1 - BACKOFF_JITTER_FRACTION) - 1e-6);
        expect(observed).toBeLessThanOrEqual(rung * (1 + BACKOFF_JITTER_FRACTION) + 1e-6);
        // Exact monotone bound: worst case is opposite jitter extremes —
        // holds at every rung including the flattened cap (2/3 ≥ 0.8/1.2).
        if (prev !== null) {
          expect(observed).toBeGreaterThanOrEqual(
            (prev * rung * (1 - BACKOFF_JITTER_FRACTION)) /
              (prevRung * (1 + BACKOFF_JITTER_FRACTION)) -
              1e-6,
          );
        }
        prev = observed;
        prevRung = rung;
        rung = Math.min(rung * 2, RECONNECT_BACKOFF_MAX_MS);
      }
      expect(rung).toBe(RECONNECT_BACKOFF_MAX_MS);
      expect(
        sleeps.some((ms) => ms >= RECONNECT_BACKOFF_MAX_MS * (1 - BACKOFF_JITTER_FRACTION)),
      ).toBe(true);
    }
  });

  test("429 Retry-After overrides the local schedule; the chain keeps climbing behind it", async () => {
    let call = 0;
    const { sleeps } = await runLoop(20_000, () => 0.5, {
      establishSession: () => {
        call += 1;
        return call <= 3 ? rejectOpen429("3") : rejectOpen503();
      },
    });
    // Three waits exactly at the server-indicated 3s (no jitter applied to
    // the server's value), then the local chain resumes from the rung it
    // reached while obeying them.
    expect(sleeps).toEqual([3_000, 3_000, 3_000, 8_000, 16_000]);
  });

  test("Retry-After clamps into the chain bounds — no hammering, no hanging", () => {
    const clamped = new NegotiationBackoff({ now: () => 0, random: () => 0.5 });
    expect(clamped.nextDelayMs(0)).toBe(RECONNECT_BACKOFF_MIN_MS);
    expect(clamped.nextDelayMs(Number.MAX_SAFE_INTEGER)).toBe(RECONNECT_BACKOFF_MAX_MS);
  });

  test("enroll failures ride the same chain as session/open failures", async () => {
    let enrollCall = 0;
    let openCall = 0;
    const { sleeps, counts } = await runLoop(15_000, () => 0.5, {
      ensureIdentity: async () => {
        enrollCall += 1;
        if (enrollCall <= 2) throw negotiationFailure("enroll", 503, null, 0);
        return { hostId: "host_enrolled", hostKey: "key_enrolled" };
      },
      establishSession: (virtual) => {
        openCall += 1;
        return openCall === 1 ? Promise.resolve(virtual.now()) : rejectOpen503();
      },
    });
    // One chain across the enroll → session/open boundary: 1s and 2s while
    // enrolling, 4s onward once open takes over — no second short schedule.
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(counts.enrollCalls).toBe(3);
    expect(counts.openCalls).toBe(3);
  });

  test("stable-session reset: a >10s session restarts the chain, a short-lived one does not", async () => {
    let flapCall = 0;
    const { sleeps: flap } = await runLoop(12_000, () => 0.5, {
      establishSession: (virtual) => {
        flapCall += 1;
        return flapCall === 2 ? Promise.resolve(virtual.now()) : rejectOpen503();
      },
      sessionLifetime: async (virtual) => {
        virtual.advance(5_000);
      },
    });
    // Session lived 5s < 10s: the chain keeps climbing (2000 next).
    expect(flap).toEqual([1_000, 2_000, 4_000, 8_000]);

    let stableCall = 0;
    const { sleeps: stable } = await runLoop(40_000, () => 0.5, {
      establishSession: (virtual) => {
        stableCall += 1;
        return stableCall === 2 ? Promise.resolve(virtual.now()) : rejectOpen503();
      },
      sessionLifetime: async (virtual) => {
        virtual.advance(15_000);
      },
    });
    // Session lived 15s > 10s: stable — the chain restarts at 1s.
    expect(stable).toEqual([1_000, 1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  test("never-connected rejection never resets (the incident regression guard)", async () => {
    const { sleeps } = await runLoop(60_000, () => 0.5, {
      establishSession: () => rejectOpen503(),
    });
    // With connectedAt = 0 the old loop reset every iteration (~1s forever);
    // the fixed loop must still be climbing at the end of the window.
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    const first = sleeps[0];
    const last = sleeps[sleeps.length - 1];
    if (first === undefined || last === undefined) throw new Error("no waits recorded");
    expect(last).toBeGreaterThan(first);
  });

  test("Retry-After parsing: delta-seconds, HTTP-date, garbage", () => {
    expect(parseRetryAfterMs("5", 0)).toBe(5_000);
    expect(parseRetryAfterMs(" 0 ", 0)).toBe(0);
    expect(parseRetryAfterMs("soon", 0)).toBeNull();
    const at = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT", at - 60_000)).toBe(60_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT", at + 60_000)).toBe(0);
  });

  test("only 429/503 with a parseable Retry-After carry a server-indicated delay", () => {
    const honored = negotiationFailure("session/open", 429, "7", 0, "quota exhausted");
    expect(honored).toBeInstanceOf(NegotiationError);
    expect((honored as NegotiationError).retryAfterMs).toBe(7_000);
    expect(honored.message).toContain("429");
    expect(negotiationFailure("session/open", 503, null, 0, "overloaded")).not.toBeInstanceOf(
      NegotiationError,
    );
    expect(negotiationFailure("session/open", 401, "7", 0)).not.toBeInstanceOf(NegotiationError);
    expect(negotiationFailure("enroll", 503, "nonsense", 0)).not.toBeInstanceOf(NegotiationError);
  });
});
