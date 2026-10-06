/**
 * #242 jev-locate unit tests — fully seam-injected (canned judge + faked
 * page, jev-loop.test.ts convention): no network, no browser.
 *
 * Covered: ground/inventory/converge question contracts, R5 injection
 * discipline (page text never enters questions), probability plumbing
 * (probabilities vs confidence fallback), dual-order stability, converge
 * single-fan-out (1 RTT), C→G disambiguation (2 RTT, page-wide refs),
 * deterministic region slicing + packet budget, LocateReport meta.
 */

import { describe, expect, it } from "vitest";
import {
  CLASS_VOCAB,
  INVENTORY_AMBIGUITY_EPSILON,
  PACKET_HEADER,
  RELEVANCE_SCALE,
  buildGroundQuestions,
  buildInventoryQuestions,
  buildPacket,
  buildRegions,
  converge,
  locate,
  type LocateComponent,
  type LocateRegion,
  type LocateReport,
} from "../accept/jev-locate.js";
import type { FlowPage, JevElementRec, JevJudgeFn, JevSnapshot } from "../accept/jev-loop.js";
import type { JudgeAnswer } from "../../pm-autopilot/src/core.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const PAGE_TEXT_CANARY = "ZZCANARY-page-body-ZZ never in questions";

const ELEMENTS: JevElementRec[] = [
  { tag: "BUTTON", role: "button", name: "Stop" },
  { tag: "TEXTAREA", role: "textbox", name: "Message" },
  { tag: "A", role: "link", name: "Settings" },
];

const FAKE_EXTRACTION = {
  url: "https://staging.example/threads/thr_x",
  title: "hello?",
  landmarks: ['main "chat"'],
  headings: [
    { level: "h2", text: "Conversation" },
    { level: "h2", text: "Configuration" },
  ],
  dialogs: ["Confirm send"],
  alerts: [],
  elements: ELEMENTS,
  trimmed: 0,
  pageText: `You are now on the staging thread page. ${PAGE_TEXT_CANARY} Conversation\nalice: hi\nbob: hello\nConfiguration\nmodel: jev-latest\nConfirm send\npanel`,
};

class FakePage implements FlowPage {
  calls: string[] = [];
  gen = 0;
  constructor(private extraction: object) {}
  nextGen(): number {
    this.gen += 1;
    return this.gen;
  }
  evalJs<T>(expression: string): Promise<T> {
    if (expression.includes("/*__jevExtract*/")) {
      return Promise.resolve(JSON.stringify(this.extraction) as T);
    }
    return Promise.resolve({} as T);
  }
  click(): Promise<{ ok: boolean }> {
    this.calls.push("click");
    return Promise.resolve({ ok: true });
  }
  fill(): Promise<{ ok: boolean }> {
    this.calls.push("fill");
    return Promise.resolve({ ok: true });
  }
  selectOption(): Promise<{ ok: boolean }> {
    this.calls.push("selectOption");
    return Promise.resolve({ ok: true });
  }
  press(): Promise<void> {
    this.calls.push("press");
    return Promise.resolve();
  }
  scrollBy(): Promise<void> {
    this.calls.push("scrollBy");
    return Promise.resolve();
  }
  settle(): Promise<void> {
    this.calls.push("settle");
    return Promise.resolve();
  }
  url(): Promise<string> {
    return Promise.resolve("https://staging.example/threads/thr_x");
  }
  reload(): Promise<void> {
    this.calls.push("reload");
    return Promise.resolve();
  }
  navigate(): Promise<void> {
    this.calls.push("navigate");
    return Promise.resolve();
  }
}

interface JudgeCall {
  state: unknown;
  questions: Record<string, unknown>;
}

/** Scripted judge: one answer factory per question id, per call index. */
class CannedJudge {
  calls: JudgeCall[] = [];
  private readonly factories: Map<string, (call: number) => JudgeAnswer | undefined>;
  constructor(factories: Record<string, (call: number) => JudgeAnswer | undefined>) {
    this.factories = new Map(Object.entries(factories));
  }
  judge: JevJudgeFn = (state, questions) => {
    const callIndex = this.calls.length;
    this.calls.push({ state, questions });
    const answers: Record<string, JudgeAnswer> = {};
    for (const id of Object.keys(questions)) {
      const factory = this.factories.get(id);
      const answer = factory?.(callIndex);
      if (answer !== undefined) answers[id] = answer;
    }
    return Promise.resolve({ answers, model: "jev-test", rttMs: 21 });
  };
  /** Concatenated wire shape of one call's questions (R5 assertions). */
  questionsJson(call: number): string {
    const q = this.calls[call]?.questions;
    return JSON.stringify(q ?? {});
  }
}

