/**
 * #242 recall-audit unit tests — pure gap math + the SEL-mirror lockstep
 * between the audit's in-page probe and the jev-loop kernel (no network).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUDIT_SEL,
  computeChannelGap,
  HEURISTIC_PROBE_EXPRESSION,
  type Candidate,
} from "../accept/jev-recall-audit.js";

const cand = (role: string, name: string): Candidate => ({ role, name });

describe("computeChannelGap", () => {
  it("matches B to A exactly, by name, and reports the rest as gap candidates", () => {
    const a = [cand("button", "Stop"), cand("link", "Settings"), cand("textbox", "Message")];
    const b = [
      cand("button", "Stop"), // exact
      cand("link", "Settings"), // exact
      cand("generic", "Message"), // name-only (AX names the role differently)
      cand("button", "Hidden wizard control"), // true gap candidate
      cand("button", "Hidden wizard control"), // deduped
    ];
    const gap = computeChannelGap(a, b, []);
    expect(gap.matchedExact).toBe(2);
    expect(gap.matchedByName).toBe(1);
    expect(gap.bOnly).toEqual([cand("button", "Hidden wizard control")]);
  });

  it("carries channel-C heuristic hits through unchanged", () => {
    const gap = computeChannelGap(
      [cand("button", "Stop")],
      [],
      [{ role: "div", name: "card", why: "cursor" }],
    );
    expect(gap.cOnly).toEqual([{ role: "div", name: "card", why: "cursor" }]);
  });

  it("treats nameless B nodes as gap candidates (never matched by empty name)", () => {
    const a = [cand("button", "Stop")];
    const b = [cand("button", "")];
    const gap = computeChannelGap(a, b, []);
    expect(gap.matchedExact).toBe(0);
    expect(gap.matchedByName).toBe(0);
    expect(gap.bOnly).toEqual([cand("button", "")]);
  });
});

describe("SEL mirror lockstep", () => {
  /** The kernel's in-page SEL literal, extracted from source (not imported —
   *  it lives inside the extractExpression template string). */
  const kernelSel = (() => {
    const source = readFileSync(new URL("../accept/jev-loop.ts", import.meta.url), "utf8");
    const match = /const SEL = '([^']+)';/.exec(source);
    if (match === null) throw new TypeError("jev-loop.ts SEL literal not found");
    return match[1] ?? "";
  })();

  it("audit SEL is byte-identical to the kernel's A-channel whitelist", () => {
    expect(AUDIT_SEL).toBe(kernelSel);
  });

  it("the in-page probe embeds the same SEL", () => {
    expect(HEURISTIC_PROBE_EXPRESSION).toContain(JSON.stringify(AUDIT_SEL));
  });
});
