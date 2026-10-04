import { afterEach, expect, test } from "vitest";
import { _inject, intake, resolveJeapiKey } from "../pm-autopilot.js";

/**
 * Real-call jev smoke (#131 CRITICAL: the judge layer is a REAL model call).
 * Runs exactly one live POST to the systemone endpoint and asserts the
 * reply's shape invariants. Skips itself when no JEV_API_KEY is resolvable
 * (process env or gitignored .env.local) — CI stays green without secrets.
 */

afterEach(() => {
  _inject(null);
});

const KEY = resolveJeapiKey();

const SMALL_BODY = [
  "[infra] pm-autopilot judge smoke: synthetic one-paragraph ticket.",
  "Ships a config tweak: raise the snapshot pagination guard from 20 to 24 pages",
  "and log a warning when truncation trips. No new deps.",
].join(" ");

test.skipIf(KEY === null)(
  "smoke: real jev intake classifies a synthetic ticket with invariants intact",
  { timeout: 120_000 },
  async () => {
    if (KEY === null) throw new Error("unreachable: skipIf guards the key");
    const r = await intake(SMALL_BODY);
    // gate vocabulary
    expect(["auto-apply", "pm-review", "needs-human"]).toContain(r.gate);
    // every confidence is a sane number in [0,1]
    for (const v of Object.values(r.confidence)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(Number.isFinite(v)).toBe(true);
    }
    // weakest-link gate consistency
    const weakest = Math.min(...Object.values(r.confidence));
    expect(r.gate).toBe(
      weakest >= 0.8 ? "auto-apply" : weakest >= 0.5 ? "pm-review" : "needs-human",
    );
    // choices are in-vocab (or null, which must come with a needs-human gate)
    const nullish = [r.milestone, r.block, r.type, r.priority, r.dor_evidence].filter(
      (v) => v === null,
    ).length;
    if (nullish > 0) expect(r.gate).toBe("needs-human");
    if (r.milestone !== null) expect(["M0", "M1", "M2", "M3", "none"]).toContain(r.milestone);
    if (r.block !== null) {
      expect([
        "block:bb-ux",
        "block:agent-content",
        "block:agent-harness",
        "scope:infra",
        "none",
      ]).toContain(r.block);
    }
    if (r.type !== null) {
      expect(["type:implementation", "type:research", "type:decision"]).toContain(r.type);
    }
    if (r.priority !== null) expect(["P0", "P1", "P2"]).toContain(r.priority);
    if (r.dor_evidence !== null) expect(["probe", "anchors", "none"]).toContain(r.dor_evidence);
    expect(typeof r.needs_probe).toBe("boolean");
    expect(typeof r.needs_human).toBe("boolean");
    // the judge identifies itself as a jev model
    expect(r.judgeModel).toMatch(/^jev-/);
  },
);