const choice = (
  ref: string,
  confidence?: number,
  probabilities?: Record<string, number>,
): JudgeAnswer => ({
  choice: ref,
  ...(confidence !== undefined ? { confidence } : {}),
  ...(probabilities !== undefined ? { probabilities } : {}),
});

/** jev score replies carry `score` (jev-loop's scoreValue reads it via `in`);
 *  pm-autopilot's JudgeAnswer predates that field, hence the named cast. */
const scoreAnswer = (score: number): JudgeAnswer => ({ score }) as JudgeAnswer;

/** Narrow surface guard for inspecting built question wire shapes in tests. */
interface QuestionView {
  instructions: Record<string, unknown>;
  criteria: unknown;
}
function questionView(questions: Record<string, unknown>, id: string): QuestionView {
  const value: unknown = questions[id];
  if (
    typeof value !== "object" ||
    value === null ||
    !("instructions" in value) ||
    !("criteria" in value)
  ) {
    throw new TypeError(`question ${id} missing instructions/criteria`);
  }
  const rawInstructions: unknown = value.instructions;
  if (typeof rawInstructions !== "object" || rawInstructions === null) {
    throw new TypeError(`question ${id} has non-object instructions`);
  }
  const view = value as QuestionView; // narrow-surface guard: the two fields are checked above
  return view;
}

function criteriaKeys(view: QuestionView): string[] {
  if (typeof view.criteria !== "object" || view.criteria === null) {
    throw new TypeError("criteria is not an object");
  }
  return Object.keys(view.criteria);
}

