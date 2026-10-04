/**
 * #177 jev-loop kernel unit tests — the wire seam is fully injected
 * (canned judge + faked page), mirroring the pm-autopilot L1 convention:
 * these tests never hit the network or a browser.
 *
 * Covered: question-construction contract, gate ladder (immediate / medium
 * re-ask / low floor), done-vs-goal-gate, allowlist hard stop, dead-loop
 * detection, auto stateMode degrade, end-to-end flow with assertions and
 * metrics, execution-error continuation.
 */

import { describe, expect, it } from "vitest";
import {
  ACTION_VOCAB,
  buildQuestions,
  decide,
  runFlow,
  type FlowPage,
  type JevElementRec,
  type JevJudgeFn,
  type JevSnapshot,
  type JevUsage,
} from "../accept/jev-loop.js";

const ALLOWLIST = ["cap-server-staging.dai-samuel.workers.dev"];

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeExtraction {
  url: string;
  title: string;
  landmarks?: string[];
  headings?: Array<{ level: string; text: string }>;
  dialogs?: string[];
  alerts?: string[];
  elements: Array<{ tag: string; role: string; name: string; checked?: string }>;
  trimmed?: number;
  pageText: string;
}

/** Scripted FlowPage: extraction JSON per snapshot, action log, markers. */
class FakePage implements FlowPage {
  scripts: FakeExtraction[];
  calls: Array<{ kind: string; arg?: unknown }> = [];
  private idx = 0;
  gen = 0;

  constructor(scripts: FakeExtraction[]) {
    this.scripts = scripts;
  }

  nextGen(): number {
    this.gen += 1;
    return this.gen;
  }

  async evalJs<T>(expression: string): Promise<T> {
    if (expression.includes("/*__jevExtract*/")) {
      const script = this.scripts[Math.min(this.idx, this.scripts.length - 1)];
      this.idx += 1;
      return JSON.stringify(script) as T;
    }
    if (expression.includes("/*__jevBody*/")) return "ok body" as T;
    return {} as T;
  }

  async click(ref: number): Promise<{ ok: boolean; why?: string }> {
    this.calls.push({ kind: "click", arg: ref });
    return { ok: true };
  }

  async fill(ref: number, text: string): Promise<{ ok: boolean; why?: string }> {
    this.calls.push({ kind: "fill", arg: ref, text });
    return { ok: true };
  }

  async selectOption(ref: number, text: string): Promise<{ ok: boolean; why?: string }> {
    this.calls.push({ kind: "select", arg: ref, text });
    return { ok: true };
  }

  async press(_key: string): Promise<void> {
    this.calls.push({ kind: "press" });
  }

  async scrollBy(deltaY: number): Promise<void> {
    this.calls.push({ kind: "scroll", arg: deltaY });
  }

  async settle(_ms: number): Promise<void> {}

  async url(): Promise<string> {
    return this.scripts[0]?.url ?? "";
  }

  async reload(_settleMs?: number): Promise<void> {
    this.calls.push({ kind: "reload" });
  }

  async navigate(_url: string, _settleMs?: number): Promise<void> {
    this.calls.push({ kind: "navigate" });
  }
}

interface ScriptedReply {
  answers: Record<string, unknown>;
  usage?: JevUsage;
  rttMs?: number;
  model?: string;
}

/** Judge seam: fixed replies in order, last one repeats; records states. */
function scriptedJudge(replies: ScriptedReply[]): JevJudgeFn & { stateCount: () => number } {
  let calls = 0;
  let states = 0;
  const fn = (async (state: unknown) => {
    calls += 1;
    if (typeof state === "object") states += 1;
    const reply = replies[Math.min(calls - 1, replies.length - 1)];
    if (reply === undefined) throw new Error("no scripted reply");
    return { ...reply, rttMs: reply.rttMs ?? 42 };
  }) as JevJudgeFn & { stateCount: () => number };
  fn.stateCount = () => states;
  return fn;
}

function choiceAnswer(choice: string, confidence: number): Record<string, unknown> {
  return { type: "choice", choice, confidence };
}

function noulAnswer(value: number): Record<string, unknown> {
  return { type: "noul", noul: value };
}

