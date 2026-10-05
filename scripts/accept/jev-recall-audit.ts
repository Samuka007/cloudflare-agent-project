/**
 * #242 enumeration recall audit (research docs/research/jev-locator-converger.md
 * §2.1 / §6): on real staging pages, quantify how many TRUE interactive
 * candidates the A main path (jev-loop SEL whitelist snapshot) sees vs the
 * B/C control channels — the numbers that decide whether the main path stays
 * A or grows toward B/C.
 *
 * Channels:
 *   A  jev-loop `snapshot()` enumeration — SEL whitelist + visibility +
 *      viewport-first rank (the production main path, reused verbatim).
 *   B  CDP `Accessibility.getFullAXTree` — computed AX roles; nodes in an
 *      interactive AX-role set that A cannot account for are GAP CANDIDATES.
 *   C  in-page heuristic rescan — `cursor:pointer` / onclick / tabindex
 *      elements outside the SEL whitelist (audit-only, never a main path).
 *
 * Honesty rule: B/C hits are GAP CANDIDATES, not proven misses — a candidate
 * is only a confirmed recall gap after human inspection of the (role, name)
 * pair. The report exists to size the gap, not to auto-upgrade the main path.
 *
 * Pre-registration: this file freezes pages/channel definitions BEFORE the
 * first live run (2026-10-05); the report records whatever the run observed,
 * with zero post-hoc channel redefinition.
 *
 * Usage:
 *   bun scripts/accept/jev-recall-audit.ts --url <u> [--url <u2> …] \
 *     [--http http://172.27.0.1:9222] [--tab l242-locate] [--out report.json]
 *
 * stdout: single JSON audit report; progress lines to stderr.
 */

import { writeFileSync } from "node:fs";
import { openTab, snapshot } from "./jev-loop.js";

// ---------------------------------------------------------------------------
// Frozen channel definitions (pre-registered 2026-10-05)
// ---------------------------------------------------------------------------

/**
 * Verbatim mirror of the jev-loop kernel's in-page SEL whitelist (the A
 * channel's selector). Kept in lockstep with jev-loop.ts by a unit test that
 * extracts the SEL literal from the kernel source and compares.
 */
export const AUDIT_SEL =
  'a[href],button,input,select,textarea,summary,[contenteditable="true"],[contenteditable=""],[role="button"],[role="switch"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="textbox"],[role="searchbox"],[role="slider"]';

/** AX roles counted as interactive candidates in channel B (pre-registered). */
export const AX_INTERACTIVE_ROLES = [
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "combobox",
  "option",
  "slider",
] as const;

/** Static membership table (Record per repo set/map convention). */
export const AX_INTERACTIVE: Record<string, true> = Object.fromEntries(
  AX_INTERACTIVE_ROLES.map((role) => [role, true as const]),
);

