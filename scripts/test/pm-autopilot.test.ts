import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _inject,
  apply,
  classifyIntake,
  defaultJudge,
  dispatchable,
  dispatchPackets,
  dorChecklist,
  FILE_CONFIDENCE_FLOOR,
  file,
  gateOf,
  intake,
  INTAKE_QUESTIONS,
  lane,
  JEV_MODEL,
  JEV_URL,
  planCascade,
  planFile,
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
      if (query.includes("createIssue")) {
        const number = Math.max(0, ...this.issues.map((i) => i.number)) + 1;
        const row: IssueRow = {
          id: `I${number}`,
          number,
          title: String(variables.title),
          state: "OPEN",
          bodyText: typeof variables.body === "string" ? variables.body : "",
          milestone: null,
          labels: { nodes: [] },
          blockedBy: { nodes: [] },
        };
        if (typeof variables.milestoneId === "string") {
          const title = Object.entries(this.milestones).find(
            ([, id]) => id === variables.milestoneId,
          )?.[0];
          if (title !== undefined) row.milestone = { title };
        }
        this.issues.push(row);
        return { createIssue: { issue: { id: row.id, number, url: `https://example.invalid/${number}` } } };
      }
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
          // closeIssue passes state as a query literal, not a variable
          if (variables.state === "CLOSED" || query.includes("state: CLOSED")) {
            issue.state = "CLOSED";
          }
          // milestone only touched when the mutation carries it (closeIssue
          // omits the key — a rollback close must not rewrite the milestone)
          if ("milestoneId" in variables) {
            const title =
              variables.milestoneId === null
                ? null
                : (Object.entries(this.milestones).find(
                    ([, id]) => id === variables.milestoneId,
                  )?.[0] ?? null);
            issue.milestone = title === null ? null : { title };
          }
        }
        return { updateIssue: { issue: { number: issue?.number } } };
      }
      if (query.includes("deleteProjectV2ItemById")) {
        this.items = this.items.filter((i) => i.itemId !== variables.itemId);
        return { deleteProjectV2ItemById: { deletedItemId: variables.itemId } };
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
    if (query.includes("labels(first: 100")) {
      return {
        repository: {
          id: "R_repo",
          labels: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: Object.entries(LABEL_IDS).map(([name, id]) => ({ id, name })),
          },
          // number = ordinal position — the mock's own truth; tests assert
          // AP.file read THIS number, proving runtime resolution (M1.5≠7).
          milestones: {
            nodes: Object.entries(this.milestones).map(([title, id], i) => ({
              id,
              number: i + 1,
              title,
            })),
          },
        },
      };
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
    expect(plan.labels).toEqual([
      "block:agent-harness",
      "type:implementation",
      "ready-for-human",
    ]);
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
    expect(Object.keys(judgeCalls[0]?.questions ?? {}).sort()).toEqual([...ATOMIC_QUESTIONS].sort());
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
    const indexOf = (needle: string): number =>
      kinds.findIndex((q) => q.includes(needle));
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
      replyAll(0.95, { priority: choiceAnswer("P2", 0.5), needs_human: { type: "noul", noul: 0.2 } }),
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
    itemId: "PVTItem_9",
    status: "Todo",
    priority: "P1",
    ...over,
  };
}

describe("dorChecklist (pure)", () => {
  it("five items in ticket order, all pass on a complete body, budget carries the line", () => {
    const dor = dorChecklist(FULL_DOR_BODY);
    expect(dor.map((c) => c.key)).toEqual([
      "three-questions",
      "acceptance",
      "anchors",
      "budget",
      "precedent",
    ]);
    expect(dor.every((c) => c.ok)).toBe(true);
    expect(dor.find((c) => c.key === "budget")?.evidence).toContain("60min");
    expect(dor.find((c) => c.key === "three-questions")?.evidence).toContain("三问");
  });

  it("missing items report ok:false with null evidence (skeleton budget = missing)", () => {
    const dor = dorChecklist(STRIPPED_DOR_BODY);
    expect(dor.filter((c) => !c.ok).map((c) => c.key)).toEqual(["anchors", "precedent"]);
    expect(dor.find((c) => c.key === "anchors")?.evidence).toBeNull();
    const noBudget = dorChecklist("三问：有\n验收：有\n锚点：bb:x\n往例：有");
    expect(noBudget.find((c) => c.key === "budget")?.ok).toBe(false);
  });
});

describe("AP.lane (runGit seam — zero filesystem side effects)", () => {
  afterEach(() => {
    _inject(null);
  });

  it("refuses on missing DoR items with zero side effects, even on confirm", () => {
    const rep = lane(laneTicket({ body: STRIPPED_DOR_BODY }), {}, { confirm: true });
    expect(rep.refused).toBe(true);
    expect(rep.ok).toBe(false);
    expect(rep.spawn).toBeNull(); // a refused ticket never yields a spawn packet
    expect(rep.worktreeCreated).toBe(false);
    const reasons = rep.refusalReasons.join(" ");
    expect(reasons).toContain("③上游锚点");
    expect(reasons).toContain("⑤参照往例");
  });

  it("refuses tickets that fail the board predicate even with a full DoR", () => {
    const backlog = lane(laneTicket({ status: "Backlog" }), {}, { confirm: true });
    expect(backlog.refused).toBe(true);
    expect(backlog.refusalReasons[0]).toContain("board predicate");
    const blocked = lane(
      laneTicket({ blockedBy: [{ number: 9, state: "OPEN", title: "open blocker" }] }),
      {},
      { confirm: true },
    );
    expect(blocked.refused).toBe(true);
  });

  it("dry-run pass: full plan + isolated spawn packet, no worktree created", () => {
    const rep = lane(laneTicket());
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

  it("confirm: provisions the worktree through the git seam with herdr-path naming", () => {
    const gitCalls: { args: string[]; cwd: string }[] = [];
    _inject({
      runGit: (args, cwd) => {
        gitCalls.push({ args, cwd });
        return "";
      },
    });
    const rep = lane(
      laneTicket(),
      { agent: "task", context: "# Contract\nshared interfaces" },
      { confirm: true },
    );
    expect(rep.ok).toBe(true);
    expect(rep.worktreeCreated).toBe(true);
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

  it("confirm: git failure surfaces as an explicit error without a spawn lie", () => {
    _inject({
      runGit: () => {
        throw new Error("fatal: a branch named 'lane/200-feat-demo-lane' already exists");
      },
    });
    const rep = lane(laneTicket(), {}, { confirm: true });
    expect(rep.ok).toBe(false);
    expect(rep.worktreeCreated).toBe(false);
    expect(rep.errors[0]).toContain("git worktree add failed");
    expect(rep.errors[0]).toContain("already exists");
  });
});