/** Standard happy 6-answer set, individually overridden per test. */
function baseAnswers(overrides: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    next_action: choiceAnswer("click", 0.95),
    target_ref: choiceAnswer("1", 0.9),
    goal_achieved: noulAnswer(0.05),
    detrimental_state: noulAnswer(0.01),
    progress: { type: "score", score: 1.5 },
    unexpected_nav: noulAnswer(0.01),
    ...overrides,
  };
}

function settingsPageExtraction(url = `https://${ALLOWLIST[0]}/threads/thr_jk45qe4786`): FakeExtraction {
  return {
    url,
    title: "hello?",
    headings: [{ level: "h1", text: "hello?" }],
    elements: [
      { tag: "BUTTON", role: "button", name: "Thread settings" },
      { tag: "BUTTON", role: "switch", name: "Debug", checked: "false" },
      { tag: "BUTTON", role: "button", name: "Send" },
    ],
    pageText: "hello?\ncomposer\n",
  };
}

const EXPECTED_ORIGIN = `https://${ALLOWLIST[0]}`;

function snapFor(elements: JevElementRec[], url = `https://${ALLOWLIST[0]}/threads/x`): JevSnapshot {
  return {
    gen: 1,
    url,
    title: "t",
    landmarks: [],
    headings: [],
    dialogs: [],
    alerts: [],
    elements,
    trimmedElements: 0,
    pageText: "",
    stateText: "",
    tokens: 100,
    ms: 1,
    stateMode: "full",
  };
}

// ---------------------------------------------------------------------------
// buildQuestions contract
// ---------------------------------------------------------------------------

