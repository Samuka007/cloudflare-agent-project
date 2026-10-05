/**
 * mock-board.ts — the in-memory GitHub board shared by the pm-harness L1
 * suites (#270: extracted from core.test.ts so the new tools.test.ts drives
 * the five custom tools against the SAME fake board the core tests use —
 * one fixture, lockstep behavior).
 *
 * Zero network: the board executes the very mutations the autopilot issues,
 * so the guarded apply → per-batch re-verify loop runs end-to-end against
 * evolving state.
 */

import type { GqlFn, Ticket } from "../../src/core.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const STATUS_FIELD_ID = "F_status";
export const PRIORITY_FIELD_ID = "F_priority";
export const STATUS_OPTIONS: Record<string, string> = Object.fromEntries(
  ["Backlog", "Todo", "In Progress", "Wait for user", "Done", "Canceled"].map((n) => [
    n,
    `opt_${n.replaceAll(" ", "_")}`,
  ]),
);
export const PRIORITY_OPTIONS: Record<string, string> = { P0: "opt_P0", P1: "opt_P1", P2: "opt_P2" };
export const LABEL_IDS: Record<string, string> = {
  "block:agent-harness": "L_harness",
  "block:bb-ux": "L_bbux",
  "ready-for-human": "L_rfh",
  "type:implementation": "L_impl",
};

export interface IssueRow {
  id: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  bodyText: string | null;
  updatedAt: string;
  milestone: { title: string } | null;
  labels: { nodes: { name: string }[] };
  blockedBy: { nodes: { number: number; state: "OPEN" | "CLOSED"; title: string }[] };
}

export interface ItemRow {
  itemId: string;
  issueNumber: number;
  status: string | null;
  priority: string | null;
}

export class MockBoard {
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
      updatedAt: "2026-01-01T00:00:00Z",
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
        updatedAt: i.updatedAt,
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
          updatedAt: "2026-01-01T00:00:00Z",
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
        return {
          createIssue: { issue: { id: row.id, number, url: `https://example.invalid/${number}` } },
        };
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