function defaultLocateInput(mode: "ground" | "inventory" | "converge", extra?: object) {
  return {
    http: "http://172.27.0.1:9222",
    tabName: "l242-locate",
    intent: "find the stop control",
    mode,
    seed: 42,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Question builders (pure)
// ---------------------------------------------------------------------------

describe("buildGroundQuestions", () => {
  it("offers every ref plus 0 in two independently shuffled orders", () => {
    const built = buildGroundQuestions({ intent: "stop", elements: ELEMENTS, seed: 7 });
    const o1 = criteriaKeys(questionView(built.questions, "target_o1"));
    const o2 = criteriaKeys(questionView(built.questions, "target_o2"));
    for (const order of [o1, o2]) {
      expect(order).toHaveLength(4);
      expect([...order].sort()).toEqual(["opt0", "opt1", "opt2", "opt3"]);
    }
    expect(built.order1).toEqual(o1);
    expect(built.order2).toEqual(o2);
    // opt-keys (not bare integers) are load-bearing: integer-like keys would
    // be numerically reordered by JS/JSON, destroying the shuffle (R4).
    expect(built.order1).not.toEqual(built.order2);
  });

  it("keeps criteria truncated to role/name descriptions; intent rides task", () => {
    const built = buildGroundQuestions({ intent: "stop", elements: ELEMENTS, seed: 7 });
    const wire = JSON.stringify(built.questions);
    expect(wire).toContain('"task":"stop"');
    expect(wire).toContain('button \\"Stop\\"');
    expect(wire).not.toContain(PAGE_TEXT_CANARY);
  });
});

describe("buildInventoryQuestions", () => {
  it("fans out one class + one relevance question per element", () => {
    const built = buildInventoryQuestions({
      intent: "stop",
      elements: ELEMENTS,
      withRelevance: true,
      seed: 7,
    });
    expect(Object.keys(built.questions).sort()).toEqual([
      "class_1",
      "class_2",
      "class_3",
      "rel_1",
      "rel_2",
      "rel_3",
    ]);
  });

  it("class options are the full fixed vocab (comparable n); only rel carries the intent", () => {
    const built = buildInventoryQuestions({
      intent: "stop",
      elements: ELEMENTS,
      withRelevance: true,
      seed: 7,
    });
    const classQ = questionView(built.questions, "class_1");
    expect(criteriaKeys(classQ).sort()).toEqual([...CLASS_VOCAB].sort());
    expect(classQ.instructions.task).toBeUndefined();
    const relQ = questionView(built.questions, "rel_1");
    expect(relQ.criteria).toEqual([...RELEVANCE_SCALE]);
    expect(relQ.instructions.task).toBe("stop");
    expect(JSON.stringify(built.questions)).not.toContain(PAGE_TEXT_CANARY);
  });
});

describe("buildRegions", () => {
  const snap = {
    headings: [
      { level: "h2", text: "Conversation" },
      { level: "h2", text: "Configuration" },
      { level: "h3", text: "Not In Page Text" },
    ],
    dialogs: ["Confirm send"],
    alerts: ["Boom"],
    pageText: `${"x".repeat(60)} Conversation\nalice: hi\nConfiguration\nmodel: x\nBoom alert`,
    landmarks: [],
    dialogsPlaceholder: undefined,
  } as unknown as JevSnapshot;

  it("slices deterministic heading sections and carries dialogs/alerts slice-less", () => {
    const regions = buildRegions(snap);
    const byId = new Map(regions.map((r) => [r.id, r]));
    // 60-char preamble ≥ MIN_REGION_CHARS(40) → a `pre` region exists.
    expect(byId.get("pre")?.text).toBe(`${"x".repeat(60)} `);
    const h0 = byId.get("h0");
    const h1 = byId.get("h1");
    const h0Text = h0?.text;
    expect(h0Text).toBe("Conversation\nalice: hi\n");
    expect(h1?.text).toBe("Configuration\nmodel: x\nBoom alert");
    expect(byId.get("h2")).toBeUndefined(); // heading not found in pageText → skipped
    const dlg = byId.get("dialog0");
    expect(dlg?.text).toBeUndefined();
    expect(dlg?.approxTokens).toBe(0);
    expect(byId.get("alert0")?.path).toContain("Boom");
    expect(h0?.approxTokens).toBe(Math.ceil((h0Text?.length ?? 0) / 3.8));
  });
});

// ---------------------------------------------------------------------------
// locate() — ground
// ---------------------------------------------------------------------------

describe("locate ground", () => {
  it("maps full probabilities to per-ref pRelevant and flags order stability", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = new CannedJudge({
      target_o1: () => choice("opt2", 0.9, { opt1: 0.2, opt2: 0.7, opt3: 0.1 }),
      target_o2: () => choice("opt2", 0.88),
    });
    const report = await locate({ page, judge: judge.judge }, defaultLocateInput("ground"));
    expect(judge.calls).toHaveLength(1);
    expect(report.meta.requests).toBe(1);
    expect(report.meta.questions).toBe(2);
    expect(report.meta.rttMs).toEqual([21]);
    expect(report.meta.gen).toBe(1);
    expect(report.meta.counts.elements).toBe(3);
    const byRef = new Map(report.components.map((c) => [c.ref, c]));
    expect(byRef.get(2)?.pRelevant).toBeCloseTo(0.7);
    expect(byRef.get(2)?.orderStable).toBe(true);
    expect(byRef.get(1)?.pRelevant).toBeCloseTo(0.2);
    expect(byRef.get(3)?.pRelevant).toBeCloseTo(0.1);
    // Sorted by pRelevant desc.
    expect(report.components.map((c) => c.ref)).toEqual([2, 1, 3]);
  });

  it("falls back to winner confidence when the reply carries no distribution", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = new CannedJudge({
      target_o1: () => choice("opt3", 0.82),
      target_o2: () => choice("opt3", 0.5),
    });
    const report = await locate({ page, judge: judge.judge }, defaultLocateInput("ground"));
    const byRef = new Map(report.components.map((c) => [c.ref, c]));
    expect(byRef.get(3)?.pRelevant).toBeCloseTo(0.82);
    expect(byRef.get(3)?.orderStable).toBe(true);
    expect(byRef.get(1)?.pRelevant).toBeUndefined();
    expect(byRef.get(2)?.pRelevant).toBeUndefined();
  });

  it("reports disagreement (orderStable unset) and the none-match winner", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = new CannedJudge({
      target_o1: () => choice("opt1", 0.4),
      target_o2: () => choice("opt2", 0.4),
    });
    const disagree = await locate({ page, judge: judge.judge }, defaultLocateInput("ground"));
    expect(disagree.components.some((c) => c.orderStable === true)).toBe(false);

    const zeroJudge = new CannedJudge({
      target_o1: () => choice("opt0", 0.9),
      target_o2: () => choice("opt0", 0.9),
    });
    const none = await locate({ page, judge: zeroJudge.judge }, defaultLocateInput("ground"));
    expect(none.meta.groundNoneMatch).toBe(true);
    expect(none.components.every((c) => c.pRelevant === undefined)).toBe(true);
  });

  it("rejects an empty intent", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = new CannedJudge({});
    await expect(
      locate({ page, judge: judge.judge }, defaultLocateInput("ground", { intent: "   " })),
    ).rejects.toThrow(/intent/);
  });
});