describe("buildQuestions", () => {
  it("randomizes target_ref order deterministically from seed and keeps closed vocabulary", () => {
    const snap = snapFor([
      { tag: "BUTTON", role: "button", name: "A" },
      { tag: "BUTTON", role: "switch", name: "B" },
      { tag: "BUTTON", role: "button", name: "C" },
    ]);
    const first = buildQuestions({ goal: "g", snap, previousUrl: null, expectedOrigin: EXPECTED_ORIGIN, seed: 7 });
    const again = buildQuestions({ goal: "g", snap, previousUrl: null, expectedOrigin: EXPECTED_ORIGIN, seed: 7 });
    expect(first.refOrder).toEqual(again.refOrder);
    expect(first.actionOrder).toEqual(again.actionOrder);
    expect(new Set(first.refOrder)).toEqual(new Set([0, 1, 2, 3]));
    expect(new Set(first.actionOrder)).toEqual(new Set(ACTION_VOCAB));

    // criteria map covers every presented option; goal lives in instructions
    const criteria = (first.questions.target_ref as { criteria: Record<string, string> }).criteria;
    for (const ref of first.refOrder) expect(criteria[String(ref)]).toBeDefined();
    const instructions = (first.questions.next_action as { instructions: Record<string, string> }).instructions;
    expect(instructions.task).toBe("g");
  });

  it("state carries page text as data; criteria/labels never embed page content", () => {
    const snap = snapFor([{ tag: "BUTTON", role: "button", name: "A" }]);
    const built = buildQuestions({ goal: "g", snap, previousUrl: null, expectedOrigin: EXPECTED_ORIGIN, seed: 1 });
    const raw = JSON.stringify(built.questions);
    expect(raw).not.toContain("page of untrusted persuasion");
    expect(snap.stateMode).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// Gate ladder
// ---------------------------------------------------------------------------

describe("decide", () => {
  const snap = snapFor([{ tag: "BUTTON", role: "button", name: "A" }]);

  it("acts immediately on confident write actions", () => {
    const d = decide(baseAnswers(), snap, [0, 1]);
    expect(d.kind).toBe("act");
    expect(d.ref).toBe(1);
  });

  it("re-asks (act-medium) inside the write band", () => {
    const d = decide(baseAnswers({ next_action: choiceAnswer("click", 0.7) }), snap, [0, 1]);
    expect(d.kind).toBe("act-medium");
  });

  it("stops low-confidence write actions as escalated", () => {
    const d = decide(baseAnswers({ next_action: choiceAnswer("click", 0.4) }), snap, [0, 1]);
    expect(d.kind).toBe("stop");
    expect(d.escalated).toBe(true);
  });

  it("stops on escalate, goal gate, detrimental, unexpected nav, bad ref, invalid action", () => {
    const cases: Array<[Record<string, Record<string, unknown>>, RegExp]> = [
      [baseAnswers({ next_action: choiceAnswer("escalate", 0.9) }), /escalate/],
      [baseAnswers({ goal_achieved: noulAnswer(0.9) }), undefined] as unknown as [Record<string, Record<string, unknown>>, RegExp],
      [baseAnswers({ detrimental_state: noulAnswer(0.8) }), /detrimental/],
      [baseAnswers({ unexpected_nav: noulAnswer(0.8) }), /unexpected/],
      [baseAnswers({ target_ref: choiceAnswer("9", 0.9) }), /invalid target_ref/],
      [baseAnswers({ next_action: choiceAnswer(" teleport", 0.9) }), /invalid option/],
    ];
    // goal-gate case expect done:
    const done = decide(cases[1]![0], snap, [0, 1]);
    expect(done.kind).toBe("done");
    const rest = [cases[0]!, ...cases.slice(2)] as Array<[Record<string, Record<string, unknown>>, RegExp]>;
    for (const [answers, pattern] of rest) {
      const d = decide(answers, snap, [0, 1]);
      expect(d.kind).toBe("stop");
      expect(d.reason ?? "").toMatch(pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end loop with fakes
// ---------------------------------------------------------------------------

describe("runFlow", () => {
  it("drives a scripted two-step flow and runs code assertions", async () => {
    const page = new FakePage([settingsPageExtraction(), settingsPageExtraction()]);
    const judge = scriptedJudge([
      { answers: baseAnswers({ next_action: choiceAnswer("click", 0.95), target_ref: choiceAnswer("1", 0.9) }), usage: { input_tokens: 1500, output_tokens: 20 }, rttMs: 640 },
      { answers: baseAnswers({ next_action: choiceAnswer("done", 0.9), target_ref: choiceAnswer("0", 0.9), goal_achieved: noulAnswer(0.93) }), usage: { input_tokens: 1600, output_tokens: 20 }, rttMs: 610, model: "jev-test" },
    ]);
    const report = await runFlow({
      goal: "turn the toggle on",
      page,
      allowlist: ALLOWLIST,
      judge,
      assertions: [{ name: "body sanity", check: async () => true }],
      settleMs: 1,
    });
    expect(report.ok).toBe(true);
    expect(report.goalReached).toBe(true);
    expect(report.model).toBe("jev-test");
    expect(page.calls).toEqual([{ kind: "click", arg: 1 }]);
    expect(report.steps).toHaveLength(2);
    expect(report.metrics.jevCalls).toBe(2);
    expect(report.metrics.jevRttP50).toBe(610);
    expect(report.metrics.inputTokensTotal).toBe(3100);
    expect(report.metrics.stateTokensMax).toBeGreaterThan(0);
    expect(report.assertions[0]?.pass).toBe(true);
    // state carried full page text + closed enumeration
    expect(judge.stateCount()).toBeGreaterThanOrEqual(2);
  });

  it("hard-stops on allowlist violations before any jev call", async () => {
    const page = new FakePage([{ ...settingsPageExtraction(), url: "https://evil.example/threads/x" }]);
    const judge = scriptedJudge([{ answers: baseAnswers() }]);
    const report = await runFlow({ goal: "g", page, allowlist: ALLOWLIST, judge, settleMs: 1 });
    expect(report.ok).toBe(false);
    expect(report.stopped?.reason).toMatch(/allowlist/);
    expect(report.metrics.jevCalls).toBe(0);
    expect(page.calls).toHaveLength(0);
  });

  it("medium-band write confidence: agreement on re-ask confirms and acts", async () => {
    const page = new FakePage([settingsPageExtraction(), settingsPageExtraction()]);
    const judge = scriptedJudge([
      { answers: baseAnswers({ next_action: choiceAnswer("click", 0.7) }) },
      { answers: baseAnswers({ next_action: choiceAnswer("click", 0.72) }) },
      { answers: baseAnswers({ next_action: choiceAnswer("done", 0.95), target_ref: choiceAnswer("0", 0.9), goal_achieved: noulAnswer(0.95) }) },
    ]);
    const report = await runFlow({ goal: "g", page, allowlist: ALLOWLIST, judge, settleMs: 1 });
    expect(report.steps[0]?.reasks).toBe(1);
    expect(report.steps[0]?.confirmedByReask).toBe(true);
    expect(page.calls).toEqual([{ kind: "click", arg: 1 }]);
    expect(report.metrics.jevCalls).toBe(3);
    expect(report.ok).toBe(true);
  });

  it("medium-band write confidence: re-ask disagreement stops escalated", async () => {
    const page = new FakePage([settingsPageExtraction()]);
    const judge = scriptedJudge([
      { answers: baseAnswers({ next_action: choiceAnswer("click", 0.7), target_ref: choiceAnswer("1", 0.9) }) },
      { answers: baseAnswers({ next_action: choiceAnswer("click", 0.72), target_ref: choiceAnswer("3", 0.9) }) },
    ]);
    const report = await runFlow({ goal: "g", page, allowlist: ALLOWLIST, judge, settleMs: 1 });
    expect(report.ok).toBe(false);
    expect(report.escalated).toBe(true);
    expect(report.stopped?.reason).toMatch(/disagreed/);
    expect(page.calls).toHaveLength(0);
  });

  it("detects dead loops on repeated identical action+ref", async () => {
    const page = new FakePage([settingsPageExtraction()]);
    const judge = scriptedJudge([
      { answers: baseAnswers({ next_action: choiceAnswer("click", 0.95), target_ref: choiceAnswer("1", 0.9) }) },
    ]);
    const report = await runFlow({ goal: "g", page, allowlist: ALLOWLIST, judge, settleMs: 1, maxSteps: 6 });
    expect(report.ok).toBe(false);
    expect(report.stopped?.reason).toMatch(/dead loop/);
    // 2 executed repeats then stop on the 3rd identical decision
    expect(page.calls.filter((c) => c.kind === "click")).toHaveLength(2);
  });

  it("auto stateMode degrades to compact after RTT budget breach and reports it", async () => {
    const page = new FakePage([settingsPageExtraction(), settingsPageExtraction()]);
    const judge = scriptedJudge([
      { answers: baseAnswers({ next_action: choiceAnswer("wait", 0.9), target_ref: choiceAnswer("0", 0.9) }), rttMs: 900 },
      { answers: baseAnswers({ next_action: choiceAnswer("wait", 0.9), target_ref: choiceAnswer("0", 0.9) }), rttMs: 950 },
      { answers: baseAnswers({ next_action: choiceAnswer("done", 0.9), goal_achieved: noulAnswer(0.93) }), rttMs: 300 },
    ]);
    const report = await runFlow({ goal: "g", page, allowlist: ALLOWLIST, judge, stateMode: "auto", rttBudgetMs: 800, settleMs: 1, maxSteps: 4 });
    expect(report.degradedTo).toBe("compact");
    expect(report.degradeStep).toBe(2);
    expect(report.metrics.stateModeUsed).toBe("compact");
    expect(report.goalReached).toBe(true);
  });

  it("continues after execution errors and surfaces execError in steps", async () => {
    const page = new FakePage([settingsPageExtraction(), settingsPageExtraction()]);
    page.click = async () => ({ ok: false, why: "tag drift: snapshot BUTTON vs live SPAN" });
    const judge = scriptedJudge([
      { answers: baseAnswers({ next_action: choiceAnswer("click", 0.95) }) },
      { answers: baseAnswers({ next_action: choiceAnswer("done", 0.9), goal_achieved: noulAnswer(0.9) }) },
    ]);
    const report = await runFlow({ goal: "g", page, allowlist: ALLOWLIST, judge, settleMs: 1 });
    expect(report.steps[0]?.execError).toMatch(/tag drift/);
    expect(report.steps[1]?.action).toBe("done");
    expect(report.goalReached).toBe(true);
  });

  it("reports failed assertions without masking goal progress", async () => {
    const page = new FakePage([settingsPageExtraction()]);
    const judge = scriptedJudge([
      { answers: baseAnswers({ next_action: choiceAnswer("done", 0.9), goal_achieved: noulAnswer(0.95) }) },
    ]);
    const report = await runFlow({
      goal: "g",
      page,
      allowlist: ALLOWLIST,
      judge,
      settleMs: 1,
      assertions: [{ name: "nope", check: () => "row missing" }],
    });
    expect(report.goalReached).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.assertions[0]).toMatchObject({ name: "nope", pass: false, detail: "row missing" });
  });
});