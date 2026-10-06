import { describe, expect, it, beforeEach } from "vitest";
import {
  consumeProbeSlot,
  PROBE_RATE_LIMIT_MAX,
  PROBE_RATE_LIMIT_WINDOW_MS,
  resetProbeRateLimiter,
} from "../../src/services/probe-rate-limit.js";

/**
 * SEC-W5-003 probe-face throttle semantics: a fixed window shared per
 * principal across both probe endpoints, with a bounded retry-after.
 */

beforeEach(() => {
  resetProbeRateLimiter();
});

describe("#399 consumeProbeSlot", () => {
  it(`admits ${PROBE_RATE_LIMIT_MAX} per window, then refuses with the reset eta`, () => {
    for (let i = 0; i < PROBE_RATE_LIMIT_MAX; i++) {
      expect(consumeProbeSlot("principal", 1_000)).toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
    }
    expect(consumeProbeSlot("principal", 1_000)).toEqual({
      allowed: false,
      retryAfterSeconds: PROBE_RATE_LIMIT_WINDOW_MS / 1000,
    });
  });

  it("keys buckets per principal and admits again when the window rolls", () => {
    for (let i = 0; i < PROBE_RATE_LIMIT_MAX; i++) consumeProbeSlot("a", 1_000);
    expect(consumeProbeSlot("a", 1_000).allowed).toBe(false);
    // A different principal never shares the exhausted budget…
    expect(consumeProbeSlot("b", 1_000).allowed).toBe(true);
    // …and the window roll releases the original one.
    expect(consumeProbeSlot("a", 1_000 + PROBE_RATE_LIMIT_WINDOW_MS).allowed).toBe(true);
  });
});
