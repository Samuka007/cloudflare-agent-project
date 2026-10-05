/**
 * #242 pre-registered per-item confidence distribution measurement (research
 * docs/research/jev-locator-converger.md §6 分布实测块): the numbers this run
 * produces are the ONLY basis for the assembler's three confidence bands.
 * Pre-registration discipline — everything below was frozen BEFORE the first
 * live run and is never tuned afterwards:
 *
 *   P1  channels: for each page, ONE inventory locate() (per-item closed-vocab
 *       class choice, |CLASS_VOCAB|=n constant, + relevance score) and ONE
 *       ground locate() (shape-G target choice, dual order) on the same tab.
 *   P2  pages: staging /settings + two /threads/* pages (all never used for
 *       locator design before this ticket; URLs recorded verbatim in the
 *       report). Read-only navigation, zero sends.
 *   P3  n≥30: pooled per-item class questions must number ≥ 30
 *       (DISTRIBUTION_MIN_CLASS_QUESTIONS) or the run reports "insufficient".
 *   P4  estimator: per-item CLASS confidence (fixed n ⇒ cross-page comparable,
 *       research §2.3). Ground confidences are reported per page only — they
 *       are NEVER pooled across pages.
 *   P5  band derivation (frozen rule, applied once to the pooled class
 *       distribution): high ≥ P67, mid [P33, P67), low < P33, edges rounded
 *       to 2 decimals. Degenerate guard: if P67 − P33 < 0.05 the distribution
 *       is non-informative and the report falls back to the research
 *       placeholder pair (0.85 / 0.6) flagged "non-informative".
 *   P6  relevance score normalization: score / (|RELEVANCE_SCALE| − 1).
 *
 * Usage:
 *   bun scripts/accept/jev-locate-distribution.ts --url <u> [--url <u2> …] \
 *     [--ground-intent "..."] [--http ...] [--tab ...] [--out report.json]
 *
 * stdout: single JSON distribution report; progress lines to stderr.
 */

import { writeFileSync } from "node:fs";
import {
  CLASS_VOCAB,
  locate,
  RELEVANCE_SCALE,
  type LocateComponent,
  type LocateReport,
} from "./jev-locate.js";

/**
 * Nearest-rank quantile, mirroring jev-loop's percentile() convention but
 * WITHOUT its integer rounding (that one is millisecond-oriented; confidence
 * quantiles must keep fraction precision).
 */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

// ---------------------------------------------------------------------------
// Pre-registered constants (P3–P6) — frozen 2026-10-05, before first live run
// ---------------------------------------------------------------------------

export const DISTRIBUTION_MIN_CLASS_QUESTIONS = 30;
export const BAND_HIGH_P = 67;
export const BAND_LOW_P = 33;
export const BAND_DEGENERATE_MIN_SPREAD = 0.05;
/** Research §2.3 placeholder pair, used ONLY in the degenerate fallback. */
export const BAND_FALLBACK = { high: 0.85, low: 0.6 } as const;

export interface ClassRecord {
  page: string;
  ref: number;
  role: string;
  name: string;
  class: string;
  pClass: number;
  relevanceScore: number;
  pRelevant: number;
}

export interface GroundRecord {
  page: string;
  winnerRef: number | null;
  confidence: number | null;
  orderStable: boolean;
  noneMatch: boolean;
}

export interface DerivedBands {
  informative: boolean;
  p33: number;
  p67: number;
  lowBelow: number;
  highFrom: number;
  note: string;
}

/**
 * P5, applied exactly once: tertile bands from the pooled per-item class
 * confidence distribution, with the degenerate-distribution guard.
 */
