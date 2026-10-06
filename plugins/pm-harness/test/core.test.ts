import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _inject,
  apply,
  audit,
  classifyIntake,
  defaultJudge,
  dispatchable,
  dispatchPackets,
  dorChecklist,
  FILE_CONFIDENCE_FLOOR,
  FRONTIER_AGE_DAYS,
  file,
  gateOf,
  intake,
  INTAKE_QUESTIONS,
  activeLeases,
  acceptedNumbers,
  acceptanceFaceOf,
  acceptanceSectionOf,
  browserInvolved,
  closeout,
  closeoutGated,
  closeoutLedger,
  ledger,
  lease,
  migrateCloseoutLedger,
  release,
  lane,
  JEV_MODEL,
  JEV_URL,
  planCascade,
  planFile,
  planDiff,
  registerSpawn,
  resolveJeapiKey,
  slugify,
  snapshot,
  type CloseoutEvent,
  type JudgeAnswer,
  type JudgeReply,
  type LeaseEvent,
  type SpawnRequest,
  type Ticket,
} from "../src/core.js";
import {
  LABEL_IDS,
  MockBoard,
  PRIORITY_FIELD_ID,
  STATUS_FIELD_ID,
  type IssueRow,
} from "./fixtures/mock-board.js";
import {
  CORPUS_362,
  CORPUS_382,
  CORPUS_386,
  CORPUS_387,
  CORPUS_390,
  CORPUS_391,
} from "./fixtures/corpus-402.js";

/**
 * L1 suite for #131 pm-autopilot. Zero network: the GitHub transport is an
 * in-memory board executing the very mutations the autopilot issues (so the
 * guarded apply → per-batch re-verify loop runs end-to-end against evolving
 * state), and the jev judge is mocked at the FETCH level — the real
 * transport code (headers, request shape, answer parsing, gate) is what
 * runs; only the wire is canned. Live writes never happen here.
 *
 * node:fs is mocked wholesale: pm-autopilot touches the filesystem only to
 * read the gitignored .env.local for JEV_API_KEY and to append the #240 lease
 * ledger jsonl, and mocking it makes both deterministic (an in-memory file
 * map — no dependence on a developer machine's real filesystem).
 */

const fsProbe = vi.hoisted(() => ({
  envLocalBody: null as string | null,
  files: new Map<string, string>(),
}));

vi.mock("node:fs", () => ({
  readFileSync: (path: unknown): string => {
    if (fsProbe.envLocalBody !== null && typeof path === "string" && path.endsWith(".env.local")) {
      return fsProbe.envLocalBody;
    }
    const cached = fsProbe.files.get(String(path));
    if (cached !== undefined) return cached;
    throw new Error(`mock fs: ${String(path)} unavailable`);
  },
  appendFileSync: (path: unknown, data: string): void => {
    const key = String(path);
    fsProbe.files.set(key, (fsProbe.files.get(key) ?? "") + data);
  },
  writeFileSync: (path: unknown, data: string): void => {
    fsProbe.files.set(String(path), data);
  },
  existsSync: (path: unknown): boolean => fsProbe.files.has(String(path)),
}));

// ---------------------------------------------------------------------------
// jev fetch mock (fetch injection — the transport code under test is real)
// ---------------------------------------------------------------------------

interface JevCall {
  url: string;
  init: RequestInit;
  body: { state: unknown; model: unknown; questions: Record<string, unknown> };
}

