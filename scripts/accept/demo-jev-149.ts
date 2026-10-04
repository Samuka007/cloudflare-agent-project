/**
 * #177 one-cell demo: replay the accepted #149 flow through the jev-loop
 * kernel on staging:
 *
 *   open thread thr_jk45qe4786 → Settings → toggle "Show unhandled provider
 *   events" ON → CODE-assert "Unhandled agent event" row appears in the
 *   timeline → toggle OFF → CODE-assert the row disappears.
 *
 * Row presence is asserted in code, never jev-judged (jaggedness: counting
 * and text matching are not jev jobs). The verdict JSON carries the measured
 * jev RTTs and snapshot token sizes for the ticket evidence. Runs on the
 * lane's dedicated tab `jev-loop-l177` (shared-bridge ops rule); the tab is
 * closed on exit.
 *
 * Usage: bun scripts/accept/demo-jev-149.ts   (JEV_API_KEY via env or .env.local)
 */

import { JevError, openTab, resolveJeapiKey, runFlow, type FlowAssertion, type FlowProbe, type FlowReport, type JevPage } from "./jev-loop.js";

const CDP_HTTP = process.env.JEV_CDP_HTTP ?? "http://172.27.0.1:9222";
const STAGING_HOST = "cap-server-staging.dai-samuel.workers.dev";
const THREAD_URL = `https://${STAGING_HOST}/threads/thr_jk45qe4786`;
const TAB_NAME = "jev-loop-l177";
const ROW_TITLE = "Unhandled agent event";
const SWITCH_LABEL = "Show unhandled provider events";

/** Code assertion: return to the thread face, then check row presence in DOM text. */
function assertRow(name: string, expectPresent: boolean): FlowAssertion {
  return {
    name,
    check: async (probe: FlowProbe) => {
      await probe.page.navigate(THREAD_URL, 1500);
      const present = (await probe.bodyText()).includes(ROW_TITLE);
      return present === expectPresent
        ? true
        : `"${ROW_TITLE}" row ${expectPresent ? "absent (expected present)" : "present (expected absent)"} after reload`;
    },
  };
}

interface PhaseSummary {
  ok: boolean;
  goalReached: boolean;
  stopped?: { reason: string; step: number };
  escalated?: boolean;
  assertions: { name: string; pass: boolean; detail?: string }[];
  steps: number;
  metrics: FlowReport["metrics"];
  degradedTo?: "compact";
  stepDetail?: FlowReport["steps"];
}

function summarize(report: FlowReport, verbose: boolean): PhaseSummary {
  return {
    ok: report.ok,
    goalReached: report.goalReached,
    stopped: report.stopped,
    escalated: report.escalated,
    assertions: report.assertions,
    steps: report.steps.length,
    metrics: report.metrics,
    degradedTo: report.degradedTo,
    ...(verbose ? { stepDetail: report.steps } : {}),
  };
}

const TOGGLE_ON_GOAL = `Open the app Settings (sidebar link "Settings (Ctrl + ,)") and turn the Debug toggle "${SWITCH_LABEL}" ON. The task is complete as soon as that switch shows checked=true on the Settings page; verifying the timeline afterwards is handled outside this task.`;
const TOGGLE_OFF_GOAL = `Open the app Settings (sidebar link "Settings (Ctrl + ,)") and turn the Debug toggle "${SWITCH_LABEL}" OFF. The task is complete as soon as that switch shows checked=false on the Settings page; verifying the timeline afterwards is handled outside this task.`;

async function main(): Promise<void> {
  if (resolveJeapiKey() === null) {
    throw new JevError("no JEV_API_KEY (process env or gitignored .env.local walking up from scripts/accept)");
  }
  const page: JevPage = await openTab({ http: CDP_HTTP, tabName: TAB_NAME, url: THREAD_URL });
  const verbose = process.env.JEV_DEMO_VERBOSE === "1";
  const flowBase = {
    allowlist: [STAGING_HOST],
    stateMode: "auto" as const,
    rttBudgetMs: 800,
    maxSteps: 8,
  };
  const verdict: Record<string, unknown> = { tab: TAB_NAME, thread: THREAD_URL, cdp: CDP_HTTP };
  let ok = true;
  try {
    await page.settle(1500);

    // Deterministic baseline: if a previous run left the toggle ON, normalize
    // first so the ON phase's "row appears" assertion is not vacuous.
    const baselineBody = await page.evalJs<string>("(document.body ? document.body.innerText : '')");
    if (baselineBody.includes(ROW_TITLE)) {
      const normalize = await runFlow({
        ...flowBase,
        page,
        goal: TOGGLE_OFF_GOAL,
        assertions: [assertRow("normalize: row absent with toggle off", false)],
      });
      verdict.normalize = summarize(normalize, verbose);
      if (!normalize.assertions.every((a) => a.pass)) ok = false;
    } else {
      verdict.normalize = "skipped (baseline row already absent)";
    }

    const phaseOn = await runFlow({
      ...flowBase,
      page,
      goal: TOGGLE_ON_GOAL,
      assertions: [assertRow("row appears when toggle on", true)],
    });
    const phaseOff = await runFlow({
      ...flowBase,
      page,
      goal: TOGGLE_OFF_GOAL,
      assertions: [assertRow("row disappears when toggle off", false)],
    });
    verdict.on = summarize(phaseOn, verbose);
    verdict.off = summarize(phaseOff, verbose);
    // Acceptance per #177: the #149 flow replay is judged by CODE assertions
    // (row presence on/off), not by jev's own goal gate. A phase whose
    // assertions all passed counts, even when the loop then stopped on a
    // post-goal confidence floor (recorded as diagnostic detail).
    const phaseAccepted = (r: FlowReport): boolean =>
      r.assertions.length > 0 && r.assertions.every((a) => a.pass) && r.steps.some((s) => s.executed === true);
    ok = ok && phaseAccepted(phaseOn) && phaseAccepted(phaseOff);
    verdict.diagnostic = {
      on: { ok: phaseOn.ok, stopped: phaseOn.stopped },
      off: { ok: phaseOff.ok, stopped: phaseOff.stopped },
    };

    // Aggregate evidence across phases (K1 RTT at full-content size).
    const rtts = [phaseOn, phaseOff].flatMap((r) => r.metrics.jevRttMs);
    const sorted = rtts.slice().sort((a, b) => a - b);
    verdict.totals = {
      jevCalls: phaseOn.metrics.jevCalls + phaseOff.metrics.jevCalls,
      jevRttMs: rtts,
      jevRttP50: sorted.length > 0 ? sorted[Math.floor((sorted.length - 1) / 2)] : 0,
      snapshotTokensMax: Math.max(phaseOn.metrics.stateTokensMax, phaseOff.metrics.stateTokensMax),
      inputTokensTotal: phaseOn.metrics.inputTokensTotal + phaseOff.metrics.inputTokensTotal,
      wallMs: phaseOn.metrics.wallMs + phaseOff.metrics.wallMs,
      stateModeUsed: phaseOn.metrics.stateModeUsed,
      degradedTo: phaseOn.degradedTo ?? phaseOff.degradedTo,
      model: phaseOn.model ?? phaseOff.model,
    };
    verdict.ok = ok;
    console.log(JSON.stringify(verdict, null, 2));
  } finally {
    await page.destroy({ closeTab: true });
  }
  if (!ok) process.exitCode = 1;
}

await main();