// ---------------------------------------------------------------------------
// locate() — inventory
// ---------------------------------------------------------------------------

function inventoryJudge(): CannedJudge {
  return new CannedJudge({
    class_1: () => ({ choice: "stop-button", confidence: 0.91 }),
    class_2: () => ({ choice: "composer", confidence: 0.55 }),
    class_3: () => ({ choice: "link", confidence: 0.99 }),
    rel_1: () => scoreAnswer(3),
    rel_2: () => scoreAnswer(1),
    rel_3: () => scoreAnswer(2),
  });
}

describe("locate inventory", () => {
  it("maps class confidence and normalized relevance; one request; sorted", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = inventoryJudge();
    const report = await locate({ page, judge: judge.judge }, defaultLocateInput("inventory"));
    expect(judge.calls).toHaveLength(1);
    expect(report.meta.requests).toBe(1);
    expect(report.meta.questions).toBe(6);
    const byRef = new Map(report.components.map((c) => [c.ref, c]));
    expect(byRef.get(1)?.class).toBe("stop-button");
    expect(byRef.get(1)?.pClass).toBeCloseTo(0.91);
    expect(byRef.get(1)?.pRelevant).toBeCloseTo(1);
    expect(byRef.get(2)?.pRelevant).toBeCloseTo(1 / 3);
    expect(byRef.get(3)?.pRelevant).toBeCloseTo(2 / 3);
    expect(report.components.map((c) => c.ref)).toEqual([1, 3, 2]);
    expect(report.packet).toBeUndefined();
  });

  it("stays single-request by default even with a tied top band", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = inventoryJudge();
    await locate({ page, judge: judge.judge }, defaultLocateInput("inventory", { seed: 42 }));
    expect(judge.calls).toHaveLength(1);
  });

  it("two-stage C→G: near-tied top band triggers one ground request over the shortlist", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = new CannedJudge({
      class_1: () => ({ choice: "stop-button", confidence: 0.8 }),
      class_2: () => ({ choice: "composer", confidence: 0.3 }),
      class_3: () => ({ choice: "not-interactive", confidence: 0.2 }),
      rel_1: () => scoreAnswer(3),
      rel_2: () => scoreAnswer(3), // tie within INVENTORY_AMBIGUITY_EPSILON
      rel_3: () => scoreAnswer(0),
      target_o1: (call) => (call === 1 ? choice("opt2", 0.86) : undefined),
      target_o2: (call) => (call === 1 ? choice("opt2", 0.7) : undefined),
    });
    const report = await locate(
      { page, judge: judge.judge },
      defaultLocateInput("inventory", { disambiguate: true }),
    );
    expect(judge.calls).toHaveLength(2);
    expect(report.meta.requests).toBe(2);
    expect(report.meta.rttMs).toHaveLength(2);
    // Shortlist criteria keys are page-wide refs, never renumbered.
    expect(criteriaKeys(questionView(judge.calls[1]?.questions ?? {}, "target_o1")).sort()).toEqual(
      ["opt0", "opt1", "opt2"],
    );
    const byRef = new Map(report.components.map((c) => [c.ref, c]));
    expect(byRef.get(2)?.pRelevant).toBeCloseTo(0.86);
    expect(byRef.get(2)?.orderStable).toBe(true);
  });

  it("does not disambiguate when the top band holds one clear candidate", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = inventoryJudge();
    const report = await locate(
      { page, judge: judge.judge },
      defaultLocateInput("inventory", { disambiguate: true }),
    );
    expect(judge.calls).toHaveLength(1);
    expect(report.meta.requests).toBe(1);
    expect(INVENTORY_AMBIGUITY_EPSILON).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// locate() — converge
// ---------------------------------------------------------------------------

function convergeJudge(): CannedJudge {
  return new CannedJudge({
    class_1: () => ({ choice: "stop-button", confidence: 0.9 }),
    class_2: () => ({ choice: "composer", confidence: 0.6 }),
    class_3: () => ({ choice: "link", confidence: 0.7 }),
    rel_1: () => scoreAnswer(3),
    rel_2: () => scoreAnswer(2),
    rel_3: () => scoreAnswer(0),
    r0_rel: () => ({ noul: 0.05 }),
    r0_anomaly: () => ({ noul: 0.02 }),
    r1_rel: () => ({ noul: 0.9 }),
    r1_anomaly: () => ({ noul: 0.1 }),
    r2_rel: () => ({ noul: 0.4 }),
    r2_anomaly: () => ({ noul: 0.03 }),
    r3_rel: () => ({ noul: 0.6 }),
    r3_anomaly: () => ({ noul: 0.8 }),
  });
}

describe("locate converge", () => {
  it("single fan-out for class+relevance+regions; report carries packet and regions", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = convergeJudge();
    const report = await locate({ page, judge: judge.judge }, defaultLocateInput("converge"));
    expect(judge.calls).toHaveLength(1); // C+X share ONE request
    expect(report.meta.requests).toBe(1);
    // 3 elements × 2 + 4 regions × 2 = 14 questions.
    expect(report.meta.questions).toBe(14);
    const ids = report.regions.map((r) => r.id);
    expect(ids).toContain("h0");
    expect(ids).toContain("dialog0");
    // Sorted by pRelevant desc: h0 (0.9) first.
    expect(report.regions[0]?.id).toBe("h0");
    expect(report.regions[0]?.pRelevant).toBeCloseTo(0.9);
    const dlg = report.regions.find((r) => r.id === "dialog0");
    expect(dlg?.text).toBeUndefined();
    expect(dlg?.pAnomaly).toBeCloseTo(0.8);
    expect(report.packet).toBeDefined();
    expect(report.packet).toContain(PACKET_HEADER.slice(0, 24));
    expect(report.packet).toContain('ref 1 button "Stop"');
  });

  it("converge() frozen lane entry point returns packet + meta", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = convergeJudge();
    const out = await converge(
      { page, judge: judge.judge },
      {
        http: "http://172.27.0.1:9222",
        tabName: "l242-locate",
        intent: "model config",
        tokenBudget: 4000,
        seed: 42,
      },
    );
    expect(out.packet).toContain("__JEV_PACKET_V1");
    expect(out.meta.questions).toBe(14);
  });

  it("packet components block follows relevance order, not enumeration order", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = new CannedJudge({
      class_1: () => ({ choice: "action-button", confidence: 0.9 }),
      class_2: () => ({ choice: "composer", confidence: 0.9 }),
      class_3: () => ({ choice: "send-button", confidence: 0.9 }),
      rel_1: () => scoreAnswer(0),
      rel_2: () => scoreAnswer(1),
      rel_3: () => scoreAnswer(3), // ref 3 is the clear top
      r0_rel: () => ({ noul: 0.1 }),
      r0_anomaly: () => ({ noul: 0.1 }),
      r1_rel: () => ({ noul: 0.1 }),
      r1_anomaly: () => ({ noul: 0.1 }),
      r2_rel: () => ({ noul: 0.1 }),
      r2_anomaly: () => ({ noul: 0.1 }),
      r3_rel: () => ({ noul: 0.1 }),
      r3_anomaly: () => ({ noul: 0.1 }),
    });
    const report = await locate({ page, judge: judge.judge }, defaultLocateInput("converge"));
    const packet = report.packet ?? "";
    const at = (ref: number): number => packet.indexOf(`ref ${String(ref)} `);
    expect(at(3)).toBeGreaterThan(-1);
    expect(at(2)).toBeGreaterThan(-1);
    expect(at(3)).toBeLessThan(at(2));
    expect(at(2)).toBeLessThan(at(1));
  });
});

