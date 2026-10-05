import { afterEach, expect, test } from "vitest";
import { _inject, intake, lane, resolveJeapiKey } from "../src/core.js";

/**
 * Real-call jev smoke (#131 CRITICAL: the judge layer is a REAL model call).
 * Runs exactly one live POST to the systemone endpoint and asserts the
 * reply's shape invariants. Skips itself when no JEV_API_KEY is resolvable
 * (process env or gitignored .env.local) — CI stays green without secrets.
 */

afterEach(() => {
  _inject(null);
});

/** omp eval-kernel global view (named per repo cast rule; typeof guards do
 *  the validation). */
const kernelScope = globalThis as { agent?: unknown };

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

/**
 * #206 real-bridge demo (the ticket's acceptance): lane(confirm) end-to-end
 * through the LIVE omp kernel transport — real spawn, agent:// handle, then
 * the guarded board flip. Triple-gated so CI never spawns: a kernel `agent`
 * global AND AP_LANE_SMOKE=1 AND AP_LANE_TICKET=<dispatchable number>
 * (open ∧ Todo ∧ no open blockers). In plain vitest/node all three are
 * absent → skips; inside a kernel-backed runner with the flags set, this is
 * the "新会话 %load 后 lane(confirm) 端到端真派发" proof.
 */
const laneSmokeArmed =
  typeof kernelScope.agent === "function" &&
  process.env.AP_LANE_SMOKE === "1" &&
  Number.isInteger(Number(process.env.AP_LANE_TICKET));

test.skipIf(!laneSmokeArmed)(
  "smoke: real kernel transport — lane(confirm) spawns end-to-end and flips the board (#206)",
  { timeout: 600_000 },
  async () => {
    if (!laneSmokeArmed) throw new Error("unreachable: skipIf guards the arming flags");
    const rep = await lane(Number(process.env.AP_LANE_TICKET), {}, { confirm: true });
    expect(rep.ok).toBe(true);
    expect(rep.spawned).toBe(true);
    expect(["default", "registered"]).toContain(rep.transport);
    expect(rep.agentId ?? rep.agentHandle).toBeTruthy();
    expect(rep.statusFlipped).toBe(true);
  },
);
