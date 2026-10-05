/**
 * #242 distribution-measurement unit tests — pure band-derivation and summary
 * math, plus the pre-registration invariants (no network).
 */

import { describe, expect, it } from "vitest";
import {
  BAND_DEGENERATE_MIN_SPREAD,
  BAND_FALLBACK,
  deriveBands,
  DISTRIBUTION_MIN_CLASS_QUESTIONS,
  histogram,
  summarize,
} from "../accept/jev-locate-distribution.js";

describe("deriveBands (frozen rule P5)", () => {
  it("derives tertile bands from a spread distribution", () => {
    const values: number[] = [];
    for (let i = 1; i <= 100; i += 1) values.push(i / 100); // 0.01 … 1.00
    const bands = deriveBands(values);
    expect(bands.informative).toBe(true);
    expect(bands.p33).toBeGreaterThan(0);
    expect(bands.p67).toBeGreaterThan(bands.p33);
    expect(bands.lowBelow).toBe(bands.p33);
    expect(bands.highFrom).toBe(bands.p67);
    expect(bands.note).toContain("P33/P67");
  });

  it("falls back to placeholders and flags non-informative on a degenerate distribution", () => {
    const bands = deriveBands([0.92, 0.93, 0.92, 0.94, 0.93]);
    expect(bands.informative).toBe(false);
    expect(bands.p67 - bands.p33).toBeLessThan(BAND_DEGENERATE_MIN_SPREAD);
    expect(bands.highFrom).toBe(BAND_FALLBACK.high);
    expect(bands.lowBelow).toBe(BAND_FALLBACK.low);
    expect(bands.note).toContain("non-informative");
  });

  it("handles the empty run without inventing numbers", () => {
    const bands = deriveBands([]);
    expect(bands.informative).toBe(false);
    expect(bands.highFrom).toBe(BAND_FALLBACK.high);
  });
});

describe("histogram (frozen edges)", () => {
  it("buckets exactly at the pre-registered edges", () => {
    const h = histogram([0, 0.49, 0.5, 0.59, 0.6, 0.69, 0.7, 0.84, 0.85, 1]);
    expect(h).toEqual({
      "[0,0.5)": 2,
      "[0.5,0.6)": 2,
      "[0.6,0.7)": 2,
      "[0.7,0.85)": 2,
      "[0.85,1]": 2,
    });
  });
});

describe("summarize", () => {
  it("quantiles and extrema on a known array", () => {
    const s = summarize([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
    expect(s.n).toBe(10);
    expect(s.min).toBeCloseTo(0.1);
    expect(s.max).toBeCloseTo(1.0);
    // Nearest-rank convention: P50 of 10 samples = 5th smallest.
    expect(s.p50).toBeCloseTo(0.5);
    expect(s.p10).toBeCloseTo(0.1);
    expect(s.p90).toBeCloseTo(0.9);
  });
});

describe("pre-registration invariants", () => {
  it("keeps the frozen floor and band edges", () => {
    expect(DISTRIBUTION_MIN_CLASS_QUESTIONS).toBe(30);
    expect(BAND_FALLBACK).toEqual({ high: 0.85, low: 0.6 });
  });
});