// ---------------------------------------------------------------------------
// Packet budget (pure)
// ---------------------------------------------------------------------------

describe("buildPacket", () => {
  const snap = {
    gen: 3,
    url: "https://staging.example/threads/thr_x",
    title: "hello?",
    tokens: 1002,
    pageText: "irrelevant here",
  } as unknown as JevSnapshot;

  const components: LocateComponent[] = [
    { ref: 2, role: "textbox", name: "Message", pRelevant: 0.8, class: "composer" },
    { ref: 1, role: "button", name: "Stop", pRelevant: 0.95, class: "stop-button" },
    { ref: 3, role: "link", name: "Settings", pRelevant: undefined, class: "not-interactive" },
  ];

  const region = (id: string, pRelevant: number, text: string): LocateRegion => ({
    id,
    path: `p "${id}"`,
    text,
    pRelevant,
    approxTokens: Math.ceil(text.length / 3.8),
  });

  it("lists only actionable top components; fills regions in pRelevant order within budget", () => {
    const regions = [region("h1", 0.9, "y".repeat(400)), region("h0", 0.7, "z".repeat(200))];
    const packet = buildPacket({ snap, intent: "config", components, regions, tokenBudget: 400 });
    expect(packet).toContain(PACKET_HEADER);
    expect(packet).toContain('ref 1 button "Stop" pRel=0.95');
    expect(packet).not.toContain("ref 3"); // not-interactive without pRelevant dropped
    const h0At = packet.indexOf("region h0");
    const h1At = packet.indexOf("region h1");
    expect(h1At).toBeGreaterThan(-1);
    expect(h0At).toBeGreaterThan(-1);
    expect(h1At).toBeLessThan(h0At); // h1 (pRelevant 0.9) before h0 (0.7)
    // Budget respected (± rounding slack on the estimate).
    expect(packet.length / 3.8).toBeLessThan(400 * 1.15);
  });

  it("truncates the first non-fitting region deterministically and drops the rest", () => {
    const regions = [region("h0", 0.95, "a".repeat(4000)), region("h1", 0.5, "b".repeat(2000))];
    const p1 = buildPacket({ snap, intent: "i", components, regions, tokenBudget: 200 });
    const p2 = buildPacket({ snap, intent: "i", components, regions, tokenBudget: 200 });
    expect(p1).toBe(p2);
    expect(p1).toContain("…[region truncated at packet budget]");
    expect(p1).not.toContain("region h1");
    expect(p1.length / 3.8).toBeLessThan(200 * 1.2);
  });
});