function jevMock(
  reply: JudgeReply | ((body: JevCall["body"]) => JudgeReply),
  opts: { status?: number; text?: string; stripAnswers?: boolean } = {},
): { fn: typeof fetch; calls: JevCall[] } {
  const calls: JevCall[] = [];
  const fn: typeof fetch = (url, init) => {
    const raw = init?.body;
    const body = JSON.parse(typeof raw === "string" ? raw : "{}") as JevCall["body"];
    const href =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.href
          : url instanceof Request
            ? url.url
            : "unknown";
    calls.push({ url: href, init: init ?? {}, body });
    if (opts.status !== undefined) {
      return Promise.resolve(new Response(opts.text ?? "boom", { status: opts.status }));
    }
    const r = typeof reply === "function" ? reply(body) : reply;
    return Promise.resolve(
      new Response(JSON.stringify(opts.stripAnswers === true ? {} : r), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fn, calls };
}

function choiceAnswer(choice: string, confidence: number): JudgeAnswer {
  return { type: "choice", choice, confidence };
}

const ATOMIC_QUESTIONS = [
  "milestone",
  "block",
  "type",
  "priority",
  "dor_evidence",
  "needs_probe",
  "needs_human",
] as const;
const CHOICE_QUESTIONS = ["milestone", "block", "type", "priority", "dor_evidence"] as const;

const TICKET_BODY =
  "[infra] PM autopilot：eval 常驻自动驾驶——板面确定性核+judge intake+派发备包。 ships code.";

/** All-in-vocab reply builder; per-question confidence + noul overridable. */
function replyAll(
  confidence: number,
  over: Partial<Record<string, JudgeAnswer>> = {},
  model = "jev-1.13.0",
): JudgeReply {
  return {
    answers: {
      milestone: choiceAnswer("M1", confidence),
      block: choiceAnswer("block:agent-harness", confidence),
      type: choiceAnswer("type:implementation", confidence),
      priority: choiceAnswer("P1", confidence),
      dor_evidence: choiceAnswer("none", confidence),
      needs_probe: { type: "noul", noul: 1 - confidence },
      needs_human: { type: "noul", noul: 1 - confidence },
      ...over,
    },
    model,
  };
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

describe("pure core", () => {
  const base: Ticket = {
    number: 7,
    id: "I7",
    title: "t",
    body: "",
    state: "OPEN",
    milestone: "M1",
    labels: [],
    blockedBy: [],
    updatedAt: "2026-01-01T00:00:00Z",
    itemId: "PVTItem_1",
    status: "Todo",
    priority: null,
  };

  it("dispatchable: open + Todo + no open blockers + not ready-for-human", () => {
    const tickets: Ticket[] = [
      base,
      { ...base, number: 1, status: "Backlog" },
      { ...base, number: 2, blockedBy: [{ number: 7, state: "OPEN", title: "t" }] },
      { ...base, number: 3, blockedBy: [{ number: 7, state: "CLOSED", title: "t" }] },
      { ...base, number: 4, labels: ["ready-for-human"] },
      { ...base, number: 5, state: "CLOSED" },
      { ...base, number: 6, status: "Wait for user" },
    ];
    expect(dispatchable({ tickets }).map((t) => t.number)).toEqual([7, 3]);
  });

  it("planDiff: status change resolves ids; same value is a no-op", () => {
    const board = new MockBoard();
    board.addIssue({ number: 7, title: "t" });
    board.boardIssue(7, "Backlog", null);
    const res = planDiff([{ op: "setStatus", number: 7, value: "Todo" }], board.planInput());
    expect(res.errors).toEqual([]);
    expect(res.willChange).toHaveLength(1);
    expect(res.willChange[0]?.kind).toBe("change");
    expect(res.ops).toEqual([
      {
        kind: "setStatus",
        number: 7,
        itemId: "PVTItem_1",
        fieldId: STATUS_FIELD_ID,
        optionId: "opt_Todo",
        value: "Todo",
      },
    ]);
    const again = planDiff([{ op: "setStatus", number: 7, value: "Backlog" }], board.planInput());
    expect(again.ops).toEqual([]);
    // same-value intent lands in willChange with kind "no-op" (ops stay empty)
    expect(again.willChange).toHaveLength(1);
    expect(again.willChange[0]?.kind).toBe("no-op");
  });

  it("planDiff bans closed-derived statuses and unknown vocabulary", () => {
    const board = new MockBoard();
    board.addIssue({ number: 7, title: "t" });
    board.boardIssue(7, "Todo", null);
    const done = planDiff([{ op: "setStatus", number: 7, value: "Done" }], board.planInput());
    expect(done.errors[0]).toContain("close-event derived");
    expect(done.ops).toEqual([]);
    // runtime vocabulary gap (the live project's option ids resolve at
    // runtime — a missing option must error, not write)
    const unknown = planDiff([{ op: "setPriority", number: 7, value: "P2" }], {
      ...board.planInput(),
      priorityOptions: { P0: "opt_P0", P1: "opt_P1" },
    });
    expect(unknown.errors[0]).toContain("closed vocabulary");
  });

  it("planDiff: #181 closed-ticket convergence carve-out — Done/Canceled resolve, the rest still refused", () => {
    const board = new MockBoard();
    board.addIssue({ number: 7, title: "t", state: "CLOSED" });
    board.boardIssue(7, "Todo", null);
    const fix = planDiff([{ op: "setStatus", number: 7, value: "Done" }], board.planInput());
    expect(fix.errors).toEqual([]);
    expect(fix.ops).toEqual([
      {
        kind: "setStatus",
        number: 7,
        itemId: "PVTItem_1",
        fieldId: STATUS_FIELD_ID,
        optionId: "opt_Done",
        value: "Done",
      },
    ]);
    expect(fix.willChange[0]?.sideEffect).toContain("convergence");
    // non-convergence writes on closed tickets stay refused
    const stale = planDiff([{ op: "setStatus", number: 7, value: "Backlog" }], board.planInput());
    expect(stale.errors[0]).toContain("CLOSED");
    // open tickets still ban Done/Canceled as PM targets (event-derived)
    board.addIssue({ number: 8, title: "open" });
    board.boardIssue(8, "Todo", null);
    const open = planDiff([{ op: "setStatus", number: 8, value: "Done" }], board.planInput());
    expect(open.errors[0]).toContain("close-event derived");
  });

  it("planDiff: milestone set/clear/no-op/unknown; closed ticket rejected", () => {
    const board = new MockBoard();
    board.addIssue({ number: 7, title: "t", milestone: { title: "M1" } });
    board.boardIssue(7, "Todo", null);
    expect(
      planDiff([{ op: "setMilestone", number: 7, value: "M2" }], board.planInput()).ops,
    ).toEqual([
      { kind: "setMilestone", number: 7, issueNodeId: "I7", milestoneId: "M_m2", value: "M2" },
    ]);
    expect(
      planDiff([{ op: "setMilestone", number: 7, value: null }], board.planInput()).ops,
    ).toEqual([
      { kind: "setMilestone", number: 7, issueNodeId: "I7", milestoneId: null, value: null },
    ]);
    expect(
      planDiff([{ op: "setMilestone", number: 7, value: "M1" }], board.planInput()).ops,
    ).toEqual([]);
    expect(
      planDiff([{ op: "setMilestone", number: 7, value: "M9" }], board.planInput()).errors[0],
    ).toContain("closed vocabulary");
    board.addIssue({ number: 8, title: "old", state: "CLOSED" });
    expect(
      planDiff([{ op: "setStatus", number: 8, value: "Todo" }], board.planInput()).errors[0],
    ).toContain("CLOSED");
  });

  it("planDiff: edges — self/dup/missing rejected, ok path carries axis note", () => {
    const board = new MockBoard();
    board.addIssue({ number: 7, title: "t" });
    board.addIssue({ number: 8, title: "b" });
    board.boardIssue(7, "Todo", null);
    const input = board.planInput({ extraIssueIds: { 99: "I99" } });
    expect(planDiff([{ op: "addBlockedBy", number: 7, blocker: 7 }], input).errors[0]).toContain(
      "self-blocking",
    );
    // planDiff is stateless: edge-dedup detection happens on the NEXT
    // preflight pass, once the first edge landed on the board
    expect(planDiff([{ op: "addBlockedBy", number: 7, blocker: 8 }], input).ops).toHaveLength(1);
    const existing = board.issues.find((i) => i.number === 7);
    existing?.blockedBy.nodes.push({
      number: 8,
      state: "OPEN",
      title: "b",
    });
    const dup = planDiff([{ op: "addBlockedBy", number: 7, blocker: 8 }], input);
    expect(dup.ops).toEqual([]);
    expect(dup.noOps).toHaveLength(1);
    expect(planDiff([{ op: "addBlockedBy", number: 7, blocker: 42 }], input).errors[0]).toContain(
      "not found",
    );
    const ok = planDiff([{ op: "addBlockedBy", number: 7, blocker: 99 }], input);
    expect(ok.ops).toEqual([
      { kind: "addBlockedBy", number: 7, issueNodeId: "I7", blocker: 99, blockerNodeId: "I99" },
    ]);
    // at planDiff level the note rides the willChange entry; preflight()
    // lifts it into report.sideEffects
    expect(ok.willChange[0]?.sideEffect).toContain("axis");
  });

  it("planDiff: labels — unknown rejected, fresh subset written, rfh side effect", () => {
    const board = new MockBoard();
    board.addIssue({ number: 7, title: "t", labels: { nodes: [{ name: "type:implementation" }] } });
    board.boardIssue(7, "Todo", null);
    const input = board.planInput();
    expect(planDiff([{ op: "addLabels", number: 7, labels: ["nope"] }], input).errors[0]).toContain(
      "invariant 3",
    );
    expect(planDiff([{ op: "addLabels", number: 7, labels: [] }], input).noOps).toHaveLength(1);
    const dup = planDiff([{ op: "addLabels", number: 7, labels: ["type:implementation"] }], input);
    expect(dup.ops).toEqual([]);
    const ok = planDiff(
      [{ op: "addLabels", number: 7, labels: ["type:implementation", "block:agent-harness"] }],
      input,
    );
    expect(ok.ops).toEqual([
      {
        kind: "addLabels",
        number: 7,
        issueNodeId: "I7",
        labels: ["block:agent-harness"],
        labelIds: ["L_harness"],
      },
    ]);
    const rfh = planDiff([{ op: "addLabels", number: 7, labels: ["ready-for-human"] }], input);
    expect(rfh.sideEffects[0]?.note).toContain("ready-for-human");
  });

  it("planCascade: close unlocks, flips Backlog→Todo, reports dispatchable delta", () => {
    const seed: Ticket = {
      number: 0,
      id: "",
      title: "",
      body: "",
      state: "OPEN",
      milestone: null,
      labels: [],
      blockedBy: [],
      updatedAt: "2026-01-01T00:00:00Z",
      itemId: null,
      status: null,
      priority: null,
    };
    const tickets: Ticket[] = [
      { ...seed, number: 1, status: "Todo" },
      {
        ...seed,
        number: 2,
        status: "Backlog",
        blockedBy: [{ number: 1, state: "OPEN", title: "a" }],
      },
      { ...seed, number: 3, status: "Todo" },
      {
        ...seed,
        number: 4,
        status: "Backlog",
        blockedBy: [{ number: 5, state: "OPEN", title: "still-open" }],
      },
    ];
    const plan = planCascade({ tickets }, 1);
    expect(plan.unblocked).toEqual([2]);
    expect(plan.flips).toEqual([{ op: "setStatus", number: 2, value: "Todo" }]);
    expect(plan.dispatchableDelta).toEqual([2]);
  });

  it("slugify folds CJK/punct to dashes and falls back to the number", () => {
    expect(slugify("[infra] PM autopilot：eval 常驻自动驾驶", 131)).toMatch(
      /^infra-pm-autopilot-eval/,
    );
    expect(slugify("？？？", 9)).toBe("ticket-9");
  });

  it("dispatchPackets: branch/path/budget/context/command", () => {
    const t: Ticket = {
      number: 131,
      id: "I131",
      title: "[infra] PM autopilot：eval 常驻自动驾驶",
      body: "x\n- 预算：墙钟 ≤ 60min；零活写\n",
      state: "OPEN",
      milestone: "M1",
      labels: ["type:implementation"],
      blockedBy: [],
      updatedAt: "2026-01-01T00:00:00Z",
      itemId: null,
      status: "Todo",
      priority: "P1",
    };
    const [packet] = dispatchPackets([t]);
    expect(packet?.worktree.branch).toBe("lane/131-infra-pm-autopilot-eval");
    expect(packet?.worktree.path).toContain(
      "~/.herdr/worktrees/cloudflare-agent-project/lane-131-",
    );
    expect(packet?.budget.source).toBe("body");
    expect(packet?.context).toContain("# Goal");
    expect(packet?.context).toContain("墙钟 ≤ 60min");
    expect(packet?.worktree.command).toContain("herdr worktree create");
    expect(packet?.worktree.command).toContain("--branch lane/131-infra-pm-autopilot-eval");
    // A true negative: no budget keyword, no wall-clock figure anywhere.
    const [skeleton] = dispatchPackets([{ ...t, body: "nothing relevant on this line" }]);
    expect(skeleton?.budget.source).toBe("skeleton");
  });

  it("budgetOf survives consecutive calls (no stateful regex lastIndex)", () => {
    const a: Ticket = {
      number: 1,
      id: "I1",
      title: "a",
      body: "预算：墙钟 ≤ 10min",
      state: "OPEN",
      milestone: null,
      labels: [],
      blockedBy: [],
      updatedAt: "2026-01-01T00:00:00Z",
      itemId: null,
      status: null,
      priority: null,
    };
    const b: Ticket = {
      ...a,
      number: 2,
      id: "I2",
      title: "b",
      body: "later prose 预算：墙钟 ≤ 20min trailing",
    };
    const first = dispatchPackets([a]);
    const second = dispatchPackets([b]);
    expect(first[0]?.budget.source).toBe("body");
    expect(second[0]?.budget.source).toBe("body");
    expect(second[0]?.budget.line).toContain("20min");
  });
});

// ---------------------------------------------------------------------------
// AP.audit (#181): drift rules + apply-consumable mutations
// ---------------------------------------------------------------------------

describe("AP.audit drift rules (#181)", () => {
  const NOW = new Date("2026-10-04T00:00:00Z");
  const FRESH = "2026-10-03T00:00:00Z"; // 1d before NOW — never rule-4-aged
  const AGED = "2026-09-24T00:00:00Z"; // 10d before NOW — aged at 7d
  const mk = (over: Partial<Ticket> & Pick<Ticket, "number">): Ticket => ({
    id: `I${over.number}`,
    title: `t${over.number}`,
    body: "",
    state: "OPEN",
    milestone: "M1",
    labels: [],
    blockedBy: [],
    itemId: `PVTItem_${over.number}`,
    status: "Todo",
    priority: null,
    updatedAt: FRESH,
    ...over,
  });

  it("rule 1: CLOSED with a stale Status → convergence mutations (wontfix → Canceled)", () => {
    const rep = audit(
      {
        tickets: [
          mk({ number: 1, state: "CLOSED", status: "Todo" }),
          mk({ number: 2, state: "CLOSED", status: "Backlog" }),
          mk({ number: 3, state: "CLOSED", status: "Wait for user" }),
          mk({ number: 4, state: "CLOSED", status: "Todo", labels: ["wontfix"] }),
        ],
      },
      { now: NOW },
    );
    expect(rep.clean).toBe(false);
    expect(rep.drift.map((d) => [d.rule, d.number])).toEqual([
      ["staleClosedStatus", 1],
      ["staleClosedStatus", 2],
      ["staleClosedStatus", 3],
      ["staleClosedStatus", 4],
    ]);
    expect(rep.mutations).toEqual([
      { op: "setStatus", number: 1, value: "Done" },
      { op: "setStatus", number: 2, value: "Done" },
      { op: "setStatus", number: 3, value: "Done" },
      { op: "setStatus", number: 4, value: "Canceled" },
    ]);
  });

  it("rule 1 silent on converged closed tickets (Done / Canceled / null status)", () => {
    const rep = audit(
      {
        tickets: [
          mk({ number: 1, state: "CLOSED", status: "Done" }),
          mk({ number: 2, state: "CLOSED", status: "Canceled" }),
          mk({ number: 3, state: "CLOSED", status: null }),
        ],
      },
      { now: NOW },
    );
    expect(rep.drift).toEqual([]);
    expect(rep.mutations).toEqual([]);
    expect(rep.clean).toBe(true);
  });

  it("rule 2: CLOSED + In Progress is the lane-died drift, reported exactly once", () => {
    const rep = audit(
      { tickets: [mk({ number: 9, state: "CLOSED", status: "In Progress" })] },
      { now: NOW },
    );
    expect(rep.drift).toHaveLength(1);
    expect(rep.drift[0]?.rule).toBe("inProgressOnClosed");
    expect(rep.drift[0]?.detail).toContain("lane died");
    expect(rep.mutations).toEqual([{ op: "setStatus", number: 9, value: "Done" }]);
  });

  it("rule 3: active-lane ticket not In Progress flips; stale roster entries report without mutation", () => {
    const rep = audit(
      {
        tickets: [
          mk({ number: 10, status: "Todo" }), // live lane, flip lost → repair
          mk({ number: 11, status: "In Progress" }), // healthy → silent
          mk({ number: 12, state: "CLOSED", status: "Done" }), // converged → roster stale
          mk({ number: 13, state: "CLOSED", status: "Todo" }), // rule 1 owns the repair
        ],
      },
      { activeLanes: [10, 11, 12, 13, 99], now: NOW },
    );
    const rule3 = rep.drift.filter((f) => f.rule === "laneStatusMismatch");
    expect(rule3.map((f) => [f.number, f.title, f.mutation])).toEqual([
      [10, "t10", { op: "setStatus", number: 10, value: "In Progress" }],
      [12, "t12", null],
      [99, "(not on board)", null],
    ]);
    expect(rule3[0]?.detail).toContain("flip lost");
    expect(rule3[1]?.detail).toContain("stale roster");
    expect(rule3[2]?.detail).toContain("missing from the snapshot");
    // #13 appears exactly once, as the rule-1 convergence finding
    expect(rep.drift.filter((d) => d.number === 13)).toHaveLength(1);
    expect(rep.drift.find((d) => d.number === 13)?.rule).toBe("staleClosedStatus");
  });

  it("rule 4: dispatchable Todo aged past N days is a mutation-free reminder; the rest stay silent", () => {
    const rep = audit(
      {
        tickets: [
          mk({ number: 20, updatedAt: AGED }), // aged dispatchable → flagged
          mk({ number: 21, updatedAt: AGED, labels: ["ready-for-human"] }), // user queue
          mk({
            number: 22,
            updatedAt: AGED,
            blockedBy: [{ number: 5, state: "OPEN", title: "b" }],
          }), // blocked
          mk({ number: 23, updatedAt: AGED, status: "Backlog" }), // unscheduled
          mk({ number: 24 }), // fresh dispatchable
          mk({ number: 25, updatedAt: AGED, status: "In Progress" }), // aged but on a lane → dispatched
        ],
      },
      { activeLanes: [25], now: NOW },
    );
    expect(rep.drift).toHaveLength(1);
    expect(rep.drift[0]?.rule).toBe("frontierAging");
    expect(rep.drift[0]?.number).toBe(20);
    expect(rep.drift[0]?.detail).toContain(`10d > ${FRONTIER_AGE_DAYS}d`);
    expect(rep.drift[0]?.mutation).toBeNull();
    expect(rep.mutations).toEqual([]);
    // strict boundary: exactly N days is not overdue; a tighter threshold is
    const edge = audit(
      { tickets: [mk({ number: 26, updatedAt: "2026-09-27T00:00:00Z" })] },
      { now: NOW },
    );
    expect(edge.clean).toBe(true);
    const tighter = audit(
      { tickets: [mk({ number: 26, updatedAt: "2026-09-27T00:00:00Z" })] },
      { now: NOW, frontierAgeDays: 6 },
    );
    expect(tighter.drift.map((f) => f.rule)).toEqual(["frontierAging"]);
  });

  it("mutations are AP.apply-consumable: planDiff resolves every suggestion error-free", () => {
    const rep = audit(
      {
        tickets: [
          mk({ number: 30, state: "CLOSED", status: "Todo" }), // convergence → Done
          mk({
            number: 31,
            state: "CLOSED",
            status: "In Progress",
            labels: ["wontfix"],
          }), // convergence → Canceled
          mk({ number: 32, status: "Backlog" }), // active-lane flip
        ],
      },
      { activeLanes: [32], now: NOW },
    );
    const board = new MockBoard();
    board.addIssue({ number: 30, title: "t30", state: "CLOSED" });
    board.boardIssue(30, "Todo", null);
    board.addIssue({
      number: 31,
      title: "t31",
      state: "CLOSED",
      labels: { nodes: [{ name: "wontfix" }] },
    });
    board.boardIssue(31, "In Progress", null);
    board.addIssue({ number: 32, title: "t32" });
    board.boardIssue(32, "Backlog", null);
    const res = planDiff(rep.mutations, board.planInput());
    expect(res.errors).toEqual([]);
    expect(res.ops.map((o) => ("value" in o ? o.value : null))).toEqual([
      "Done",
      "Canceled",
      "In Progress",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AP.audit → AP.apply one-shot reconcile (#181 acceptance demo)
// ---------------------------------------------------------------------------

describe("audit → apply one-shot reconcile (#181)", () => {
  afterEach(() => {
    _inject(null);
  });

  it("confirm apply converges the drift; the re-audit reads clean", async () => {
    const board = new MockBoard();
    // rule 1: closed, boarded, Status stuck at Todo (sync write went missing)
    board.addIssue({ number: 40, title: "closed stale", state: "CLOSED" });
    board.boardIssue(40, "Todo", null);
    // rule 3: live lane whose In Progress flip never landed
    board.addIssue({ number: 41, title: "lane flip lost" });
    board.boardIssue(41, "Todo", null);
    _inject({ gql: board.gql });

    const rep = audit(await snapshot(), { activeLanes: [41] });
    expect(rep.drift.map((d) => d.rule)).toEqual(["staleClosedStatus", "laneStatusMismatch"]);

    const applied = await apply(rep.mutations, { confirm: true });
    expect(applied.ok).toBe(true);
    expect(applied.verified).toBe(true);

    const after = audit(await snapshot(), { activeLanes: [41] });
    expect(after.clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Snapshot (mocked transport)
// ---------------------------------------------------------------------------

describe("snapshot (mocked transport)", () => {
  afterEach(() => {
    _inject(null);
  });

  it("merges board items with open issues across pagination legs", async () => {
    const board = new MockBoard();
    const boarded = board.addIssue({ number: 7, title: "boarded" });
    const unboarded = board.addIssue({ number: 8, title: "unboarded" });
    board.boardIssue(7, "Todo", "P1");
    let call = 0;
    _inject({
      gql: (query) => {
        call += 1;
        if (call === 1 && query.includes("project: node")) {
          return Promise.resolve({
            project: {
              items: {
                pageInfo: { hasNextPage: true, endCursor: "cur1" },
                nodes: [
                  {
                    id: "PVTItem_1",
                    status: { name: "Todo" },
                    priority: { name: "P1" },
                    content: { __typename: "Issue", ...boarded },
                  },
                ],
              },
            },
            repository: {
              issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          });
        }
        return Promise.resolve({
          project: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
          repository: {
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [unboarded] },
          },
        });
      },
    });
    const snap = await snapshot();
    expect(call).toBe(2);
    expect(snap.truncated).toBe(false);
    expect(snap.tickets.map((t) => [t.number, t.status, t.priority])).toEqual([
      [7, "Todo", "P1"],
      [8, null, null],
    ]);
    expect(snap.tickets[0]?.itemId).toBe("PVTItem_1");
  });

  it("flags truncation when pagination never settles", async () => {
    _inject({
      gql: () =>
        Promise.resolve({
          project: { items: { pageInfo: { hasNextPage: true, endCursor: "x" }, nodes: [] } },
          repository: { issues: { pageInfo: { hasNextPage: true, endCursor: "y" }, nodes: [] } },
        }),
    });
    const snap = await snapshot();
    expect(snap.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Apply guard rails (mocked transport)
// ---------------------------------------------------------------------------

describe("apply guard rails (mocked transport)", () => {
  let board: MockBoard;
  beforeEach(() => {
    board = new MockBoard();
    board.addIssue({ number: 7, title: "t", bodyText: "body" });
    board.boardIssue(7, "Backlog", null);
    _inject({ gql: board.gql });
  });
  afterEach(() => {
    _inject(null);
  });

  it("default is dry-run: preflight diff printed, zero writes issued", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const rep = await apply([{ op: "setStatus", number: 7, value: "Todo" }]);
    logSpy.mockRestore();
    expect(rep.ok).toBe(true);
    expect(rep.dryRun).toBe(true);
    expect(rep.appliedBatches).toEqual([]);
    expect(board.mutations).toEqual([]);
  });

  it("confirm: board-add first, then field write, per-batch re-verify passes", async () => {
    const fresh = new MockBoard();
    fresh.addIssue({ number: 9, title: "fresh", bodyText: "" });
    _inject({ gql: fresh.gql });
    const rep = await apply(
      [
        { op: "setStatus", number: 9, value: "Todo" },
        { op: "addLabels", number: 9, labels: ["block:agent-harness"] },
      ],
      { confirm: true },
    );
    expect(rep.errors).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.verified).toBe(true);
    // batch 1 = board-add; batch 2 = same-ticket field write + labels grouped
    expect(rep.appliedBatches).toEqual([[9], [9, 9]]);
    const kinds = fresh.mutations.map(
      (m) =>
        /addProjectV2ItemById|updateProjectV2ItemFieldValue|addLabelsToLabelable/.exec(
          m.query,
        )?.[0],
    );
    expect(kinds).toEqual([
      "addProjectV2ItemById",
      "updateProjectV2ItemFieldValue",
      "addLabelsToLabelable",
    ]);
    expect(fresh.items[0]?.status).toBe("Todo");
    expect(fresh.issues[0]?.labels.nodes.map((l) => l.name)).toContain("block:agent-harness");
  });

  it("verify drift aborts: failing status write is caught by re-verify", async () => {
    board.failStatusWrites = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rep = await apply([{ op: "setStatus", number: 7, value: "Todo" }], { confirm: true });
    errSpy.mockRestore();
    expect(rep.ok).toBe(false);
    expect(rep.verified).toBe(false);
    expect(rep.verifyFailure?.detail).toContain("setStatus drift");
  });

  it("preflight errors withhold ALL writes even with confirm", async () => {
    const rep = await apply([{ op: "addLabels", number: 7, labels: ["nope"] }], { confirm: true });
    expect(rep.ok).toBe(false);
    expect(rep.errors[0]).toContain("invariant 3");
    expect(board.mutations).toEqual([]);
  });

  it("dry-run preflight surfaces side-effect notes (rfh → Wait for user)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const rep = await apply([{ op: "addLabels", number: 7, labels: ["ready-for-human"] }]);
    logSpy.mockRestore();
    expect(rep.preflight.sideEffects.some((s) => s.note.includes("Wait for user"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Intake via jev (fetch injection)
// ---------------------------------------------------------------------------

describe("intake via jev (fetch injection)", () => {
  beforeEach(() => {
    process.env.JEV_API_KEY = "test-key-000";
  });
  afterEach(() => {
    delete process.env.JEV_API_KEY;
    fsProbe.envLocalBody = null;
    _inject(null);
  });

  it("request shape: url/model/seven atomic questions/Bearer key/body carries no key", async () => {
    const { fn, calls } = jevMock(replyAll(0.9));
    _inject({
      fetch: fn,
      gql: () => Promise.reject(new Error("gql must not be called by intake")),
    });
    await intake(TICKET_BODY);
    expect(calls).toHaveLength(1);
    const call = calls.at(0);
    if (call === undefined) throw new Error("jev mock captured no call");
    expect(call.url).toBe(JEV_URL);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toMatchObject({
      authorization: "Bearer test-key-000",
      "content-type": "application/json",
    });
    expect(call.body.model).toBe(JEV_MODEL);
    expect(Object.keys(call.body.questions).sort()).toEqual([...ATOMIC_QUESTIONS].sort());
    for (const k of CHOICE_QUESTIONS) {
      expect(call.body.questions[k]).toMatchObject({ type: "choice" });
    }
    expect(call.body.questions.needs_probe).toMatchObject({ type: "noul" });
    expect(call.body.questions.needs_human).toMatchObject({ type: "noul" });
    expect(JSON.stringify(call.body)).not.toContain("test-key-000");
    expect(call.body.state).toContain("PM autopilot");
  });

  it("gate ≥0.8 auto-apply: values mapped, noul polarity + confidence", async () => {
    const { fn } = jevMock(replyAll(0.91, { needs_probe: { type: "noul", noul: 0.93 } }));
    _inject({ fetch: fn });
    const r = await intake(TICKET_BODY);
    expect(r.gate).toBe("auto-apply");
    expect(r.milestone).toBe("M1");
    expect(r.block).toBe("block:agent-harness");
    expect(r.type).toBe("type:implementation");
    expect(r.priority).toBe("P1");
    expect(r.dor_evidence).toBe("none");
    expect(r.needs_probe).toBe(true);
    expect(r.needs_human).toBe(false);
    expect(r.confidence.needs_probe).toBeCloseTo(0.93);
    expect(r.judgeModel).toBe("jev-1.13.0");
  });

  it("gate 0.5–0.8 → pm-review; <0.5 → needs-human (weakest link)", async () => {
    const mid = jevMock(replyAll(0.65));
    _inject({ fetch: mid.fn });
    expect((await intake(TICKET_BODY)).gate).toBe("pm-review");
    _inject(null);
    const low = jevMock(replyAll(0.32));
    _inject({ fetch: low.fn });
    const r = await intake(TICKET_BODY);
    expect(r.gate).toBe("needs-human");
    expect(r.needs_probe).toBe(true); // noul 1-0.32=0.68 → true
  });

  it("out-of-vocabulary choice → null field + gate dragged to needs-human", async () => {
    const { fn } = jevMock(replyAll(0.95, { block: choiceAnswer("block:nonexistent", 0.95) }));
    _inject({ fetch: fn });
    const r = await intake(TICKET_BODY);
    expect(r.block).toBeNull();
    expect(r.gate).toBe("needs-human");
  });

  it("missing answer → confidence 0 → needs-human", async () => {
    const { fn } = jevMock({
      answers: { milestone: choiceAnswer("M1", 0.9) },
      model: "jev-1.13.0",
    });
    _inject({ fetch: fn });
    const r = await intake(TICKET_BODY);
    expect(r.milestone).toBe("M1");
    expect(r.priority).toBeNull();
    expect(r.gate).toBe("needs-human");
  });

  it("transport failures surface: HTTP 500 and missing answers object", async () => {
    const bad = jevMock(replyAll(0.9), { status: 500, text: "boom" });
    _inject({ fetch: bad.fn });
    await expect(intake(TICKET_BODY)).rejects.toThrow("jev judge 500");
    _inject(null);
    const empty = jevMock(replyAll(0.9), { stripAnswers: true });
    _inject({ fetch: empty.fn });
    await expect(intake(TICKET_BODY)).rejects.toThrow("no answers");
  });

  it("defaultJudge without any key fails loudly (never silent-opens the wire)", async () => {
    delete process.env.JEV_API_KEY;
    fsProbe.envLocalBody = null;
    await expect(defaultJudge("s", {})).rejects.toThrow("no JEV_API_KEY");
  });

  it("resolveJeapiKey prefers process env, falls back to the gitignored .env.local", () => {
    process.env.JEV_API_KEY = "env-key";
    expect(resolveJeapiKey()).toBe("env-key");
    delete process.env.JEV_API_KEY;
    fsProbe.envLocalBody = "JEV_API_KEY=apikey_file_key\n";
    expect(resolveJeapiKey()).toBe("apikey_file_key");
  });
});

// ---------------------------------------------------------------------------
// classifyIntake / gateOf (pure)
// ---------------------------------------------------------------------------

describe("classifyIntake / gateOf (pure)", () => {
  it("gateOf thresholds: 0.8 auto / 0.5 pm-review / below needs-human", () => {
    expect(gateOf(0.8)).toBe("auto-apply");
    expect(gateOf(0.7999)).toBe("pm-review");
    expect(gateOf(0.5)).toBe("pm-review");
    expect(gateOf(0.4999)).toBe("needs-human");
  });

  it("noul polarity boundary 0.5 → true with confidence exactly 0.5", () => {
    const r = classifyIntake(replyAll(0.9, { needs_human: { type: "noul", noul: 0.5 } }));
    expect(r.needs_human).toBe(true);
    expect(r.confidence.needs_human).toBeCloseTo(0.5);
    expect(r.gate).toBe("pm-review"); // weakest link is the 0.5 noul
  });

  it("clamps out-of-range confidences into [0,1]", () => {
    const r = classifyIntake(replyAll(1.7, { needs_probe: { type: "noul", noul: -0.4 } }));
    expect(r.confidence.milestone).toBeLessThanOrEqual(1);
    expect(r.needs_probe).toBe(false); // -0.4 clamps to 0
    expect(r.confidence.needs_probe).toBeCloseTo(1);
  });

  it("question set is exactly the seven atomic ones with correct types", () => {
    expect(Object.keys(INTAKE_QUESTIONS).sort()).toEqual([...ATOMIC_QUESTIONS].sort());
    for (const k of CHOICE_QUESTIONS) {
      expect(INTAKE_QUESTIONS[k]).toMatchObject({ type: "choice" });
    }
    expect(INTAKE_QUESTIONS.needs_probe).toMatchObject({ type: "noul" });
    expect(INTAKE_QUESTIONS.needs_human).toMatchObject({ type: "noul" });
  });
});

// ---------------------------------------------------------------------------
// AP.file (#151): intake → create → closed-vocab labels → fields → edges → status
// ---------------------------------------------------------------------------

describe("planFile (pure)", () => {
  it("floor demotes sub-0.8 dims to pmReview; status follows the APPLIED plan", () => {
    const cls = classifyIntake(
      replyAll(0.95, {
        milestone: choiceAnswer("M2", 0.6), // demoted
        priority: choiceAnswer("P0", 0.7), // demoted
        needs_human: { type: "noul", noul: 0.85 }, // applied: true @0.85
      }),
    );
    const { plan, pmReview } = planFile({ blockedBy: [9, 9, 3] }, cls);
    expect(plan.labels).toEqual(["block:agent-harness", "type:implementation", "ready-for-human"]);
    expect(plan.milestone).toBeNull(); // demoted → nothing written
    expect(plan.priority).toBeNull();
    expect(plan.status).toBe("Wait for user"); // needs_human applied
    expect(plan.blockedBy).toEqual([3, 9]); // deduped + sorted
    expect(pmReview).toEqual([
      { dimension: "milestone", suggested: "M2", confidence: 0.6 },
      { dimension: "priority", suggested: "P0", confidence: 0.7 },
    ]);
  });

  it("floor constant matches the intake gate's auto-apply threshold", () => {
    expect(FILE_CONFIDENCE_FLOOR).toBe(0.8);
  });
});

describe("AP.file (mocked transport + judge)", () => {
  let board: MockBoard;
  let judgeCalls: { state: unknown; questions: Record<string, unknown> }[];

  beforeEach(() => {
    board = new MockBoard();
    judgeCalls = [];
  });
  afterEach(() => {
    _inject(null);
  });

  function injectJudge(reply: JudgeReply): void {
    _inject({
      gql: board.gql,
      judge: (state, questions) => {
        judgeCalls.push({ state, questions });
        return Promise.resolve(reply);
      },
    });
  }

  function filedIssue(): IssueRow | undefined {
    return board.issues.find((i) => i.number === Math.max(...board.issues.map((x) => x.number)));
  }

  it("dry-run default: complete preview (labels/milestone number/priority/status), zero writes", async () => {
    board.addIssue({ number: 7, title: "existing", bodyText: "" });
    injectJudge(replyAll(0.95));
    const rep = await file({ title: "[infra] new ticket", body: TICKET_BODY });
    expect(rep.ok).toBe(true);
    expect(rep.dryRun).toBe(true);
    expect(rep.created).toBeUndefined();
    expect(rep.plan).toEqual({
      labels: ["block:agent-harness", "type:implementation"],
      milestone: "M1",
      milestoneNumber: 1, // resolved from the mock's live milestone map
      priority: "P1",
      status: "Todo", // scheduled wave
      blockedBy: [],
    });
    expect(rep.pmReview).toEqual([]);
    expect(board.mutations).toEqual([]); // zero writes
    expect(board.issues).toHaveLength(1);
    expect(board.items).toHaveLength(0);
    // intake wiring: the judge saw the body once, with the seven questions
    expect(judgeCalls).toHaveLength(1);
    expect(String(judgeCalls[0]?.state)).toContain(TICKET_BODY);
    expect(Object.keys(judgeCalls[0]?.questions ?? {}).sort()).toEqual(
      [...ATOMIC_QUESTIONS].sort(),
    );
  });

  it("confirm: one-shot filing — issue created, fields/labels/edges complete, zero unregistered labels", async () => {
    board.addIssue({ number: 7, title: "blocker", state: "CLOSED", bodyText: "" });
    injectJudge(replyAll(0.95));
    const rep = await file(
      { title: "[infra] new ticket", body: TICKET_BODY, blockedBy: [7] },
      { confirm: true },
    );
    expect(rep.ok).toBe(true);
    expect(rep.dryRun).toBe(false);
    expect(rep.created?.number).toBe(8);
    expect(rep.created?.id).toBe("I8");

    const issue = filedIssue();
    expect(issue?.title).toBe("[infra] new ticket");
    expect(issue?.bodyText).toBe(TICKET_BODY);
    expect(issue?.milestone).toEqual({ title: "M1" });
    const labelNames = (issue?.labels.nodes ?? []).map((l) => l.name);
    expect(labelNames).toEqual(["block:agent-harness", "type:implementation"]);
    for (const l of labelNames) {
      expect(Object.keys(LABEL_IDS)).toContain(l); // zero unregistered labels
    }
    expect(issue?.blockedBy.nodes.map((b) => b.number)).toEqual([7]);

    const item = board.items.find((it) => it.issueNumber === 8);
    expect(item?.status).toBe("Todo");
    expect(item?.priority).toBe("P1");

    // write order: create → labels → board-add → fields → edge
    const kinds = board.mutations.map((m) => m.query);
    const indexOf = (needle: string): number => kinds.findIndex((q) => q.includes(needle));
    expect(indexOf("createIssue")).toBe(0);
    expect(indexOf("createIssue")).toBeLessThan(indexOf("addLabelsToLabelable"));
    expect(indexOf("addLabelsToLabelable")).toBeLessThan(indexOf("addProjectV2ItemById"));
    expect(indexOf("addProjectV2ItemById")).toBeLessThan(indexOf("updateProjectV2ItemFieldValue"));
    expect(indexOf("updateProjectV2ItemFieldValue")).toBeLessThan(indexOf("addBlockedBy"));

    // field writes carry runtime-resolved ids; creation carries the milestone
    // id and NO labels array (invariant 5: REST path is never used)
    const create = board.mutations.find((m) => m.query.includes("createIssue"));
    expect(create?.variables).toMatchObject({ repositoryId: "R_repo", milestoneId: "M_m1" });
    expect(create?.variables).not.toHaveProperty("labels");
    const fieldWrites = board.mutations.filter((m) =>
      m.query.includes("updateProjectV2ItemFieldValue"),
    );
    expect(fieldWrites.map((m) => m.variables.optionId)).toEqual(["opt_P1", "opt_Todo"]);
    expect(fieldWrites.map((m) => m.variables.fieldId)).toEqual([
      PRIORITY_FIELD_ID,
      STATUS_FIELD_ID,
    ]);
  });

  it("closed-vocabulary guard: unregistered label hard-fails with zero writes even on confirm", async () => {
    board.addIssue({ number: 7, title: "existing", bodyText: "" });
    // block:agent-content is in the intake vocabulary but NOT registered on
    // this mock repository — the exact invariant-5 revival trap
    injectJudge(replyAll(0.95, { block: choiceAnswer("block:agent-content", 0.95) }));
    const rep = await file(
      { title: "[infra] trap ticket", body: TICKET_BODY, blockedBy: [7] },
      { confirm: true },
    );
    expect(rep.ok).toBe(false);
    expect(rep.created).toBeUndefined();
    expect(board.mutations).toEqual([]); // creation itself never issued
    expect(board.issues).toHaveLength(1);
    expect(board.items).toHaveLength(0);
    expect(rep.errors.join(" ")).toContain("block:agent-content");
    expect(rep.errors.join(" ")).toContain("invariant 5");
  });

  it("confidence <0.8 dims demote to pmReview and are never applied", async () => {
    injectJudge(
      replyAll(0.95, {
        milestone: choiceAnswer("M2", 0.6),
        priority: choiceAnswer("P0", 0.7),
      }),
    );
    const rep = await file({ title: "demoted dims", body: TICKET_BODY }, { confirm: true });
    expect(rep.ok).toBe(true);
    expect(rep.pmReview).toEqual([
      { dimension: "milestone", suggested: "M2", confidence: 0.6 },
      { dimension: "priority", suggested: "P0", confidence: 0.7 },
    ]);
    const issue = filedIssue();
    expect(issue?.milestone).toBeNull(); // nothing written for demoted dims
    expect(board.items.find((it) => it.issueNumber === issue?.number)?.priority).toBeNull();
    expect(board.items.find((it) => it.issueNumber === issue?.number)?.status).toBe("Backlog");
    const create = board.mutations.find((m) => m.query.includes("createIssue"));
    expect(create?.variables.milestoneId).toBeNull();
  });

  it("confident needs_human → ready-for-human label + Wait for user", async () => {
    injectJudge(replyAll(0.95, { needs_human: { type: "noul", noul: 0.9 } }));
    const rep = await file({ title: "user queue", body: TICKET_BODY }, { confirm: true });
    expect(rep.ok).toBe(true);
    expect(rep.plan.status).toBe("Wait for user");
    const issue = filedIssue();
    expect((issue?.labels.nodes ?? []).map((l) => l.name)).toContain("ready-for-human");
    expect(board.items.find((it) => it.issueNumber === issue?.number)?.status).toBe(
      "Wait for user",
    );
  });

  it("milestone 'none' → unscheduled Backlog filing without a milestone write", async () => {
    injectJudge(replyAll(0.95, { milestone: choiceAnswer("none", 0.95) }));
    const rep = await file({ title: "unscheduled", body: TICKET_BODY }, { confirm: true });
    expect(rep.ok).toBe(true);
    expect(rep.plan.milestone).toBeNull();
    expect(rep.plan.milestoneNumber).toBeNull();
    expect(rep.plan.status).toBe("Backlog");
    const issue = filedIssue();
    expect(issue?.milestone).toBeNull();
  });

  it("milestone title → number map is resolved at runtime, never hardcoded", async () => {
    // non-ordinal layout: the mock reports M1 at number 3 — any hardcoded
    // title→number table (the M0=1..M1.5=7 incident) would fail here
    board.milestones = { M2: "M_m2", M0: "M_m0", M1: "M_m1" };
    injectJudge(replyAll(0.95));
    const rep = await file({ title: "wave filing", body: TICKET_BODY });
    expect(rep.plan.milestone).toBe("M1");
    expect(rep.plan.milestoneNumber).toBe(3);
    expect(rep.plan.status).toBe("Todo");
  });

  it("unknown blocker number fails preflight without creating anything", async () => {
    injectJudge(replyAll(0.95));
    const rep = await file(
      { title: "dangling edge", body: TICKET_BODY, blockedBy: [404] },
      { confirm: true },
    );
    expect(rep.ok).toBe(false);
    expect(rep.created).toBeUndefined();
    expect(board.mutations).toEqual([]);
    expect(rep.errors.join(" ")).toContain("#404");
  });

  // --- #151 fix: explicit spec fields are authoritative over the judge -----

  it("explicit labels are verbatim-authoritative; the label axis skips the judge", async () => {
    board.addIssue({ number: 7, title: "blocker", bodyText: "" });
    injectJudge(replyAll(0.95)); // judge WOULD derive block:agent-harness
    const rep = await file(
      {
        title: "explicit labels",
        body: TICKET_BODY,
        labels: ["type:implementation", "block:bb-ux"],
        blockedBy: [7],
      },
      { confirm: true },
    );
    expect(rep.ok).toBe(true);
    expect(rep.explicitDims).toContain("labels");
    expect(rep.plan.labels).toEqual(["type:implementation", "block:bb-ux"]);
    // only the audit pair + unpinned field dims were asked
    expect(Object.keys(judgeCalls[0]?.questions ?? {}).sort()).toEqual([
      "dor_evidence",
      "milestone",
      "needs_probe",
      "priority",
    ]);
    const issue = board.issues.find((i) => i.number === rep.created?.number);
    expect((issue?.labels.nodes ?? []).map((l) => l.name)).toEqual([
      "type:implementation",
      "block:bb-ux",
    ]);
  });

  it("explicit milestone is authoritative: the judge's answer never wins", async () => {
    injectJudge(replyAll(0.95, { milestone: choiceAnswer("M2", 0.95) }));
    const rep = await file(
      { title: "pinned milestone", body: TICKET_BODY, milestone: "M1" },
      { confirm: true },
    );
    expect(rep.ok).toBe(true);
    expect(rep.plan.milestone).toBe("M1");
    expect(rep.plan.milestoneNumber).toBe(1);
    expect(Object.keys(judgeCalls[0]?.questions ?? {})).not.toContain("milestone");
    const create = board.mutations.find((m) => m.query.includes("createIssue"));
    expect(create?.variables.milestoneId).toBe("M_m1");
  });

  it("explicit milestone absent from open milestones → exact-match error, ZERO writes (defect 2 repro)", async () => {
    injectJudge(replyAll(0.95));
    const rep = await file(
      { title: "dead-branch ticket", body: TICKET_BODY, milestone: "M1.5: 产品化收尾" },
      { confirm: true },
    );
    expect(rep.ok).toBe(false);
    expect(rep.created).toBeUndefined();
    expect(board.mutations).toEqual([]); // nothing created, nothing written
    expect(board.issues).toHaveLength(0);
    expect(rep.errors.join(" ")).toContain("M1.5: 产品化收尾");
    expect(rep.errors.join(" ")).toContain("exact title match");
  });

  it("explicit priority/needsHuman pin wins over sub-floor judge answers", async () => {
    injectJudge(
      replyAll(0.95, {
        priority: choiceAnswer("P2", 0.5),
        needs_human: { type: "noul", noul: 0.2 },
      }),
    );
    const rep = await file(
      { title: "pinned fields", body: TICKET_BODY, priority: "P0", needsHuman: true },
      { confirm: true },
    );
    expect(rep.ok).toBe(true);
    expect(rep.plan.priority).toBe("P0");
    expect(rep.plan.status).toBe("Wait for user");
    expect(rep.plan.labels).toContain("ready-for-human");
    // pinned dims are never demoted into pmReview despite the low judge scores
    expect(rep.pmReview).toEqual([]);
    const item = board.items.find((it) => it.issueNumber === rep.created?.number);
    expect(item?.priority).toBe("P0");
    expect(item?.status).toBe("Wait for user");
  });

  // --- #151 fix: all-or-nothing rollback after creation --------------------

  it("verify drift after creation rolls back: board item removed + issue closed, ok:false", async () => {
    board.failStatusWrites = true;
    injectJudge(replyAll(0.95));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const rep = await file({ title: "rollback me", body: TICKET_BODY }, { confirm: true });
    errSpy.mockRestore();
    logSpy.mockRestore();
    expect(rep.ok).toBe(false);
    expect(rep.created).toBeUndefined(); // caller never sees a fake success
    expect(rep.errors.join(" ")).toContain("status drift");
    expect(rep.rolledBack?.steps.join("; ")).toContain("board item");
    expect(rep.rolledBack?.steps.join("; ")).toContain("closed as not_planned");
    expect(rep.rolledBack?.failures).toEqual([]);
    const issue = board.issues.find((i) => i.number === rep.rolledBack?.number);
    expect(issue?.state).toBe("CLOSED");
    expect(board.items).toHaveLength(0);
  });

  it("a hard write throw (edge mutation) also rolls back with the cause reported", async () => {
    board.addIssue({ number: 7, title: "blocker", bodyText: "" });
    _inject({
      gql: (query, variables) =>
        query.includes("addBlockedBy")
          ? Promise.reject(new Error("edge boom"))
          : board.gql(query, variables),
      judge: () => Promise.resolve(replyAll(0.95)),
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const rep = await file(
      { title: "throw rollback", body: TICKET_BODY, blockedBy: [7] },
      { confirm: true },
    );
    errSpy.mockRestore();
    logSpy.mockRestore();
    expect(rep.ok).toBe(false);
    expect(rep.errors.join(" ")).toContain("edge boom");
    expect(rep.rolledBack?.number).toBe(8);
    expect(board.issues.find((i) => i.number === 8)?.state).toBe("CLOSED");
    expect(board.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AP.lane (#171): DoR preflight → worktree provision → isolated spawn packet
// ---------------------------------------------------------------------------

const FULL_DOR_BODY = [
  "## DoR",
  "- 三问：bb 有形状（reg 409 现行）、omp 无语义面、平台缝无证据",
  "- 验收：面板 badge 翻转可见",
  "- 锚点：bb src/routes/dispatch.ts:40；omp 未涉及",
  "- 预算：墙钟 ≤ 60min；资源上限 1 lane；交付即回",
  "- 参照往例：类比 #147 单票 ≈ 1h",
].join("\n");

const STRIPPED_DOR_BODY = FULL_DOR_BODY.split("\n")
  .filter((l) => !/锚点|往例/.test(l))
  .join("\n");

/** #199 acceptance fixture: #197's original body, VERBATIM (unmodified
 *  wording). The old word-form patterns rejected it (上游锚： has no 锚点;
 *  预算 ≤1.5h has no 预算：) while every item was really present. */
const TICKET_197_BODY = [
  "## What to build",
  "按 docs/design/streaming-contract.md D2/D3（**spec 为正本，先读**）：(1) agent-DO journal append 钩子（agent-do.ts:1099-1138 既有 pushToSubscribers tap）经 env.HUB 推式 RPC 到 NotificationHubDO（同 worker 导出，index.ts:36-44；AgentDoBindings 增 HUB? 可选，未绑定 no-op）；(2) hub 帧面增 delta payload 帧型（schema 按 spec 帧表）；(3) journal 词表增 turn.phase 五相行（stream_started/first_token/terminal/settled/host_lost，D3 语义）；(4) flush 旋钮用既有 deltaFlushMs=100/deltaFlushBytes=2048（config.ts:72-73），零新增缓冲。",
  "**协调约束：与 #193（host 广播同碰 hub notify）串行——本票先动 hub 帧面+#193 后接生产者，或 PM 裁分工**。**复用三问**：hub/帧 schema 全自有（bb 无此面），DO RPC=CF 原生，无外部库可搬；适配垫=零（同 worker 绑定）。上游锚：spec §D2-D4+研究 docs/research/stream-surface.md。预算 ≤1.5h。参照往例：T17 yield 事件族 ≈ 1h。",
  "",
  "## Acceptance",
  "- [ ] L2：journal append→hub 帧端到端断言（含 at-least-once/弃帧调和 D4 游标语义）",
  "- [ ] turn.phase 五相行 replay 一致性（fold 不变式：渲染文本≡fold(journal[≤cursor])）",
  "- [ ] staging 手验一帧真 delta 到达（curl WS 或测试桥）",
].join("\n");

function laneTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    number: 200,
    id: "I200",
    title: "feat: demo lane",
    body: FULL_DOR_BODY,
    state: "OPEN",
    milestone: "M1",
    labels: [],
    blockedBy: [],
    updatedAt: "2026-01-01T00:00:00Z",
    itemId: "PVTItem_9",
    status: "Todo",
    priority: "P1",
    ...over,
  };
}

/** omp eval-kernel global view (named per repo cast rule; typeof guards do
 *  the validation). Lane transport tests install/stub/delete `agent` here. */
const kernelScope = globalThis as { agent?: unknown };

/** Boarded fixture for confirm-path lane tests: the flip's guarded write
 *  needs the ticket on a live (mock) board. */
function laneBoard(...numbers: number[]): MockBoard {
  const board = new MockBoard();
  for (const n of numbers) {
    board.addIssue({
      number: n,
      title: n === 200 ? "feat: demo lane" : "feat: second lane",
      bodyText: FULL_DOR_BODY,
      milestone: { title: "M1" },
    });
    board.boardIssue(n, "Todo", "P1");
  }
  return board;
}

describe("dorChecklist (pure)", () => {
  it("three items in ticket order, all pass on a complete body; budget/precedent lines are no longer gate items (#224)", () => {
    const dor = dorChecklist(FULL_DOR_BODY);
    // #224: budget/precedent left the gate — a body may still carry the
    // lines (budget rides the packet as an info line) but they never
    // surface as checks; the exact key list below pins that.
    expect(dor.map((c) => c.key)).toEqual(["three-questions", "acceptance", "anchors"]);
    expect(dor.every((c) => c.ok)).toBe(true);
    expect(dor.find((c) => c.key === "three-questions")?.evidence).toContain("三问");
  });

  it("missing items report ok:false with null evidence", () => {
    const dor = dorChecklist(STRIPPED_DOR_BODY);
    expect(dor.filter((c) => !c.ok).map((c) => c.key)).toEqual(["anchors"]);
    expect(dor.find((c) => c.key === "anchors")?.evidence).toBeNull();
  });

  // #199: detection is semantic — real writing like "上游锚：spec §D2-D4"
  // counts as evidence though it lacks the old word form (锚点).
  it("semantic detection: 锚：/§ refs/file paths count", () => {
    const semantic = dorChecklist(
      "复用三问：零适配垫\n验收：端到端断言\n上游锚：spec §D2-D4+研究 stream-surface.md\n预算 ≤1.5h\n参照往例：#147 ≈ 1h",
    );
    expect(semantic.every((c) => c.ok)).toBe(true);
    const byPath = dorChecklist(
      "三问：a\n验收：b\n按 scripts/pm-autopilot.ts:583-594 修\n预算 40min\n往例：c",
    );
    expect(byPath.find((c) => c.key === "anchors")?.ok).toBe(true);
  });
});

describe("AP.lane (runGit seam — zero filesystem side effects)", () => {
  afterEach(() => {
    _inject(null);
    registerSpawn(null);
    delete kernelScope.agent;
  });

  // #199 calibration: 假的严谨约束等于真的破坏推进 — DoR gaps inform the
  // PM through the advisory table, they never refuse.
  it("DoR is advisory: missing items print as gaps but the gate dispatches anyway", async () => {
    const rep = await lane(laneTicket({ body: STRIPPED_DOR_BODY }));
    expect(rep.refused).toBe(false); // old gate refused here on ③
    expect(rep.ok).toBe(true);
    expect(rep.spawn).not.toBeNull();
    expect(rep.dor.filter((c) => !c.ok).map((c) => c.key)).toEqual(["anchors"]);
  });

  it("a fixture missing every DoR item still dispatches — only the board predicate refuses", async () => {
    const rep = await lane(laneTicket({ body: "随便写写：改点东西，缺上游依据，时限未写。" }));
    expect(rep.refused).toBe(false);
    expect(rep.dor.every((c) => !c.ok)).toBe(true); // advisory table fully red, gate still open
  });

  it("refuses tickets that fail the board predicate (the only refusal)", async () => {
    const backlog = await lane(laneTicket({ status: "Backlog" }), {}, { confirm: true });
    expect(backlog.refused).toBe(true);
    expect(backlog.refusalReasons[0]).toContain("board predicate");
    const closed = await lane(laneTicket({ state: "CLOSED" }), {}, { confirm: true });
    expect(closed.refused).toBe(true);
    expect(closed.worktreeCreated).toBe(false);
    const blocked = await lane(
      laneTicket({ blockedBy: [{ number: 9, state: "OPEN", title: "open blocker" }] }),
      {},
      { confirm: true },
    );
    expect(blocked.refused).toBe(true);
  });

  it("dry-run pass: full plan + isolated spawn packet, no worktree created", async () => {
    const rep = await lane(laneTicket());
    expect(rep.ok).toBe(true);
    expect(rep.refused).toBe(false);
    expect(rep.dryRun).toBe(true);
    expect(rep.worktreeCreated).toBe(false);
    expect(rep.dor.every((c) => c.ok)).toBe(true);
    expect(rep.spawn).toMatchObject({ agent: "task", isolated: true, context: null });
    // lane context reuses dispatchPackets: herdr-path worktree + branch discipline
    expect(rep.spawn?.task).toContain("# Worktree");
    expect(rep.spawn?.task).toContain("lane/200-feat-demo-lane");
    expect(rep.spawn?.task).toContain("Branch discipline");
    expect(rep.worktree.path).toContain(
      "~/.herdr/worktrees/cloudflare-agent-project/lane-200-feat-demo-lane",
    );
  });

  it("confirm: provisions the worktree through the git seam with herdr-path naming", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const gitCalls: { args: string[]; cwd: string }[] = [];
    _inject({
      gql: laneBoard(200).gql,
      runGit: (args, cwd) => {
        gitCalls.push({ args, cwd });
        return "";
      },
    });
    registerSpawn(() => "L200demo");
    const rep = await lane(
      laneTicket(),
      { agent: "task", context: "# Contract\nshared interfaces" },
      { confirm: true },
    );
    logSpy.mockRestore();
    expect(rep.ok).toBe(true);
    expect(rep.worktreeCreated).toBe(true);
    expect(rep.spawned).toBe(true);
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0]?.args).toEqual([
      "worktree",
      "add",
      expect.stringContaining(".herdr/worktrees/cloudflare-agent-project/lane-200-feat-demo-lane"),
      "-b",
      "lane/200-feat-demo-lane",
      "origin/main",
    ]);
    expect(rep.spawn).toMatchObject({
      agent: "task",
      isolated: true,
      context: "# Contract\nshared interfaces",
    });
  });

  it("confirm: git failure surfaces as an explicit error without a spawn lie", async () => {
    _inject({
      runGit: () => {
        throw new Error("fatal: a branch named 'lane/200-feat-demo-lane' already exists");
      },
    });
    const rep = await lane(laneTicket(), {}, { confirm: true });
    expect(rep.ok).toBe(false);
    expect(rep.worktreeCreated).toBe(false);
    expect(rep.errors[0]).toContain("git worktree add failed");
    expect(rep.errors[0]).toContain("already exists");
  });

  // #199: dual entry. A number self-resolves through the snapshot seam and
  // throws only when the number is not on the board.
  it("dual entry: a number resolves through the snapshot seam to the same packet as the Ticket", async () => {
    const board = new MockBoard();
    board.addIssue({
      number: 200,
      title: "feat: demo lane",
      bodyText: FULL_DOR_BODY,
      milestone: { title: "M1" },
    });
    board.boardIssue(200, "Todo", "P1");
    _inject({ gql: board.gql });
    const byNumber = await lane(200);
    const byTicket = await lane(laneTicket());
    expect(byNumber.number).toBe(200);
    expect(byNumber.refused).toBe(false);
    expect(byNumber.spawn?.task).toBe(byTicket.spawn?.task);
    expect(byNumber.worktree.branch).toBe(byTicket.worktree.branch);
  });

  it("dual entry: a number not on board throws — the only new throw", async () => {
    _inject({ gql: new MockBoard().gql });
    await expect(lane(999)).rejects.toThrow("not on board");
  });

  it("#197 original body (verbatim, unmodified) passes the gate with a fully green advisory table", async () => {
    const rep = await lane(laneTicket({ number: 197, id: "I197", body: TICKET_197_BODY }));
    expect(rep.refused).toBe(false);
    expect(rep.ok).toBe(true);
    expect(rep.dor.every((c) => c.ok)).toBe(true);
    // first match wins: line 2's spec file path is itself an anchor now
    expect(rep.dor.find((c) => c.key === "anchors")?.evidence).toContain(
      "docs/design/streaming-contract.md",
    );
  });
});

// ---------------------------------------------------------------------------
// AP.lane spawn transport (#206): default SpawnFn (globalThis.agent guard),
// registerSpawn slot, report fields, batch entry, pipeline-owned board flip
// ---------------------------------------------------------------------------

describe("AP.lane spawn transport (#206)", () => {
  beforeEach(() => {
    delete kernelScope.agent;
  });
  afterEach(() => {
    _inject(null);
    registerSpawn(null);
    delete kernelScope.agent;
  });

  it("confirm: spawns through the registered transport and reports handle + roster id", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const seen: SpawnRequest[] = [];
    const gitCalls: { args: string[] }[] = [];
    _inject({
      gql: laneBoard(200).gql,
      runGit: (args) => {
        gitCalls.push({ args });
        return "";
      },
    });
    registerSpawn((p) => {
      seen.push(p);
      return "L200demo";
    });
    const rep = await lane(
      laneTicket(),
      { agent: "task", context: "# Contract\nshared interfaces" },
      { confirm: true },
    );
    logSpy.mockRestore();
    expect(rep.ok).toBe(true);
    expect(rep.spawned).toBe(true);
    expect(rep.transport).toBe("registered");
    expect(rep.agentHandle).toBe("L200demo");
    expect(rep.agentId).toBe("L200demo");
    expect(rep.spawnError).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.label).toBe("lane-200-feat-demo-lane");
    expect(seen[0]?.agent).toBe("task");
    expect(seen[0]?.context).toBe("# Contract\nshared interfaces");
    expect(seen[0]?.prompt).toBe(rep.spawn?.task); // the full packet context IS the lane task
    expect(gitCalls).toHaveLength(1); // worktree provisioning still happens
  });

  it("confirm owns the board flip: Status → In Progress through the guarded write, after the spawn", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const board = laneBoard(200);
    _inject({ gql: board.gql, runGit: () => "" });
    registerSpawn(() => "L200flip");
    const rep = await lane(200, {}, { confirm: true });
    logSpy.mockRestore();
    expect(rep.spawned).toBe(true);
    expect(rep.statusFlipped).toBe(true);
    expect(rep.statusError).toBeNull();
    expect(board.items.find((i) => i.issueNumber === 200)?.status).toBe("In Progress");
    // the flip rode the guarded write path (mutation + per-batch re-verify)
    expect(board.mutations.some((m) => m.query.includes("updateProjectV2ItemFieldValue"))).toBe(
      true,
    );
  });

  it("confirm without any transport reports transport-missing — worktree provisioned, no spawn lie, no flip", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const board = laneBoard(200);
    _inject({ gql: board.gql, runGit: () => "" });
    const rep = await lane(laneTicket(), {}, { confirm: true });
    logSpy.mockRestore();
    expect(rep.worktreeCreated).toBe(true);
    expect(rep.spawned).toBe(false);
    expect(rep.transport).toBe("missing");
    expect(rep.spawnError).toContain("globalThis.agent");
    expect(rep.ok).toBe(false);
    expect(rep.statusFlipped).toBe(false);
    // board untouched: no spawn → no flip (the board must reflect reality)
    expect(board.items.find((i) => i.issueNumber === 200)?.status).toBe("Todo");
  });

  it("default transport wraps globalThis.agent(prompt, {isolated: true, label}) — the #200 kernel recipe", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls: { prompt: string; opts: { isolated: boolean; label: string } }[] = [];
    kernelScope.agent = (prompt: string, opts: { isolated: boolean; label: string }) => {
      calls.push({ prompt, opts });
      return { id: "L200ctx" }; // omp kernel returns a handle object
    };
    _inject({ gql: laneBoard(200).gql, runGit: () => "" });
    const rep = await lane(laneTicket(), {}, { confirm: true });
    logSpy.mockRestore();
    expect(rep.spawned).toBe(true);
    expect(rep.transport).toBe("default");
    expect(rep.agentId).toBe("L200ctx"); // {id} handles unwrap
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts).toEqual({ isolated: true, label: "lane-200-feat-demo-lane" });
    expect(calls[0]?.prompt).toContain("# Worktree");
    expect(rep.statusFlipped).toBe(true);
  });

  it("registerSpawn(null) restores the default path — the slot is an override, not a trap", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSpawn(() => "mock");
    registerSpawn(null);
    _inject({ gql: laneBoard(200).gql, runGit: () => "" });
    const rep = await lane(laneTicket(), {}, { confirm: true });
    logSpy.mockRestore();
    // no kernel agent global → the restored default reports missing,
    // proving the override is really gone
    expect(rep.transport).toBe("missing");
    expect(rep.spawned).toBe(false);
  });

  it("a transport throw marks the report incomplete without a spawn lie", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    _inject({ gql: laneBoard(200).gql, runGit: () => "" });
    registerSpawn(() => {
      throw new Error("kernel refused spawn");
    });
    const rep = await lane(laneTicket(), {}, { confirm: true });
    logSpy.mockRestore();
    expect(rep.transport).toBe("registered");
    expect(rep.spawned).toBe(false);
    expect(rep.spawnError).toBe("kernel refused spawn");
    expect(rep.ok).toBe(false);
    expect(rep.statusFlipped).toBe(false);
  });

  it("batch entry: an array dispatches one wave and resolves one report per ticket, input order", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const gitArgs: string[][] = [];
    _inject({
      gql: laneBoard(200, 201).gql,
      runGit: (args) => {
        gitArgs.push(args);
        return "";
      },
    });
    registerSpawn((p) => `spawn:${p.label}`);
    const reps = await lane(
      [laneTicket(), laneTicket({ number: 201, id: "I201", title: "feat: second lane" })],
      {},
      { confirm: true },
    );
    logSpy.mockRestore();
    expect(reps).toHaveLength(2);
    expect(reps.map((r) => r.number)).toEqual([200, 201]);
    expect(reps.map((r) => r.agentId)).toEqual([
      "spawn:lane-200-feat-demo-lane",
      "spawn:lane-201-feat-second-lane",
    ]);
    expect(reps.every((r) => r.worktreeCreated)).toBe(true);
    expect(reps.every((r) => r.statusFlipped)).toBe(true);
    expect(gitArgs).toHaveLength(2); // one worktree add per ticket
  });

  it("batch dry-run plans every ticket and touches nothing; dry-run/refused reports carry null transport fields", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reps = await lane([laneTicket(), laneTicket({ number: 201, id: "I201" })]);
    const refused = await lane(laneTicket({ status: "Backlog" }), {}, { confirm: true });
    logSpy.mockRestore();
    expect(reps).toHaveLength(2);
    for (const r of [...reps, refused]) {
      expect(r.spawned).toBe(false);
      expect(r.transport).toBeNull();
      expect(r.agentHandle).toBeNull();
      expect(r.agentId).toBeNull();
      expect(r.spawnError).toBeNull();
      expect(r.statusFlipped).toBe(false);
    }
    expect(reps.every((r) => r.dryRun)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Browser lease ledger (#240) — shared CDP/thread resources under a written
// ledger; AP.lane auto-carries it; AP.audit rule 6 reads it.
// ---------------------------------------------------------------------------

const LEASE_PATH = "test-leases.jsonl";

const leaseAcquire = (
  over: Partial<LeaseEvent> & Pick<LeaseEvent, "lane" | "tabName" | "threadPrefix">,
): LeaseEvent => ({
  event: "acquired",
  type: "browser",
  number: null,
  acquiredAt: "2026-10-03T00:00:00Z",
  releasedAt: null,
  ...over,
});

describe("browser lease ledger (#240)", () => {
  const NOW = new Date("2026-10-05T06:00:00Z");
  const l238 = {
    lane: "lane-238-working",
    tabName: "l238-working",
    threadPrefix: "l238-",
    number: 238,
  };
  const l239 = {
    lane: "lane-239-accept",
    tabName: "l239-accept",
    threadPrefix: "l239-",
    number: 239,
  };

  beforeEach(() => {
    fsProbe.files.clear();
  });

  it("browserInvolved reads the same words the discipline names, title or body", () => {
    for (const text of ["浏览器验收", "browser UX", "CDP 截图", "Chrome tab 管理"]) {
      expect(browserInvolved({ title: text, body: "" })).toBe(true);
    }
    expect(browserInvolved({ title: "t", body: "上游锚：bb §2.1\n验收：端到端" })).toBe(false);
  });

  it("lease registers an acquisition; ledger replays the active set", () => {
    const rec = lease("browser", l238, { path: LEASE_PATH, now: NOW });
    expect(rec).toMatchObject({
      event: "acquired",
      type: "browser",
      lane: "lane-238-working",
      tabName: "l238-working",
      threadPrefix: "l238-",
      number: 238,
      releasedAt: null,
    });
    const view = ledger({ path: LEASE_PATH });
    expect(view.events).toHaveLength(1);
    expect(view.active.map((a) => a.tabName)).toEqual(["l238-working"]);
  });

  it("collisions refuse with zero writes: same tab, same thread prefix, same lane re-acquire, blank fields", () => {
    lease("browser", l238, { path: LEASE_PATH });
    expect(() =>
      lease(
        "browser",
        { lane: "lane-239-accept", tabName: "l238-working", threadPrefix: "l239-" },
        { path: LEASE_PATH },
      ),
    ).toThrow(/collision/); // tab clash
    expect(() =>
      lease(
        "browser",
        { lane: "lane-239-accept", tabName: "l239-accept", threadPrefix: "l238-" },
        { path: LEASE_PATH },
      ),
    ).toThrow(/collision/); // thread-prefix clash
    expect(() => lease("browser", l238, { path: LEASE_PATH })).toThrow(/already holds/);
    expect(() =>
      lease("browser", { lane: "lane-x", tabName: "  ", threadPrefix: "x-" }, { path: LEASE_PATH }),
    ).toThrow(/required/);
    expect(ledger({ path: LEASE_PATH }).active).toHaveLength(1);
    expect(ledger({ path: LEASE_PATH }).events).toHaveLength(1);
  });

  it("release closes the lease and the jsonl keeps both events; releasing nothing throws", () => {
    lease("browser", l239, { path: LEASE_PATH, now: NOW });
    const closed = release(
      "browser",
      { lane: "lane-239-accept" },
      {
        path: LEASE_PATH,
        now: new Date(NOW.getTime() + 1_000),
      },
    );
    expect(closed.event).toBe("released");
    expect(closed.releasedAt).not.toBeNull();
    expect(closed.acquiredAt).toBe(NOW.toISOString()); // echoes the acquisition
    expect(ledger({ path: LEASE_PATH })).toMatchObject({ active: [] });
    expect(ledger({ path: LEASE_PATH }).events).toHaveLength(2);
    expect(() => release("browser", { lane: "lane-239-accept" }, { path: LEASE_PATH })).toThrow(
      /nothing to release/,
    );
  });

  it("acceptance demo: two concurrent browser lanes hold distinct leases with zero collisions", () => {
    lease("browser", l238, { path: LEASE_PATH, now: NOW });
    lease("browser", l239, { path: LEASE_PATH, now: new Date(NOW.getTime() + 500) });
    const active = ledger({ path: LEASE_PATH }).active;
    expect(active.map((a) => [a.lane, a.tabName, a.threadPrefix])).toEqual([
      ["lane-238-working", "l238-working", "l238-"],
      ["lane-239-accept", "l239-accept", "l239-"],
    ]);
    const tabs = new Set(active.map((a) => a.tabName));
    const prefixes = new Set(active.map((a) => a.threadPrefix));
    expect(tabs.size).toBe(active.length);
    expect(prefixes.size).toBe(active.length);
    // sequential reuse: release then re-acquire the same names is legal
    release("browser", { lane: "lane-238-working" }, { path: LEASE_PATH });
    expect(() => lease("browser", l238, { path: LEASE_PATH })).not.toThrow();
  });

  it("PM_LEASES_PATH redirects the default store; a missing file reads as an empty ledger", () => {
    process.env.PM_LEASES_PATH = "env-leases.jsonl";
    lease("browser", l238);
    expect(ledger().active).toHaveLength(1);
    expect(ledger({ path: LEASE_PATH }).events).toHaveLength(0);
  });

  it("activeLeases replays acquire/release pairs; a corrupt jsonl line names the file and line", () => {
    expect(activeLeases([leaseAcquire(l238), leaseAcquire(l239)])).toHaveLength(2);
    expect(
      activeLeases([
        leaseAcquire(l238),
        { ...leaseAcquire(l238), event: "released", releasedAt: "x" },
      ]),
    ).toHaveLength(0);
    fsProbe.files.set(LEASE_PATH, `${JSON.stringify(leaseAcquire(l238))}\nnot-json\n`);
    expect(() => ledger({ path: LEASE_PATH })).toThrow(/corrupt jsonl .*test-leases\.jsonl:2/);
  });
});

describe("AP.lane browser lease auto-carry (#240)", () => {
  const browserTicket = (over: Partial<Ticket> = {}): Ticket =>
    laneTicket({
      number: 240,
      id: "I240",
      title: "[track:pm] 浏览器 CDP 验收",
      ...over,
    });

  beforeEach(() => {
    fsProbe.files.clear();
    delete kernelScope.agent;
  });
  afterEach(() => {
    _inject(null);
    registerSpawn(null);
    delete kernelScope.agent;
  });

  it("dry-run: browser ticket plans a lease and carries the lease section; nothing registered", async () => {
    const rep = await lane(browserTicket());
    expect(rep.lease).toMatchObject({
      browserInvolved: true,
      tabName: "l240",
      threadPrefix: "l240-",
      registered: false,
    });
    expect(rep.lease?.lane).toBe(rep.worktree.branch.replaceAll("/", "-"));
    expect(rep.spawn?.task).toContain("# Browser lease");
    expect(rep.spawn?.task).toContain("tab: l240（具名 tab；禁默认 tab、禁他人 tab）");
    expect(rep.spawn?.task).toContain("staging thread=抢占资源");
    expect(rep.spawn?.task).toContain('AP.release("browser"');
    expect(ledger().active).toHaveLength(0); // dry-run writes nothing
  });

  it("agentSpec.lease overrides the derived tab/prefix names", async () => {
    const rep = await lane(browserTicket(), {
      lease: { tabName: "l240-accept", threadPrefix: "l240a-" },
    });
    expect(rep.lease).toMatchObject({ tabName: "l240-accept", threadPrefix: "l240a-" });
    expect(rep.spawn?.task).toContain("tab: l240-accept");
    expect(rep.spawn?.task).toContain("prefix: l240a-");
  });

  it("non-browser ticket: lease is null and the context carries no lease section", async () => {
    const rep = await lane(laneTicket());
    expect(rep.lease).toBeNull();
    expect(rep.spawn?.task).not.toContain("Browser lease");
  });

  it("confirm: registers the lease at spawn time; the PM release closes it", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    _inject({ gql: laneBoard(240).gql, runGit: () => "" });
    registerSpawn(() => "L240browser");
    const rep = await lane(browserTicket(), {}, { confirm: true, leasesPath: LEASE_PATH });
    logSpy.mockRestore();
    expect(rep.ok).toBe(true);
    expect(rep.spawned).toBe(true);
    expect(rep.lease?.registered).toBe(true);
    expect(ledger({ path: LEASE_PATH }).active.map((a) => [a.tabName, a.number])).toEqual([
      ["l240", 240],
    ]);
    release("browser", { lane: rep.lease?.lane ?? "" }, { path: LEASE_PATH });
    expect(ledger({ path: LEASE_PATH }).active).toHaveLength(0);
  });

  it("spawn throw rolls the lease registration back", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    _inject({ gql: laneBoard(240).gql, runGit: () => "" });
    registerSpawn(() => {
      throw new Error("kernel refused spawn");
    });
    const rep = await lane(browserTicket(), {}, { confirm: true, leasesPath: LEASE_PATH });
    logSpy.mockRestore();
    expect(rep.spawned).toBe(false);
    expect(rep.ok).toBe(false);
    expect(rep.lease?.registered).toBe(false);
    expect(ledger({ path: LEASE_PATH }).events.map((e) => e.event)).toEqual([
      "acquired",
      "released",
    ]);
    expect(ledger({ path: LEASE_PATH }).active).toHaveLength(0);
  });

  it("a lease collision aborts the dispatch before the spawn", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    lease(
      "browser",
      { lane: "lane-238-working", tabName: "l240", threadPrefix: "l238-" },
      { path: LEASE_PATH },
    );
    _inject({ gql: laneBoard(240).gql, runGit: () => "" });
    registerSpawn(() => "L240browser");
    const rep = await lane(browserTicket(), {}, { confirm: true, leasesPath: LEASE_PATH });
    logSpy.mockRestore();
    expect(rep.ok).toBe(false);
    expect(rep.spawned).toBe(false);
    expect(rep.statusFlipped).toBe(false);
    expect(rep.errors[0]).toContain("browser lease registration failed");
    expect(rep.errors[0]).toContain("collision");
    expect(ledger({ path: LEASE_PATH }).events).toHaveLength(1); // nothing appended
  });
});

describe("AP.audit rule 6 — browser lease drift (#240)", () => {
  const NOW = new Date("2026-10-04T00:00:00Z");
  const mk = (over: Partial<Ticket> & Pick<Ticket, "number">): Ticket => ({
    id: `I${over.number}`,
    title: `t${over.number}`,
    body: "",
    state: "OPEN",
    milestone: "M1",
    labels: [],
    blockedBy: [],
    itemId: `PVTItem_${over.number}`,
    status: "Todo",
    priority: null,
    updatedAt: "2026-10-03T00:00:00Z",
    ...over,
  });
  const browserMk = (over: Partial<Ticket> & Pick<Ticket, "number">): Ticket =>
    mk({ title: `浏览器 CDP 验收 t${over.number}`, ...over });

  it("6a: an active browser lane without a lease is flagged mutation-free; a leased lane is silent", () => {
    const leased = audit(
      { tickets: [browserMk({ number: 239, status: "In Progress" })] },
      {
        activeLanes: [239],
        leases: [
          leaseAcquire({
            lane: "lane-239-accept",
            tabName: "l239",
            threadPrefix: "l239-",
            number: 239,
          }),
        ],
        now: NOW,
      },
    );
    expect(leased.clean).toBe(true);
    const unleased = audit(
      { tickets: [browserMk({ number: 240, status: "In Progress" })] },
      { activeLanes: [240], leases: [], now: NOW },
    );
    expect(unleased.drift.map((d) => [d.rule, d.number, d.mutation])).toEqual([
      ["browserLeaseMissing", 240, null],
    ]);
    expect(unleased.mutations).toEqual([]);
    // not browser, or browser but not an active lane → rule 6a silent
    const scoped = audit(
      { tickets: [browserMk({ number: 241 }), mk({ number: 7 })] },
      { activeLanes: [241, 7], leases: [], now: NOW },
    );
    // rule 3 also fires (Todo on an active lane); scope to the rule-6 finding
    expect(
      scoped.drift.filter((d) => d.rule === "browserLeaseMissing").map((d) => d.number),
    ).toEqual([241]);
  });

  it("6b: one tab or one thread prefix on two lanes collides — one finding per late holder", () => {
    const rep = audit(
      { tickets: [mk({ number: 238 }), mk({ number: 239 })] },
      {
        leases: [
          leaseAcquire({ lane: "lane-238-a", tabName: "l238", threadPrefix: "l238-", number: 238 }),
          leaseAcquire({ lane: "lane-239-b", tabName: "l238", threadPrefix: "l239-", number: 239 }),
          leaseAcquire({ lane: "lane-239-b", tabName: "l239", threadPrefix: "l238-", number: 239 }),
        ],
        now: NOW,
      },
    );
    const collisions = rep.drift.filter((d) => d.rule === "browserLeaseCollision");
    expect(collisions).toHaveLength(2); // tab:l238 late holder + prefix:l238 late holder
    expect(collisions.every((d) => d.detail.includes("held concurrently by lanes lane-238-a")));
    expect(collisions.every((d) => d.mutation === null)).toBe(true);
  });

  it("6c: a delivered ticket with an open lease is flagged; the release closes the finding", () => {
    const held = leaseAcquire({
      lane: "lane-239-accept",
      tabName: "l239",
      threadPrefix: "l239-",
      number: 239,
    });
    const delivered: Ticket[] = [browserMk({ number: 239, state: "CLOSED", status: "Done" })];
    const open = audit({ tickets: delivered }, { leases: [held], now: NOW });
    expect(open.drift.map((d) => [d.rule, d.number])).toEqual([["browserLeaseUnreleased", 239]]);
    expect(open.drift[0]?.detail).toContain("AP.release");
    const closed = audit(
      { tickets: delivered },
      {
        leases: [held, { ...held, event: "released", releasedAt: "2026-10-04T00:00:00Z" }],
        now: NOW,
      },
    );
    expect(closed.clean).toBe(true);
  });

  it("rule 6 is silent without the ledger — a missing lease store fabricates nothing", () => {
    const rep = audit(
      { tickets: [browserMk({ number: 240, status: "In Progress" })] },
      { activeLanes: [240], now: NOW },
    );
    expect(rep.drift).toEqual([]);
    expect(rep.clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Closeout evidence ledger (#277) — the acceptance-lane gate's written
// record; AP.closeout writes it, AP.audit rule 7 reads it.
// ---------------------------------------------------------------------------

const CLOSEOUT_PATH = "test-closeouts.jsonl";

/** 禁再造假票 (#402): every face-classification fixture is the LIVE bodyText
 *  of a real ticket (fixtures/corpus-402.ts). #390 is the code-face stand-in —
 *  its 验收 section ships tests and mentions "UI 票", the meta-mention the
 *  keyword scan deliberately passes — and the ledger tests record it under
 *  its own number. */
const CODE_FACE_TICKET = CORPUS_390;

/** Non-gated labels: outside the #277 closeout gate, hence outside #390. The
 *  #386 live body with docs labels — the label axis is what this fixture
 *  isolates, never the body. */
const DOCS_LABELED_TICKET = { ...CORPUS_386, labels: ["type:docs"] };

const acceptedEvent = (
  over: Partial<CloseoutEvent> & Pick<CloseoutEvent, "number">,
): CloseoutEvent => ({
  event: "accepted",
  source: "acceptance-lane",
  evidenceType: "walk",
  evidence: `https://issue/${over.number}#comment`,
  date: "2026-10-05T06:00:00Z",
  deploymentVersion: "ece470f",
  recordedAt: "2026-10-05T06:00:00Z",
  ...over,
});

describe("closeout evidence ledger (#277)", () => {
  const NOW = new Date("2026-10-05T12:00:00Z");

  beforeEach(() => {
    fsProbe.files.clear();
    delete process.env.PM_CLOSEOUTS_PATH;
  });

  it("closeout records the evidence trio; closeoutLedger replays the accepted set", async () => {
    const rec = await closeout(
      390,
      "acceptance-lane",
      { evidence: "https://issue/390#comment", deploymentVersion: "ece470f" },
      { path: CLOSEOUT_PATH, now: NOW, ticket: CODE_FACE_TICKET },
    );
    expect(rec).toMatchObject({
      event: "accepted",
      number: 390,
      source: "acceptance-lane",
      evidenceType: "walk",
      evidence: "https://issue/390#comment",
      deploymentVersion: "ece470f",
      date: NOW.toISOString(),
      recordedAt: NOW.toISOString(),
    });
    const view = closeoutLedger({ path: CLOSEOUT_PATH });
    expect(view.events).toHaveLength(1);
    expect([...view.accepted]).toEqual([390]);
    // dedup by number: two accepted entries for one ticket = one member
    expect([
      ...acceptedNumbers([acceptedEvent({ number: 390 }), acceptedEvent({ number: 390 })]),
    ]).toEqual([390]);
  });

  it("refuses an incomplete trio with zero writes — 无证据不关票", async () => {
    await expect(
      closeout(
        266,
        "acceptance-lane",
        { evidence: "   ", deploymentVersion: "ece470f" },
        { path: CLOSEOUT_PATH },
      ),
    ).rejects.toThrow(/evidence anchor is required/);
    await expect(
      closeout(
        266,
        "ci",
        { evidence: "run link", deploymentVersion: "  " },
        { path: CLOSEOUT_PATH },
      ),
    ).rejects.toThrow(/deploymentVersion is required/);
    await expect(
      closeout(
        0,
        "ci",
        { evidence: "run link", deploymentVersion: "run-1" },
        { path: CLOSEOUT_PATH },
      ),
    ).rejects.toThrow(/ticket number is required/);
    expect(closeoutLedger({ path: CLOSEOUT_PATH }).events).toHaveLength(0);
  });

  it("re-accepting a reopened ticket appends; source records who verified", async () => {
    await closeout(
      390,
      "acceptance-lane",
      { evidence: "e1", deploymentVersion: "v1" },
      { path: CLOSEOUT_PATH, now: NOW, ticket: CODE_FACE_TICKET },
    );
    await closeout(
      390,
      "ci",
      { evidence: "e2", deploymentVersion: "run-9" },
      { path: CLOSEOUT_PATH, now: new Date(NOW.getTime() + 1_000), ticket: CODE_FACE_TICKET },
    );
    const view = closeoutLedger({ path: CLOSEOUT_PATH });
    expect(view.events).toHaveLength(2);
    expect(view.events[1]).toMatchObject({ source: "ci", evidence: "e2", evidenceType: "run" });
    expect(view.accepted.has(390)).toBe(true);
  });

  it("PM_CLOSEOUTS_PATH redirects the default store; a missing file reads as an empty ledger", async () => {
    process.env.PM_CLOSEOUTS_PATH = "env-closeouts.jsonl";
    await closeout(390, "ci", { evidence: "run-1", deploymentVersion: "run-1" }, { ticket: CODE_FACE_TICKET });
    expect(closeoutLedger().accepted.has(390)).toBe(true);
    expect(closeoutLedger({ path: CLOSEOUT_PATH }).events).toHaveLength(0);
    expect(closeoutLedger({ path: "nope.jsonl" }).events).toHaveLength(0);
  });

  it("a corrupt jsonl line names the file and line", () => {
    fsProbe.files.set(
      CLOSEOUT_PATH,
      `${JSON.stringify(acceptedEvent({ number: 266 }))}\nnot-json\n`,
    );
    expect(() => closeoutLedger({ path: CLOSEOUT_PATH })).toThrow(
      /corrupt jsonl .*test-closeouts\.jsonl:2/,
    );
  });

  it("closeoutGated scopes the gate to code-delivering labels", () => {
    expect(closeoutGated(["type:implementation"])).toBe(true);
    expect(closeoutGated(["type:bug"])).toBe(true);
    expect(closeoutGated(["type:docs", "track:acceptance"])).toBe(false);
    expect(closeoutGated([])).toBe(false);
  });
});

describe("closeout acceptance-face gate (#390, #402 corpus)", () => {
  const NOW = new Date("2026-10-06T12:00:00Z");

  beforeEach(() => {
    fsProbe.files.clear();
    delete process.env.PM_CLOSEOUTS_PATH;
  });

  afterEach(() => {
    _inject(null);
  });

  it("#387 live body reads product-face — the #402 probe pair is refused", async () => {
    // Regression core: the 2026-10-06 PM probe accepted BOTH of the closeouts
    // below against this exact live bodyText (bare-line 验收) while every
    // markdown-anchored fixture stayed green (#402).
    expect(acceptanceFaceOf(CORPUS_387.body)).toBe("product");
    await expect(
      closeout(
        387,
        "ci",
        { evidence: "run-37450877857", deploymentVersion: "run-37450877857" },
        { path: CLOSEOUT_PATH, now: NOW, ticket: CORPUS_387 },
      ),
    ).rejects.toThrow(/source "ci" is refused[\s\S]*acceptance-lane[\s\S]*console 错误/);
    await expect(
      closeout(
        387,
        "acceptance-lane",
        { evidence: "ACC=WALK:本地 staging 全链（plugin staged hash c62ac717）", deploymentVersion: "c62ac717" },
        { path: CLOSEOUT_PATH, now: NOW, ticket: CORPUS_387 },
      ),
    ).rejects.toThrow(/surface evidence[\s\S]*截图/);
    expect(closeoutLedger({ path: CLOSEOUT_PATH }).events).toHaveLength(0);
  });

  it("a product-face walk without surface evidence is refused — ACC=WALK:本地全链 is the gap (#382 live body)", async () => {
    await expect(
      closeout(
        382,
        "acceptance-lane",
        { evidence: "ACC=WALK:本地 staging 全链（plugin staged hash c62ac717）", deploymentVersion: "c62ac717" },
        { path: CLOSEOUT_PATH, now: NOW, ticket: CORPUS_382 },
      ),
    ).rejects.toThrow(/surface evidence[\s\S]*截图/);
    expect(closeoutLedger({ path: CLOSEOUT_PATH }).events).toHaveLength(0);
  });

  it("a product-face walk with surface evidence lands: evidenceType walk + face recorded (#382 live body)", async () => {
    const rec = await closeout(
      382,
      "acceptance-lane",
      {
        evidence:
          "console 无错误；截图 https://telegraph/l382-panel.png；选择器断言 .provider-row 可见（目标 URL /settings，2026-10-06T12:00Z）",
        deploymentVersion: "c62ac717",
      },
      { path: CLOSEOUT_PATH, now: NOW, ticket: CORPUS_382 },
    );
    expect(rec).toMatchObject({
      source: "acceptance-lane",
      evidenceType: "walk",
      acceptanceFace: "product",
    });
    expect(closeoutLedger({ path: CLOSEOUT_PATH }).accepted.has(382)).toBe(true);
  });

  it("a code-face ticket keeps both sources; ci rows record evidenceType run (#391 live body)", async () => {
    const rec = await closeout(
      391,
      "ci",
      { evidence: "run-37449681303", deploymentVersion: "run-37449681303" },
      { path: CLOSEOUT_PATH, now: NOW, ticket: CORPUS_391 },
    );
    expect(rec).toMatchObject({ source: "ci", evidenceType: "run", acceptanceFace: "code" });
  });

  it("an explicit acceptance-type field beats the keyword scan both ways", async () => {
    // Scan direction, live corpus: #390's 验收 TALKS about "UI 票" while
    // shipping tests — the scan's deliberate non-match lands code, source:ci
    // passes.
    const scanned = await closeout(
      390,
      "ci",
      { evidence: "run-1", deploymentVersion: "run-1" },
      { path: CLOSEOUT_PATH, now: NOW, ticket: CODE_FACE_TICKET },
    );
    expect(scanned.acceptanceFace).toBe("code");
    // Pin direction: no live ticket carries the field yet, so the field is
    // appended to #391's real body — its scan verdict is code, the field says
    // product, the field wins and source:ci is refused.
    await expect(
      closeout(
        391,
        "ci",
        { evidence: "run-2", deploymentVersion: "run-2" },
        {
          path: CLOSEOUT_PATH,
          now: NOW,
          ticket: { ...CORPUS_391, body: `${CORPUS_391.body}\n\nacceptance-type: product` },
        },
      ),
    ).rejects.toThrow(/product-face/);
  });

  it("an unknown acceptance-type value falls through to the keyword scan", async () => {
    // #387's scan verdict is product; an unknown field value must not pin
    // code over it — source:ci stays refused.
    await expect(
      closeout(
        387,
        "ci",
        { evidence: "run-3", deploymentVersion: "run-3" },
        {
          path: CLOSEOUT_PATH,
          now: NOW,
          ticket: { ...CORPUS_387, body: `${CORPUS_387.body}\n\nacceptance-type: hybrid` },
        },
      ),
    ).rejects.toThrow(/product-face/);
  });

  it("non-gated labels bypass the face rules and record no face", async () => {
    const rec = await closeout(
      386,
      "ci",
      { evidence: "run-4", deploymentVersion: "run-4" },
      { path: CLOSEOUT_PATH, now: NOW, ticket: DOCS_LABELED_TICKET },
    );
    expect(rec.evidenceType).toBe("run");
    expect(rec.acceptanceFace).toBeUndefined();
  });

  it("the gate reads the live ticket through the transport seam — and fails closed", async () => {
    // Canned transport: the real fetch path runs, the wire is canned — the
    // bodyText shape is the corpus's, bare-line 验收 included. #387's real
    // labels (type:bug) exercise the second gate leg.
    _inject({
      gql: () =>
        Promise.resolve({
          repository: {
            issue: {
              title: CORPUS_387.title,
              bodyText: CORPUS_387.body,
              labels: { nodes: CORPUS_387.labels.map((name) => ({ name })) },
            },
          },
        }),
    });
    await expect(
      closeout(387, "ci", { evidence: "run-5", deploymentVersion: "run-5" }, { path: CLOSEOUT_PATH, now: NOW }),
    ).rejects.toThrow(/source "ci" is refused/);

    // Fail-closed: an unread ticket is an unclassifiable closeout.
    _inject({ gql: () => Promise.reject(new Error("transport down")) });
    await expect(
      closeout(390, "ci", { evidence: "run-6", deploymentVersion: "run-6" }, { path: CLOSEOUT_PATH, now: NOW }),
    ).rejects.toThrow(/cannot read ticket #390[\s\S]*unread ticket/);
    expect(closeoutLedger({ path: CLOSEOUT_PATH }).events).toHaveLength(0);
  });

  it("acceptanceFaceOf reads the live corpus — bare-line sections included (#402)", () => {
    // Product faces, straight from live bodyText (the bytes the probe ran):
    expect(acceptanceFaceOf(CORPUS_387.body)).toBe("product");
    expect(acceptanceFaceOf(CORPUS_362.body)).toBe("product");
    expect(acceptanceFaceOf(CORPUS_382.body)).toBe("product");
    // #386's 验收 names 真机 (守护不再锚真机) — the scan fails closed on a
    // surface word, product until a walk says otherwise.
    expect(acceptanceFaceOf(CORPUS_386.body)).toBe("product");
    // Code faces: #391 ships harness L1s; #390's "UI 票" is the deliberate
    // meta-mention non-match.
    expect(acceptanceFaceOf(CORPUS_391.body)).toBe("code");
    expect(acceptanceFaceOf(CORPUS_390.body)).toBe("code");
    // Section discipline on the BARE-line form (#402 root cause): the 验收
    // section starts at the bare head, ends at the next bare section head
    // (任务) — never leaking the 用户实证/任务 surface words around it.
    const section = acceptanceSectionOf(CORPUS_387.body);
    expect(section).toContain("真机走查记录");
    expect(section).not.toContain("用户实证");
    expect(section).not.toContain("settingsSection");
    // The markdown form keeps working. Mixed section: CI 绿 alongside 走查
    // is still product.
    expect(acceptanceFaceOf("## 验收\n- CI 绿\n- staging 走查")).toBe("product");
    // The deliberate non-matches: bare staging (infra), UI before 票 (meta),
    // surface words outside any 验收 section.
    expect(acceptanceFaceOf("pi/bb 式面板\n\n## 切分\n- P0=CRUD")).toBe("code");
    expect(acceptanceFaceOf("## 验收\n- staging 宿主 daemon 常驻\n- CI 绿")).toBe("code");
    expect(acceptanceFaceOf("## 验收\n- UI 票重审断言")).toBe("code");
    // A real UI claim still lands.
    expect(acceptanceFaceOf("## 验收\n- UI 增删改 provider")).toBe("product");
  });
});

describe("closeout ledger evidenceType migration (#390)", () => {
  beforeEach(() => {
    fsProbe.files.clear();
    delete process.env.PM_CLOSEOUTS_PATH;
  });

  it("legacy rows backfill evidenceType from source in the read view", () => {
    fsProbe.files.set(
      CLOSEOUT_PATH,
      [
        JSON.stringify({ ...acceptedEvent({ number: 266 }), evidenceType: undefined }),
        JSON.stringify({
          ...acceptedEvent({ number: 377, source: "ci", evidence: "run-1", deploymentVersion: "run-1" }),
          evidenceType: undefined,
        }),
      ].join("\n"),
    );
    const view = closeoutLedger({ path: CLOSEOUT_PATH });
    expect(view.events.map((e) => e.evidenceType)).toEqual(["walk", "run"]);
  });

  it("migrateCloseoutLedger backfills on disk and is idempotent", () => {
    fsProbe.files.set(
      CLOSEOUT_PATH,
      [
        JSON.stringify({ ...acceptedEvent({ number: 266 }), evidenceType: undefined }),
        JSON.stringify({
          ...acceptedEvent({ number: 377, source: "ci", evidence: "run-1", deploymentVersion: "run-1" }),
          evidenceType: undefined,
        }),
      ].join("\n"),
    );
    expect(migrateCloseoutLedger({ path: CLOSEOUT_PATH })).toEqual({ migrated: 2, total: 2 });
    const rows = fsProbe.files.get(CLOSEOUT_PATH)?.trim().split("\n") ?? [];
    expect(JSON.parse(rows[0] ?? "{}")).toMatchObject({ number: 266, evidenceType: "walk" });
    expect(JSON.parse(rows[1] ?? "{}")).toMatchObject({ number: 377, evidenceType: "run" });
    expect(migrateCloseoutLedger({ path: CLOSEOUT_PATH })).toEqual({ migrated: 0, total: 2 });
  });
});

describe("AP.audit rule 7 — closeout evidence drift (#277)", () => {
  const NOW = new Date("2026-10-04T00:00:00Z");
  const mk = (over: Partial<Ticket> & Pick<Ticket, "number">): Ticket => ({
    id: `I${over.number}`,
    title: `t${over.number}`,
    body: "",
    state: "CLOSED",
    milestone: "M1",
    labels: [],
    blockedBy: [],
    itemId: `PVTItem_${over.number}`,
    status: "Done",
    priority: null,
    updatedAt: "2026-10-03T00:00:00Z",
    ...over,
  });
  const implMk = (over: Partial<Ticket> & Pick<Ticket, "number">): Ticket =>
    mk({ labels: ["type:implementation", "block:agent-harness"], ...over });

  it("a delivered code ticket with no accepted entry is flagged mutation-free", () => {
    const rep = audit({ tickets: [implMk({ number: 257 })] }, { closeouts: [], now: NOW });
    expect(rep.drift.map((d) => [d.rule, d.number, d.mutation])).toEqual([
      ["closeoutNoEvidence", 257, null],
    ]);
    expect(rep.mutations).toEqual([]);
    expect(rep.drift[0]?.detail).toContain("AP.closeout(257");
  });

  it("an accepted closeout entry silences the rule; another ticket's entry does not", () => {
    const silenced = audit(
      { tickets: [implMk({ number: 266 })] },
      { closeouts: [acceptedEvent({ number: 266 })], now: NOW },
    );
    expect(silenced.clean).toBe(true);
    const otherTicket = audit(
      { tickets: [implMk({ number: 266 })] },
      { closeouts: [acceptedEvent({ number: 999 })], now: NOW },
    );
    expect(otherTicket.drift.map((d) => d.rule)).toEqual(["closeoutNoEvidence"]);
  });

  it("the gate fires on delivery only: open tickets and non-code tickets stay silent", () => {
    const rep = audit(
      {
        tickets: [
          implMk({ number: 280, state: "OPEN", status: "In Progress" }),
          mk({ number: 239, labels: ["type:docs", "track:acceptance"] }),
          mk({ number: 244, labels: ["wayfinder:research"] }),
        ],
      },
      { closeouts: [], now: NOW },
    );
    expect(rep.drift).toHaveLength(0);
  });

  it("Status Done/Canceled without a CLOSED state is still delivered", () => {
    const rep = audit(
      { tickets: [implMk({ number: 254, state: "OPEN", status: "Canceled" })] },
      { closeouts: [], now: NOW },
    );
    expect(rep.drift.map((d) => d.rule)).toEqual(["closeoutNoEvidence"]);
  });

  it("rule 7 is silent without the ledger — a missing store fabricates nothing", () => {
    const rep = audit({ tickets: [implMk({ number: 257 })] }, { now: NOW });
    expect(rep.drift).toHaveLength(0);
  });
});
