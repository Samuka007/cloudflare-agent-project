import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _inject,
  apply,
  classifyIntake,
  defaultJudge,
  dispatchable,
  dispatchPackets,
  gateOf,
  intake,
  INTAKE_QUESTIONS,
  JEV_MODEL,
  JEV_URL,
  planCascade,
  planDiff,
  resolveJeapiKey,
  slugify,
  snapshot,
  type GqlFn,
  type JudgeAnswer,
  type JudgeReply,
  type Ticket,
} from "../pm-autopilot.js";

/**
 * L1 suite for #131 pm-autopilot. Zero network: the GitHub transport is an
 * in-memory board executing the very mutations the autopilot issues (so the
 * guarded apply → per-batch re-verify loop runs end-to-end against evolving
 * state), and the jev judge is mocked at the FETCH level — the real
 * transport code (headers, request shape, answer parsing, gate) is what
 * runs; only the wire is canned. Live writes never happen here.
 *
 * node:fs is mocked wholesale: pm-autopilot touches the filesystem only to
 * read the gitignored .env.local for JEV_API_KEY, and mocking it makes the
 * key-resolution tests deterministic (no dependence on a developer machine's
 * real file).
 */

const fsProbe = vi.hoisted(() => ({ envLocalBody: null as string | null }));

vi.mock("node:fs", () => ({
  readFileSync: (path: unknown): string => {
    if (fsProbe.envLocalBody !== null && typeof path === "string" && path.endsWith(".env.local")) {
      return fsProbe.envLocalBody;
    }
    throw new Error(`mock fs: ${String(path)} unavailable`);
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATUS_FIELD_ID = "F_status";
const PRIORITY_FIELD_ID = "F_priority";
const STATUS_OPTIONS: Record<string, string> = Object.fromEntries(
  ["Backlog", "Todo", "In Progress", "Wait for user", "Done", "Canceled"].map((n) => [
    n,
    `opt_${n.replaceAll(" ", "_")}`,
  ]),
);
const PRIORITY_OPTIONS: Record<string, string> = { P0: "opt_P0", P1: "opt_P1", P2: "opt_P2" };
const LABEL_IDS: Record<string, string> = {
  "block:agent-harness": "L_harness",
  "block:bb-ux": "L_bbux",
  "ready-for-human": "L_rfh",
  "type:implementation": "L_impl",
};

interface IssueRow {
  id: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  bodyText: string | null;
  milestone: { title: string } | null;
  labels: { nodes: { name: string }[] };
  blockedBy: { nodes: { number: number; state: "OPEN" | "CLOSED"; title: string }[] };
}

interface ItemRow {
  itemId: string;
  issueNumber: number;
  status: string | null;
  priority: string | null;
}

class MockBoard {
  issues: IssueRow[] = [];
  items: ItemRow[] = [];
  milestones: Record<string, string> = { M1: "M_m1", M2: "M_m2" };
  /** Mutation GraphQL calls in issue order (never touched on dry-run). */
  mutations: { query: string; variables: Record<string, unknown> }[] = [];
  /** Drift injection: status writes silently do nothing. */
  failStatusWrites = false;
  itemSeq = 0;

  addIssue(over: Partial<IssueRow> & Pick<IssueRow, "number" | "title">): IssueRow {
    const row: IssueRow = {
      id: `I${over.number}`,
      state: "OPEN",
      bodyText: "",
      milestone: null,
      labels: { nodes: [] },
      blockedBy: { nodes: [] },
      ...over,
    };
    this.issues.push(row);
    return row;
  }

  boardIssue(number: number, status: string | null, priority: string | null): void {
    this.itemSeq += 1;
    this.items.push({ itemId: `PVTItem_${this.itemSeq}`, issueNumber: number, status, priority });
  }

  /** Snapshot-shaped ticket list (what AP.snapshot would derive). */
  tickets(): Ticket[] {
    return this.issues.map((i) => {
      const item = this.items.find((it) => it.issueNumber === i.number);
      const status = item?.status ?? null;
      const priority = item?.priority ?? null;
      // mock board statuses/priorities are only ever written from the option
      // maps above — the same closed vocabulary Ticket encodes
      return {
        number: i.number,
        id: i.id,
        title: i.title,
        body: i.bodyText ?? "",
        state: i.state,
        milestone: i.milestone?.title ?? null,
        labels: i.labels.nodes.map((l) => l.name),
        blockedBy: i.blockedBy.nodes,
        itemId: item?.itemId ?? null,
        status: status as Ticket["status"],
        priority: priority as Ticket["priority"],
      };
    });
  }

  planInput(extra: { extraIssueIds?: Record<number, string> } = {}) {
    return {
      tickets: this.tickets(),
      statusFieldId: STATUS_FIELD_ID,
      priorityFieldId: PRIORITY_FIELD_ID,
      statusOptions: STATUS_OPTIONS,
      priorityOptions: PRIORITY_OPTIONS,
      milestones: this.milestones,
      labels: LABEL_IDS,
      ...extra,
    };
  }

  private issueByNumber(n: number): IssueRow | undefined {
    return this.issues.find((i) => i.number === n);
  }

  private itemByNumber(n: number): ItemRow | undefined {
    return this.items.find((i) => i.issueNumber === n);
  }

  private verifyShape(n: number) {
    const issue = this.issueByNumber(n);
    const item = this.itemByNumber(n);
    return {
      number: n,
      milestone: issue?.milestone ?? null,
      labels: { nodes: issue?.labels.nodes ?? [] },
      blockedBy: { nodes: issue?.blockedBy.nodes ?? [] },
      projectItems: {
        nodes: item
          ? [
              {
                id: item.itemId,
                project: { id: "PVT_kwHOAvgCqs4Blk19" },
                status: { name: item.status },
                priority: { name: item.priority },
              },
            ]
          : [],
      },
    };
  }

  gql: GqlFn = (query, variables) => Promise.resolve(this.dispatch(query, variables));

  private dispatch(query: string, variables: Record<string, unknown>): Record<string, unknown> {
    if (query.includes("mutation")) {
      this.mutations.push({ query, variables });
      if (query.includes("addProjectV2ItemById")) {
        const n = Number(String(variables.contentId).slice(1));
        if (this.itemByNumber(n) === undefined) this.boardIssue(n, null, null);
        return { addProjectV2ItemById: { item: { id: this.itemByNumber(n)?.itemId } } };
      }
      if (query.includes("updateProjectV2ItemFieldValue")) {
        const item = this.items.find((i) => i.itemId === variables.itemId);
        const isStatus = variables.fieldId === STATUS_FIELD_ID;
        const optionMap = isStatus ? STATUS_OPTIONS : PRIORITY_OPTIONS;
        const value =
          Object.entries(optionMap).find(([, id]) => id === variables.optionId)?.[0] ?? null;
        if (item !== undefined && !(isStatus && this.failStatusWrites)) {
          if (isStatus) item.status = value;
          else item.priority = value;
        }
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
      }
      if (query.includes("updateIssue")) {
        const issue = this.issueByNumber(Number(String(variables.id).slice(1)));
        if (issue !== undefined) {
          const title =
            variables.milestoneId === null || variables.milestoneId === undefined
              ? null
              : (Object.entries(this.milestones).find(
                  ([, id]) => id === variables.milestoneId,
                )?.[0] ?? null);
          issue.milestone = title === null ? null : { title };
        }
        return { updateIssue: { issue: { number: issue?.number } } };
      }
      if (query.includes("addBlockedBy")) {
        const issue = this.issueByNumber(Number(String(variables.issueId).slice(1)));
        const blocker = this.issueByNumber(Number(String(variables.blockingIssueId).slice(1)));
        if (issue !== undefined && blocker !== undefined) {
          issue.blockedBy.nodes.push({
            number: blocker.number,
            state: blocker.state,
            title: blocker.title,
          });
        }
        return { addBlockedBy: { issue: { number: issue?.number } } };
      }
      if (query.includes("addLabelsToLabelable")) {
        const issue = this.issueByNumber(Number(String(variables.labelableId).slice(1)));
        const rawIds = variables.labelIds;
        const names = (Array.isArray(rawIds) ? rawIds : []).map(
          (id) => Object.entries(LABEL_IDS).find(([, lid]) => lid === id)?.[0] ?? "unknown",
        );
        if (issue !== undefined) for (const name of names) issue.labels.nodes.push({ name });
        return { addLabelsToLabelable: { labelable: { number: issue?.number } } };
      }
      throw new Error(`mock board: unknown mutation: ${query.slice(0, 80)}`);
    }

    if (query.includes("project: node(id: $id)")) {
      const itemNodes = this.items.map((item) => {
        const issue = this.issueByNumber(item.issueNumber);
        return {
          id: item.itemId,
          status: item.status === null ? null : { name: item.status },
          priority: item.priority === null ? null : { name: item.priority },
          content: issue === undefined ? null : { __typename: "Issue", ...issue },
        };
      });
      return {
        project: {
          items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: itemNodes },
        },
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: this.issues.filter((i) => i.state === "OPEN"),
          },
        },
      };
    }
    if (query.includes("fields(first: 20)")) {
      return {
        node: {
          fields: {
            nodes: [
              {
                id: STATUS_FIELD_ID,
                name: "Status",
                options: Object.entries(STATUS_OPTIONS).map(([name, id]) => ({ id, name })),
              },
              {
                id: PRIORITY_FIELD_ID,
                name: "Priority",
                options: Object.entries(PRIORITY_OPTIONS).map(([name, id]) => ({ id, name })),
              },
            ],
          },
        },
      };
    }
    if (query.includes("label(name: $name)")) {
      const name = variables.name;
      const id = typeof name === "string" ? LABEL_IDS[name] : undefined;
      return { repository: { label: id === undefined ? null : { id, name } } };
    }
    if (query.includes("milestones(first: 50")) {
      return {
        repository: {
          milestones: {
            nodes: Object.entries(this.milestones).map(([title, id]) => ({ id, title })),
          },
        },
      };
    }
    if (query.includes("issue(number: $number)")) {
      const requested = variables.number;
      const issue = this.issueByNumber(typeof requested === "number" ? requested : -1);
      return { repository: { issue: issue === undefined ? null : { id: issue.id } } };
    }
    if (query.includes(": issue(number:")) {
      const numbers = [...query.matchAll(/i(\d+): issue/g)].map((m) => Number(m[1]));
      const repository: Record<string, unknown> = {};
      for (const n of numbers) repository[`i${n}`] = this.verifyShape(n);
      return { repository };
    }
    throw new Error(`mock board: unknown query: ${query.slice(0, 80)}`);
  }
}

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
    const [skeleton] = dispatchPackets([{ ...t, body: "no budget here" }]);
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