/** In-page heuristic probe (channel C): page-derived, audit-only. */
export const HEURISTIC_PROBE_EXPRESSION = `/*__jevRecallAudit*/ (() => {
"use strict";
const SEL = ${JSON.stringify(AUDIT_SEL)};
const NAME_MAX = 48;
function txt(s, max) { s = (s == null ? "" : String(s)).replace(/\\s+/g, " ").trim(); return s.length > max ? s.slice(0, max - 1) + "\\u2026" : s; }
function labelOf(el) {
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return txt(aria, NAME_MAX);
  const ph = el.getAttribute && el.getAttribute("placeholder");
  if (ph && ph.trim()) return txt(ph, NAME_MAX);
  const own = txt(el.textContent, NAME_MAX);
  if (own) return own;
  const ti = el.getAttribute("title");
  if (ti && ti.trim()) return txt(ti, NAME_MAX);
  return "";
}
function roleOf(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "button" || t === "submit") return "button";
    return "textbox";
  }
  if (tag === "button") return "button";
  if (tag === "a") return el.hasAttribute("href") ? "link" : "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (el.isContentEditable) return "textbox";
  return tag;
}
const inA = new Set();
const aEls = [];
for (const el of document.querySelectorAll(SEL)) {
  const r = el.getBoundingClientRect();
  let visible = r.width >= 2 && r.height >= 2;
  if (visible) { const s = getComputedStyle(el); visible = s.display !== "none" && s.visibility !== "hidden"; }
  if (!visible) continue;
  aEls.push(el);
  inA.add(roleOf(el) + " " + labelOf(el));
}
// ancestor dedup: a heuristic hit nested under an already-counted element is
// the same control (mirrors the kernel's ancestor-dedup rule)
const claimed = new Set(aEls);
const isClaimed = (el) => { for (let a = el.parentElement; a; a = a.parentElement) { if (claimed.has(a)) return true; } return false; };
const cOnly = [];
for (const el of document.querySelectorAll("*")) {
  if (el.matches(SEL)) continue;
  let why = "";
  try { if (getComputedStyle(el).cursor === "pointer") why = "cursor"; } catch {}
  if (!why && (typeof el.onclick === "function" || el.hasAttribute("onclick"))) why = "onclick";
  if (!why) { const ti = el.getAttribute("tabindex"); if (ti !== null && Number(ti) >= 0 && el.getAttribute("aria-disabled") !== "true") why = "tabindex"; }
  if (!why) continue;
  const r = el.getBoundingClientRect();
  if (!(r.width >= 2 && r.height >= 2)) continue;
  const s = getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden") continue;
  if (isClaimed(el)) continue;
  const role = roleOf(el);
  const name = labelOf(el);
  const key = role + " " + name;
  if (inA.has(key)) continue;
  claimed.add(el);
  inA.add(key);
  cOnly.push({ tag: el.tagName, role, name, why });
}
return JSON.stringify({ aCount: aEls.length, cOnly });
})()`;

// ---------------------------------------------------------------------------
// Pure gap math (unit-tested; no I/O)
// ---------------------------------------------------------------------------

export interface Candidate {
  role: string;
  name: string;
  /** Channel-C reason only (cursor/onclick/tabindex). */
  why?: string;
}

export interface ChannelGap {
  /** B candidates A accounts for by exact (role,name). */
  matchedExact: number;
  /** B candidates A accounts for by name alone (role naming differs). */
  matchedByName: number;
  /** GAP CANDIDATES: B sees an interactive control A does not account for. */
  bOnly: Candidate[];
  /** Channel-C heuristic hits outside A (same candidate semantics). */
  cOnly: Candidate[];
}

const keyOf = (c: Candidate): string => `${c.role} ${c.name}`;

export function computeChannelGap(a: Candidate[], b: Candidate[], cOnly: Candidate[]): ChannelGap {
  const exact = new Set(a.map(keyOf));
  const byName = new Set(a.map((c) => c.name));
  const bOnly: Candidate[] = [];
  let matchedExact = 0;
  let matchedByName = 0;
  const seenB = new Set<string>();
  for (const cand of b) {
    const key = keyOf(cand);
    if (seenB.has(key)) continue; // AX tree repeats names across nodes
    seenB.add(key);
    if (exact.has(key)) {
      matchedExact += 1;
      continue;
    }
    if (cand.name.length > 0 && byName.has(cand.name)) {
      matchedByName += 1;
      continue;
    }
    bOnly.push(cand);
  }
  return { matchedExact, matchedByName, bOnly, cOnly };
}

// ---------------------------------------------------------------------------
// Live channels
// ---------------------------------------------------------------------------

interface AxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: { type: string; value: string };
  name?: { type: string; value?: string };
  properties?: { name: string; value: { type: string; value?: unknown } }[];
}

