/**
 * pm-walk.ts — #392 the AP.walk CLI driver (scripts/accept/ family).
 *
 * Thin wrapper: parses argv, calls AP.walk, prints the compact summary,
 * exits 0/1 on report.ok — CI-able real-surface acceptance. Evidence files
 * land wherever the walk writes them (.pm-walk/ or --out).
 *
 * Transport: the kernel `browser` facade is NOT visible to a bare bun
 * process — this driver walks over raw CDP (--cdp, e.g. the local headless
 * Chromium or the Windows bridge) or the fetch fallback (--fetch-fallback).
 * In-kernel walks (the default facade surface) call AP.walk directly from an
 * eval cell instead.
 *
 * Usage:
 *   bun scripts/accept/pm-walk.ts --url https://staging.example/settings \
 *     [--check "<css>"]... [--at-least <n>] [--text <substr>] \
 *     [--cdp http://127.0.0.1:9222] [--tab l392-walk] [--settle 3000] \
 *     [--out <dir>] [--fetch-fallback]
 *
 * --at-least/--text modify the most recent --check.
 */

import { writeFileSync } from "node:fs";
import { walk } from "../../plugins/pm-harness/src/walk.js";
import type { WalkCheck, WalkReport } from "../../plugins/pm-harness/src/walk.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function argValues(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag) {
      const value = process.argv[i + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

const url = argValue("--url");
if (url === undefined) {
  console.error("pm-walk: --url is required");
  process.exit(2);
}

const checks: WalkCheck[] = [];
for (const selector of argValues("--check")) {
  checks.push({ selector });
}
const atLeast = argValue("--at-least");
if (atLeast !== undefined && checks.length > 0) {
  const last = checks[checks.length - 1];
  if (last !== undefined) last.atLeast = Number.parseInt(atLeast, 10);
}
const text = argValue("--text");
if (text !== undefined && checks.length > 0) {
  const last = checks[checks.length - 1];
  if (last !== undefined) last.text = text;
}

const cdpHttp = argValue("--cdp");
const outDir = argValue("--out");

const report: WalkReport = await walk(url, checks, {
  ...(argValue("--tab") !== undefined ? { tabName: argValue("--tab") } : {}),
  ...(cdpHttp !== undefined ? { cdpHttp } : {}),
  ...(outDir !== undefined ? { outDir } : {}),
  ...(argValue("--settle") !== undefined
    ? { settleMs: Number.parseInt(argValue("--settle") ?? "3000", 10) }
    : {}),
  ...(process.argv.includes("--fetch-fallback") ? { allowFetchFallback: true } : {}),
});

const lines = [
  `== pm-walk: ${report.ok ? "PASS" : "FAIL"} ${report.url}`,
  `  transport=${report.transport}${report.cdpHttp === "" ? "" : ` (${report.cdpHttp})`} tab=${report.tabName} console=${report.consoleCapture}`,
  `  title=${JSON.stringify(report.title)} finalUrl=${report.finalUrl}`,
  `  checks=${String(report.checks.filter((c) => c.passed).length)}/${String(report.checks.length)} passed consoleErrors=${String(report.consoleErrors.length)} failedRequests=${String(report.failedRequests.length)}`,
  ...report.checks.map(
    (check) =>
      `  ${check.passed ? "PASS" : "FAIL"} ${check.selector} count=${String(check.count)} ≥${String(check.atLeast)}${check.why !== undefined ? ` — ${check.why}` : ""}`,
  ),
  ...report.consoleErrors
    .slice(0, 10)
    .map((error) => `  [${error.kind}] ${error.text.slice(0, 200)}`),
  ...report.failedRequests
    .slice(0, 10)
    .map(
      (failed) =>
        `  [net] ${failed.url.slice(0, 160)}${failed.status !== undefined ? ` → ${String(failed.status)}` : ""}`,
    ),
  `  evidence=${report.evidence.anchor === "" ? "(not written)" : report.evidence.anchor}`,
];
console.log(lines.join("\n"));

const outPath = argValue("--save");
if (outPath !== undefined) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

process.exit(report.ok ? 0 : 1);