// ---------------------------------------------------------------------------
// Injection discipline (R5) — page text never reaches any question payload
// ---------------------------------------------------------------------------

describe("R5 injection discipline", () => {
  it("no question payload across all three modes carries the page-text canary", async () => {
    const allAnswers = (): Record<string, (call: number) => JudgeAnswer | undefined> => ({
      target_o1: () => choice("opt1", 0.5),
      target_o2: () => choice("opt1", 0.5),
      class_1: () => ({ choice: "stop-button", confidence: 0.5 }),
      class_2: () => ({ choice: "composer", confidence: 0.5 }),
      class_3: () => ({ choice: "link", confidence: 0.5 }),
      rel_1: () => scoreAnswer(1),
      rel_2: () => scoreAnswer(1),
      rel_3: () => scoreAnswer(1),
      r0_rel: () => ({ noul: 0.1 }),
      r0_anomaly: () => ({ noul: 0.1 }),
      r1_rel: () => ({ noul: 0.1 }),
      r1_anomaly: () => ({ noul: 0.1 }),
      r2_rel: () => ({ noul: 0.1 }),
      r2_anomaly: () => ({ noul: 0.1 }),
      r3_rel: () => ({ noul: 0.1 }),
      r3_anomaly: () => ({ noul: 0.1 }),
    });
    const page = new FakePage(FAKE_EXTRACTION);
    for (const mode of ["ground", "inventory", "converge"] as const) {
      const judge = new CannedJudge(allAnswers());
      const extra = mode === "inventory" ? { disambiguate: true } : {};
      await locate({ page, judge: judge.judge }, defaultLocateInput(mode, extra));
      for (let i = 0; i < judge.calls.length; i += 1) {
        expect(judge.questionsJson(i), `mode=${mode} call=${i}`).not.toContain(PAGE_TEXT_CANARY);
        // The state, by contrast, MUST carry the page (full-observable discipline).
        expect(String(judge.calls[i]?.state)).toContain(PAGE_TEXT_CANARY);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Report shape sanity
// ---------------------------------------------------------------------------

describe("LocateReport meta", () => {
  it("carries gen/url/title/stateTokens/counts/model and sorted component order", async () => {
    const page = new FakePage(FAKE_EXTRACTION);
    const judge = inventoryJudge();
    const report: LocateReport = await locate(
      { page, judge: judge.judge },
      defaultLocateInput("inventory"),
    );
    expect(report.meta.url).toBe("https://staging.example/threads/thr_x");
    expect(report.meta.title).toBe("hello?");
    expect(report.meta.stateTokens).toBeGreaterThan(0);
    expect(report.meta.model).toBe("jev-test");
    expect(report.meta.stateMode).toBe("full");
    expect(report.meta.counts.trimmed).toBe(0);
    const rels = report.components.map((c) => c.pRelevant ?? -1);
    const sorted = [...rels].sort((a, b) => b - a);
    expect(rels).toEqual(sorted);
  });
});