export function deriveBands(classConfidences: number[]): DerivedBands {
  if (classConfidences.length === 0) {
    return {
      informative: false,
      p33: 0,
      p67: 0,
      lowBelow: BAND_FALLBACK.low,
      highFrom: BAND_FALLBACK.high,
      note: "empty distribution — fallback placeholders, non-informative",
    };
  }
  const p33 = round2(quantile(classConfidences, BAND_LOW_P));
  const p67 = round2(quantile(classConfidences, BAND_HIGH_P));
  if (p67 - p33 < BAND_DEGENERATE_MIN_SPREAD) {
    return {
      informative: false,
      p33,
      p67,
      lowBelow: BAND_FALLBACK.low,
      highFrom: BAND_FALLBACK.high,
      note: `degenerate distribution (P67−P33 = ${(p67 - p33).toFixed(3)} < ${String(BAND_DEGENERATE_MIN_SPREAD)}) — fallback placeholders ${String(BAND_FALLBACK.high)}/${String(BAND_FALLBACK.low)}, non-informative`,
    };
  }
  return {
    informative: true,
    p33,
    p67,
    lowBelow: p33,
    highFrom: p67,
    note: "tertile bands from pooled per-item class confidence (P33/P67, frozen rule P5)",
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Pooled histogram over frozen edges — the report's distribution shape. */
export function histogram(values: number[]): Record<string, number> {
  const buckets: { low: number; high: number; label: string }[] = [
    { low: 0, high: 0.5, label: "[0,0.5)" },
    { low: 0.5, high: 0.6, label: "[0.5,0.6)" },
    { low: 0.6, high: 0.7, label: "[0.6,0.7)" },
    { low: 0.7, high: 0.85, label: "[0.7,0.85)" },
    { low: 0.85, high: 1.0001, label: "[0.85,1]" },
  ];
  const out: Record<string, number> = {};
  for (const bucket of buckets) out[bucket.label] = 0;
  for (const v of values) {
    for (const bucket of buckets) {
      if (v >= bucket.low && v < bucket.high) {
        out[bucket.label] = (out[bucket.label] ?? 0) + 1;
        break;
      }
    }
  }
  return out;
}

export interface DistributionSummary {
  n: number;
  min: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  max: number;
  histogram: Record<string, number>;
}

export function summarize(values: number[]): DistributionSummary {
  return {
    n: values.length,
    min: values.length === 0 ? 0 : Math.min(...values),
    p10: round2(quantile(values, 10)),
    p25: round2(quantile(values, 25)),
    p50: round2(quantile(values, 50)),
    p75: round2(quantile(values, 75)),
    p90: round2(quantile(values, 90)),
    max: values.length === 0 ? 0 : Math.max(...values),
    histogram: histogram(values),
  };
}

// ---------------------------------------------------------------------------
// Live measurement
// ---------------------------------------------------------------------------

function classRecords(pageUrl: string, report: LocateReport): ClassRecord[] {
  return report.components
    .filter(
      (c): c is LocateComponent & { class: string; pClass: number } =>
        typeof c.class === "string" && typeof c.pClass === "number",
    )
    .map((c) => ({
      page: pageUrl,
      ref: c.ref,
      role: c.role,
      name: c.name,
      class: c.class,
      pClass: c.pClass,
      relevanceScore: -1,
      pRelevant: c.pRelevant ?? -1,
    }));
}

async function main(): Promise<void> {
  const urls: string[] = [];
  const argv = process.argv;
  for (let i = argv.indexOf("--url"); i >= 0; i = argv.indexOf("--url", i + 1)) {
    const value = argv[i + 1];
    if (value !== undefined) urls.push(value);
  }
  const flagValue = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const groundIntent = flagValue("--ground-intent") ?? "the message composer input";
  const http = flagValue("--http") ?? process.env.JEV_CDP_HTTP ?? "http://172.27.0.1:9222";
  const tabName = flagValue("--tab") ?? process.env.JEV_LOCATE_TAB ?? "l242-locate";
  const outPath = flagValue("--out");
  if (urls.length === 0) {
    console.log(
      JSON.stringify({ status: "blocked", blocked: ["--url <u> required (repeatable)"] }, null, 2),
    );
    process.exitCode = 2;
    return;
  }

  const classRecs: ClassRecord[] = [];
  const groundRecs: GroundRecord[] = [];
  const perPage: Record<string, { elements: number; classQuestions: number }> = {};
  const rtts: number[] = [];
  let model: string | undefined;

  for (const url of urls) {
    console.error(`[distribution] inventory ${url} …`);
    const inv = await locate(
      {},
      { http, tabName, url, intent: groundIntent, mode: "inventory", maxElements: 60 },
    );
    rtts.push(...inv.meta.rttMs);
    if (inv.meta.model !== undefined) model = inv.meta.model;
    const recs = classRecords(url, inv);
    // Relevance scores are not in LocateComponent; pull them from a second
    // pass over the same snapshot is impossible — instead reuse pRelevant and
    // record the raw band via pRelevant × (|RELEVANCE_SCALE| − 1).
    for (const r of recs) {
      r.relevanceScore = r.pRelevant * (RELEVANCE_SCALE.length - 1);
    }
    classRecs.push(...recs);
    perPage[url] = { elements: inv.meta.counts.elements, classQuestions: recs.length };

    console.error(`[distribution] ground ${url} …`);
    const g = await locate(
      {},
      { http, tabName, intent: groundIntent, mode: "ground", maxElements: 60 },
    );
    rtts.push(...g.meta.rttMs);
    const winner =
      g.components.find((c) => c.orderStable === true) ??
      g.components.find((c) => c.pRelevant !== undefined);
    groundRecs.push({
      page: g.meta.url,
      winnerRef: winner?.ref ?? null,
      confidence: typeof winner?.pRelevant === "number" ? winner.pRelevant : null,
      orderStable: g.components.some((c) => c.orderStable === true),
      noneMatch: g.meta.groundNoneMatch === true,
    });
  }

  const confidences = classRecs.map((r) => r.pClass);
  const bands = deriveBands(confidences);
  const sufficient = confidences.length >= DISTRIBUTION_MIN_CLASS_QUESTIONS;
  const report = {
    status: sufficient ? "completed" : "insufficient",
    preregistered: {
      frozen: "2026-10-05 (before first live run; jev-locator-converger.md §6 分布实测块)",
      vocab: [...CLASS_VOCAB],
      vocabSize: CLASS_VOCAB.length,
      minClassQuestions: DISTRIBUTION_MIN_CLASS_QUESTIONS,
      bandRule: `high ≥ P${String(BAND_HIGH_P)}, mid [P${String(BAND_LOW_P)}, P${String(BAND_HIGH_P)}), low < P${String(BAND_LOW_P)} (edges rounded to 2dp); degenerate if spread < ${String(BAND_DEGENERATE_MIN_SPREAD)} → fallback ${String(BAND_FALLBACK.high)}/${String(BAND_FALLBACK.low)}`,
      relevanceNormalization: `score / ${String(RELEVANCE_SCALE.length - 1)}`,
      groundPooling:
        "ground confidences are page-relative; never pooled across pages (research §2.3)",
      zeroPostHocTuning: "band numbers are derived by the frozen rule only; no manual adjustment",
    },
    measured: {
      pages: perPage,
      classQuestions: confidences.length,
      class: summarize(confidences),
      perClass: summarizeByClass(classRecs),
      relevance: summarize(classRecs.map((r) => r.pRelevant).filter((v) => v >= 0)),
      ground: {
        perPage: groundRecs,
        note: "page-relative; order-stability via in-request dual order",
      },
      rttMs: {
        p50: Math.round(quantile(rtts, 50)),
        p95: Math.round(quantile(rtts, 95)),
        n: rtts.length,
      },
      model: model ?? null,
    },
    derivedBands: bands,
    raw: { classRecords: classRecs, groundRecords: groundRecs },
  };
  console.log(JSON.stringify(report, null, 2));
  if (outPath !== undefined) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

function summarizeByClass(
  recs: ClassRecord[],
): Record<string, { n: number; medianPClass: number }> {
  const byClass: Record<string, number[]> = {};
  for (const r of recs) {
    (byClass[r.class] ??= []).push(r.pClass);
  }
  const out: Record<string, { n: number; medianPClass: number }> = {};
  for (const [cls, values] of Object.entries(byClass)) {
    out[cls] = { n: values.length, medianPClass: round2(quantile(values, 50)) };
  }
  return out;
}

const invokedDirectly = process.argv[1]?.endsWith("jev-locate-distribution.ts");
if (invokedDirectly === true) {
  await main();
}