/** Channel B: interactive candidates from the computed AX tree. */
export async function axCandidates(page: {
  cdp<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}): Promise<Candidate[]> {
  const tree = await page.cdp<{ nodes?: AxNode[] }>("Accessibility.getFullAXTree", {});
  const out: Candidate[] = [];
  for (const node of tree.nodes ?? []) {
    if (node.ignored === true) continue;
    const role = node.role?.value;
    if (role === undefined || AX_INTERACTIVE[role] !== true) continue;
    const name = (node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
    out.push({ role, name });
  }
  return out;
}

export interface PageAudit {
  url: string;
  title: string;
  gen: number;
  aCount: number;
  aTrimmed: number;
  stateTokens: number;
  bInteractive: number;
  gap: {
    matchedExact: number;
    matchedByName: number;
    bOnly: Candidate[];
    cOnly: Candidate[];
  };
}

async function auditPage(
  page: Parameters<typeof axCandidates>[0] & {
    navigate(url: string, settleMs?: number): Promise<void>;
    evalJs<T>(expression: string): Promise<T>;
    url(): Promise<string>;
  },
  targetUrl: string,
): Promise<PageAudit> {
  await page.navigate(targetUrl, 2500);
  const snap = await snapshot(page as never);
  const probeRaw = await page.evalJs<string>(HEURISTIC_PROBE_EXPRESSION);
  const probe = JSON.parse(probeRaw) as { aCount: number; cOnly: Candidate[] };
  const b = await axCandidates(page);
  const a: Candidate[] = snap.elements.map((e) => ({ role: e.role, name: e.name }));
  return {
    url: snap.url,
    title: snap.title,
    gen: snap.gen,
    aCount: snap.elements.length,
    aTrimmed: snap.trimmedElements,
    stateTokens: snap.tokens,
    bInteractive: b.length,
    gap: computeChannelGap(a, b, probe.cOnly),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValues(flag: string): string[] {
  const out: string[] = [];
  const argv = process.argv;
  for (let i = argv.indexOf(flag); i >= 0 && i < argv.length; i = argv.indexOf(flag, i + 1)) {
    const value = argv[i + 1];
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** First value after `flag`, or undefined when the flag is absent. */
function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<void> {
  const urls = argValues("--url");
  const http = argValue("--http") ?? process.env.JEV_CDP_HTTP ?? "http://172.27.0.1:9222";
  const tabName = argValue("--tab") ?? process.env.JEV_LOCATE_TAB ?? "l242-locate";
  const outPath = argValue("--out");
  if (urls.length === 0) {
    console.log(
      JSON.stringify({ status: "blocked", blocked: ["--url <u> required (repeatable)"] }, null, 2),
    );
    process.exitCode = 2;
    return;
  }
  const page = await openTab({ http, tabName });
  const pages: PageAudit[] = [];
  try {
    for (const targetUrl of urls) {
      console.error(`[recall-audit] auditing ${targetUrl} …`);
      pages.push(await auditPage(page, targetUrl));
      const last = pages[pages.length - 1];
      console.error(
        `[recall-audit] A=${String(last?.aCount)} B=${String(last?.bInteractive)} bOnly=${String(last?.gap.bOnly.length)} cOnly=${String(last?.gap.cOnly.length)}`,
      );
    }
  } finally {
    await page.destroy({ closeTab: false });
  }
  const totals = {
    pages: pages.length,
    aSum: pages.reduce((acc, p) => acc + p.aCount, 0),
    bOnlySum: pages.reduce((acc, p) => acc + p.gap.bOnly.length, 0),
    cOnlySum: pages.reduce((acc, p) => acc + p.gap.cOnly.length, 0),
  };
  const report = {
    status: "completed",
    preregistered: {
      frozen: "2026-10-05 (before first live run; jev-locator-converger.md §6 枚举审计块)",
      channels:
        "A=jev-loop snapshot SEL whitelist; B=CDP AX tree interactive roles; C=cursor/onclick/tabindex heuristic (audit-only)",
      honesty: "B/C hits are GAP CANDIDATES pending human inspection, not proven misses",
      axInteractiveRoles: AX_INTERACTIVE_ROLES,
    },
    totals,
    pages,
  };
  console.log(JSON.stringify(report, null, 2));
  if (outPath !== undefined) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

const invokedDirectly = process.argv[1]?.endsWith("jev-recall-audit.ts");
if (invokedDirectly === true) {
  await main();
}
