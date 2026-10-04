/**
 * scripts/pm-autopilot.ts — #131 PM autopilot: the eval-resident board-keeper.
 *
 * README
 * ======
 * `%load`-able TypeScript module for the eval JS kernel. Stateless-reentrant:
 * the GitHub board is the only truth; every entry point re-derives everything
 * from the board in a single paginated pass and keeps zero kernel-resident
 * state. The dispatchable predicate and cascade scheduling rules are
 * transliterated from docs/agents/tracker-schema.md (the declarative schema
 * board truth — predicates are copied, not reinvented).
 *
 * Usage (eval session, JS kernel, from the repo root):
 *
 *     %load "scripts/pm-autopilot.ts"
 *     // → installs globalThis.AP (also exported as a named export for vitest)
 *
 * One full PM turn (dispatch):
 *
 *     const snap = await AP.snapshot();                 // board + open issues, one pass
 *     const due = AP.dispatchable(snap);                // pure predicate over the snapshot
 *     const packets = AP.dispatchPackets(due, snap);    // herdr worktree cmd + lane context + budget
 *     // hand each packet to a lane (herdr/task); then mark the wave In Progress:
 *     await AP.apply(due.map((t) => ({ op: "setStatus", number: t.number, value: "In Progress" })));
 *     // ^ DRY-RUN default: prints the preflight diff, writes nothing.
 *     await AP.apply(<same mutations>, { confirm: true }); // guarded batched writes
 *
 * Delivery hook (a ticket closed):
 *
 *     await AP.cascade(92);            // dry-run: prints unlocks + Backlog→Todo callbacks
 *     await AP.cascade(92, { confirm: true });
 *
 * Ticket filing (#151) — intake-classified creation, the inverse of cascade:
 *
 *     await AP.file({ title, body, blockedBy: [150] });
 *                                      // dry-run: full plan preview, zero writes.
 *                                      // jev classifies; dims <0.8 confidence are
 *                                      // demoted to the pmReview list, never applied.
 *     await AP.file(<same spec>, { confirm: true });
 *                                      // creates the issue GraphQL-only (REST create
 *                                      // auto-creates unknown labels — invariant 5);
 *                                      // unregistered label ⇒ hard fail, zero writes.
 *
 * Raw-ticket intake (judge-classified via the REAL jev model — #131
 * CRITICAL: the judge layer is a real API call, not the kernel judge):
 *
 *     await AP.intake(body);           // → { milestone, block, type, priority,
 *                                      //      dor_evidence, needs_probe, needs_human,
 *                                      //      confidence, gate }
 *     // gate: ≥0.8 auto-apply · 0.5–0.8 PM review · <0.5 needs-human
 *
 * Config: PM_REPO (default "Samuka007/cloudflare-agent-project"),
 * PM_PROJECT_ID (default "PVT_kwHOAvgCqs4Blk19" — GraphQL id verified
 * 2026-10-03, same constant as .github/workflows/project-board-sync.yml).
 * Token: GH_TOKEN env, else `gh auth token`. Judge key: JEV_API_KEY process
 * env, else the gitignored .env.local at the repo root — NEVER committed;
 * L1 tests mock the judge via fetch injection and the real-call smoke skips
 * itself without a key. Field/option ids are ALWAYS
 * resolved at runtime from the live project — never hardcoded (BoardSmith
 * invariant: option-replacement class ops are banned outright).
 *
 * Hard rules encoded here: writes only via AP.apply's guarded path (preflight
 * diff → batch → per-batch re-verify → abort on drift); closed-state Statuses
 * (Done/Canceled) are event-derived and rejected as PM targets; unknown
 * labels/milestones/statuses are preflight errors (closed vocabulary,
 * tracker-schema.md invariant 3).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IssueState = "OPEN" | "CLOSED";

/** Closed vocabulary — tracker-schema.md Status axis (sync-derived names). */
export const STATUS_OPTIONS = [
  "Backlog",
  "Todo",
  "In Progress",
  "Wait for user",
  "Done",
  "Canceled",
] as const;
export type StatusName = (typeof STATUS_OPTIONS)[number];

/** Closed vocabulary — Priority field, three tiers (p3 abolished). */
export const PRIORITY_OPTIONS = ["P0", "P1", "P2"] as const;
export type PriorityName = (typeof PRIORITY_OPTIONS)[number];

export interface BlockerEdge {
  number: number;
  state: IssueState;
  title: string;
}

export interface Ticket {
  /** Issue number. */
  number: number;
  /** Issue GraphQL node id (for updateIssue / addBlockedBy / addLabels). */
  id: string;
  title: string;
  body: string;
  state: IssueState;
  /** Milestone title (phase axis truth source), null when unscheduled. */
  milestone: string | null;
  labels: string[];
  /** Native dependency edges pointing INTO this ticket (what blocks it). */
  blockedBy: BlockerEdge[];
  /** ProjectV2Item id; null = not boarded yet (sync boards on events). */
  itemId: string | null;
  status: StatusName | null;
  priority: PriorityName | null;
}

export interface Snapshot {
  projectId: string;
  repo: string;
  tickets: Ticket[];
  /** true when either pagination leg hit its guard ceiling. */
  truncated: boolean;
}

export type Mutation =
  | { op: "setStatus"; number: number; value: StatusName }
  | { op: "setPriority"; number: number; value: PriorityName }
  /** Milestone title; explicit null clears (explicit input only — the
   *  workflow's "no-input → clear" ban does not apply to PM intent). */
  | { op: "setMilestone"; number: number; value: string | null }
  /** `number` becomes blocked by `blocker`. */
  | { op: "addBlockedBy"; number: number; blocker: number }
  | { op: "addLabels"; number: number; labels: string[] };

export interface PlannedChange {
  mutation: Mutation;
  kind: "change" | "no-op";
  field: string;
  from: string | null;
  to: string;
  /** Side-effect note (workflow interplay, axis separation) when present. */
  sideEffect?: string;
}

export interface PreflightReport {
  /** Executable, pre-resolved operations (no-op / error entries excluded). */
  ops: ResolvedOp[];
  willChange: PlannedChange[];
  noOps: PlannedChange[];
  /** Non-fatal workflow/axis interplay notes per ticket. */
  sideEffects: { number: number; note: string }[];
  errors: string[];
}

/** Fully-resolved write op — ids resolved at preflight, never at guess time. */
export type ResolvedOp =
  | { kind: "addProjectItem"; number: number; issueNodeId: string }
  | {
      kind: "setStatus" | "setPriority";
      number: number;
      itemId: string;
      fieldId: string;
      optionId: string;
      value: string;
    }
  | {
      kind: "setMilestone";
      number: number;
      issueNodeId: string;
      milestoneId: string | null;
      value: string | null;
    }
  | {
      kind: "addBlockedBy";
      number: number;
      issueNodeId: string;
      blocker: number;
      blockerNodeId: string;
    }
  | {
      kind: "addLabels";
      number: number;
      issueNodeId: string;
      labels: string[];
      labelIds: string[];
    };

export interface ApplyReport {
  ok: boolean;
  dryRun: boolean;
  preflight: PreflightReport;
  /** Batches actually applied (empty on dry-run). */
  appliedBatches: number[][];
  verified: boolean;
  /** Set when per-batch re-verify found drift; remaining batches withheld. */
  verifyFailure?: { batch: number[][]; detail: string };
  errors: string[];
}

export interface CascadeReport {
  closedNumber: number;
  /** Open tickets whose edge to closedNumber resolved (no open blockers left). */
  unblocked: number[];
  /** Open tickets flipped Backlog → Todo by the scheduling callback. */
  flippedToTodo: number[];
  /** Dispatchable-set delta induced by the close (numbers added). */
  dispatchableDelta: number[];
  dryRun: boolean;
  apply?: ApplyReport;
}

export interface WorktreePlan {
  branch: string;
  /** Deterministic herdr path: ~/.herdr/worktrees/<repo>/<branch-as-dash>. */
  path: string;
  /** PM's pre-create command (pm.md 派单 clause, verbatim flags). */
  command: string;
}

export interface DispatchPacket {
  number: number;
  title: string;
  worktree: WorktreePlan;
  /** Full lane context template assembled from the ticket body + board facts. */
  context: string;
  /** Budget line from the body, or the skeleton when the ticket lacks one. */
  budget: { source: "body" | "skeleton"; line: string };
}

export interface IntakeResult {
  milestone: "M0" | "M1" | "M2" | "M3" | "none" | null;
  block:
    "block:bb-ux" | "block:agent-content" | "block:agent-harness" | "scope:infra" | "none" | null;
  type: "type:implementation" | "type:research" | "type:decision" | null;
  priority: PriorityName | null;
  dor_evidence: "probe" | "anchors" | "none" | null;
  needs_probe: boolean;
  needs_human: boolean;
  /** Per-question confidence 0..1 (noul: confidence in the polarity). */
  confidence: {
    milestone: number;
    block: number;
    type: number;
    priority: number;
    dor_evidence: number;
    needs_probe: number;
    needs_human: number;
  };
  /** Weakest-link verdict over all seven questions (gateOf of the min). */
  gate: GateAction;
  /** Judge model version as reported by the service (e.g. "jev-1.13.0"). */
  judgeModel?: string;
}

// ---------------------------------------------------------------------------
// Config + transport (injectable for tests; kernel globals at runtime)
// ---------------------------------------------------------------------------

export const REPO = process.env.PM_REPO ?? "Samuka007/cloudflare-agent-project";
export const PROJECT_ID = process.env.PM_PROJECT_ID ?? "PVT_kwHOAvgCqs4Blk19";

export type GqlFn = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
export type FetchFn = typeof fetch;

/** One judge answer: choice (value + confidence) or noul (belief in true). */
export interface JudgeAnswer {
  type?: string;
  choice?: string;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JudgeReply {
  answers: Record<string, JudgeAnswer>;
  /** Judge model version as reported by the service (e.g. "jev-1.13.0"). */
  model?: string;
}

export type JudgeFn = (state: unknown, questions: Record<string, unknown>) => Promise<JudgeReply>;

export interface APDeps {
  gql: GqlFn;
  judge?: JudgeFn;
  /** Transport seam — L1 tests inject a canned jev fetch (never hit the wire). */
  fetch?: FetchFn;
}

let injected: Partial<APDeps> | null = null;

/** Test seam: swap the transport. Pass null to restore defaults. */
export function _inject(deps: Partial<APDeps> | null): void {
  injected = deps;
}

function resolveToken(): string {
  const fromEnv = process.env.GH_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

const defaultGql: GqlFn = async (query, variables) => {
  const token = resolveToken();
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "pm-autopilot (#131)",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`GraphQL transport ${String(response.status)}: ${await response.text()}`);
  }
  const payload = (await response.json()) as {
    data?: Record<string, unknown> | null;
    errors?: { message: string }[];
  };
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  if (payload.data === undefined || payload.data === null) {
    throw new Error("GraphQL response carried neither data nor errors");
  }
  return payload.data;
};

function gql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const fn = injected?.gql ?? defaultGql;
  return fn(query, variables);
}

/** JEV_API_KEY: process env first, then the gitignored .env.local (cwd, then
 *  walking up from this module, ≤5 levels). Returns null when absent — the
 *  key NEVER enters git. */
export function resolveJeapiKey(): string | null {
  const fromEnv = process.env.JEV_API_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const candidates: string[] = [`${process.cwd()}/.env.local`];
  const meta = import.meta as { dir?: string; url?: string };
  let dir =
    typeof meta.dir === "string"
      ? meta.dir
      : typeof meta.url === "string"
        ? dirname(fileURLToPath(meta.url))
        : null;
  for (let i = 0; dir !== null && i < 5; i += 1) {
    candidates.push(`${dir}/.env.local`);
    dir = dirname(dir);
  }
  for (const path of candidates) {
    try {
      const value = /^JEV_API_KEY=(.+)$/m.exec(readFileSync(path, "utf8"))?.[1]?.trim();
      if (value !== undefined && value.length > 0) return value;
    } catch {
      // absent at this level — keep walking
    }
  }
  return null;
}

/** jev judge constants (#131 CRITICAL: judge layer = real model). */
export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** Real-model judge transport: one POST per intake; per-answer confidence is
 *  the raw material for the gate. Test seam = fetch injection. */
export const defaultJudge: JudgeFn = async (state, questions) => {
  const key = resolveJeapiKey();
  if (key === null) {
    throw new Error("jev judge: no JEV_API_KEY (process env or gitignored .env.local)");
  }
  const response = await (injected?.fetch ?? globalThis.fetch)(JEV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ state, model: JEV_MODEL, questions }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`jev judge ${String(response.status)}: ${await response.text()}`);
  }
  const payload = (await response.json()) as { answers?: unknown; model?: unknown };
  if (payload.answers === undefined || typeof payload.answers !== "object") {
    throw new Error("jev judge: response carried no answers object");
  }
  return {
    answers: payload.answers as Record<string, JudgeAnswer>,
    model: typeof payload.model === "string" ? payload.model : undefined,
  };
};

// ---------------------------------------------------------------------------
// GraphQL documents — recorded request templates (known-good shapes; the
// project patterns are verbatim from .github/workflows/project-board-sync.yml)
// ---------------------------------------------------------------------------

/** Docs/templates the L1 suite asserts issued calls against. */
export const TEMPLATES = {
  snapshot: `query($id: ID!, $owner: String!, $repo: String!, $itemCursor: String, $issueCursor: String) {
  project: node(id: $id) { ... on ProjectV2 {
    items(first: 100, after: $itemCursor) { pageInfo { hasNextPage endCursor }
      nodes { id
        status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        content { __typename ... on Issue {
          id number title state bodyText
          milestone { title }
          labels(first: 50) { nodes { name } }
          blockedBy(first: 50) { nodes { number state title } }
        } }
      } } } }
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 100, after: $issueCursor) { pageInfo { hasNextPage endCursor }
      nodes { id number title state bodyText
        milestone { title }
        labels(first: 50) { nodes { name } }
        blockedBy(first: 50) { nodes { number state title } }
      } } }
}`,
  fields: `query($id: ID!) { node(id: $id) { ... on ProjectV2 {
  fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
} } }`,
  addProjectItem: `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`,
  setSingleSelect: `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}`,
  setMilestone: `mutation($id: ID!, $milestoneId: ID) {
  updateIssue(input: { id: $id, milestoneId: $milestoneId }) { issue { number } }
}`,
  addBlockedBy: `mutation($issueId: ID!, $blockingIssueId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { number } }
}`,
  addLabels: `mutation($labelableId: ID!, $labelIds: [ID!]) {
  addLabelsToLabelable(input: { labelableId: $labelableId, labelIds: $labelIds }) { labelable { ... on Issue { number } } }
}`,
  /** #151: issue creation is GraphQL-only. CreateIssueInput carries no
   *  labels at all, so creation can never trigger the REST auto-create-label
   *  path (invariant 5); labels land afterwards via addLabels with
   *  pre-resolved ids. */
  createIssue: `mutation($repositoryId: ID!, $title: String!, $body: String!, $milestoneId: ID) {
  createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body, milestoneId: $milestoneId }) { issue { id number url } }
}`,
  /** #151 filing preflight: repository id + the FULL registered label
   *  vocabulary (paginated) + the open milestone title → { id, number } map
   *  — the number mapping is resolved at runtime, never hardcoded. */
  repoVocabulary: `query($owner: String!, $repo: String!, $labelCursor: String) {
  repository(owner: $owner, name: $repo) {
    id
    labels(first: 100, after: $labelCursor) { pageInfo { hasNextPage endCursor }
      nodes { id name } }
    milestones(first: 50, states: OPEN) { nodes { id number title } }
  }
}`,
} as const;

const ISSUE_FIELDS = `number
  milestone { title }
  labels(first: 50) { nodes { name } }
  blockedBy(first: 50) { nodes { number state } }
  projectItems(first: 10) { nodes { id project { id }
    status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  } }`;

/** Builds the per-batch verification query (aliased issue reads). */
function verifyQuery(numbers: number[]): { query: string; aliases: string[] } {
  const aliases = numbers.map((n) => `i${n}`);
  const body = numbers
    .map((n, i) => `    ${aliases[i]}: issue(number: ${n}) { ${ISSUE_FIELDS} }`)
    .join("\n");
  const query = `query($owner: String!, $repo: String!) {\n  repository(owner: $owner, name: $repo) {\n${body}\n  }\n}`;
  return { query, aliases };
}

interface RawIssueNode {
  id: string;
  number: number;
  title: string;
  state: IssueState;
  bodyText: string | null;
  milestone: { title: string } | null;
  labels: { nodes: { name: string }[] | null } | null;
  blockedBy: { nodes: { number: number; state: IssueState; title: string }[] | null } | null;
}

interface RawBoardItem {
  id: string;
  status: { name: string } | null;
  priority: { name: string } | null;
  content: ({ __typename: string } & Partial<RawIssueNode>) | null;
}

// ---------------------------------------------------------------------------
// Pure core — predicate, diff, cascade, packets (transliterated from
// docs/agents/tracker-schema.md; no I/O, fully unit-testable)
// ---------------------------------------------------------------------------

/** Dispatchable = open ∧ Status=Todo ∧ 无未关 blocking 边 ∧ ¬ready-for-human. */
export function dispatchable(snap: Pick<Snapshot, "tickets">): Ticket[] {
  return snap.tickets.filter(
    (t) =>
      t.state === "OPEN" &&
      t.status === "Todo" &&
      !t.labels.includes("ready-for-human") &&
      t.blockedBy.every((b) => b.state !== "OPEN"),
  );
}

/** Slug for branch/worktree names; ASCII-folded, falls back to the number. */
export function slugify(title: string, number: number): string {
  const folded = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return folded.length > 0 ? folded : `ticket-${number}`;
}

// No /g: exec advances lastIndex across calls on a shared /g regex, which
// silently drops the budget of every packet after the first match.
const BUDGET_PATTERN =
  /^\s*(?:[-*]\s*)?(?:.*(?:预算|budget|wall\s*时钟|墙钟|efficienc)\s*[：:].*)$/im;

function budgetOf(body: string): { source: "body" | "skeleton"; line: string } {
  const matched = BUDGET_PATTERN.exec(body)?.[0];
  if (matched) {
    return { source: "body", line: matched.trim() };
  }
  return {
    source: "skeleton",
    line: "预算行缺失（DoR ⑤ 未过）：墙钟 ≤ __min；资源上限 __；等待方式：交付即回（超 50% 须解释）",
  };
}

const REPO_DIR = REPO.split("/")[1] ?? REPO;

/** Lane context template + herdr worktree pre-create command per ticket. */
export function dispatchPackets(tickets: Ticket[], _snapshot?: Snapshot): DispatchPacket[] {
  return tickets.map((t) => {
    const slug = `${t.number}-${slugify(t.title, t.number)}`;
    const branch = `lane/${slug}`;
    const path = `~/.herdr/worktrees/${REPO_DIR}/${branch.replaceAll("/", "-")}`;
    const command = `herdr worktree create --cwd <repo> --branch ${branch} --base origin/main --label ${slug} --no-focus`;
    const budget = budgetOf(t.body);
    const openBlockers = t.blockedBy.filter((b) => b.state === "OPEN");
    const context = [
      `# Goal`,
      `${t.title} (#${t.number})`,
      ``,
      `# Ticket body (source of truth for scope/acceptance)`,
      t.body.trim().length > 0 ? t.body.trim() : "(empty body — bounce back to PM, DoR ①③ unmet)",
      ``,
      `# Board facts`,
      `milestone: ${t.milestone ?? "none"} · priority: ${t.priority ?? "unset"} · status: ${t.status ?? "unboarded"}`,
      `labels: ${t.labels.length > 0 ? t.labels.join(", ") : "none"}`,
      `open blockers: ${
        openBlockers.length > 0
          ? openBlockers.map((b) => `#${b.number} ${b.title}`).join("; ")
          : "none"
      }`,
      ``,
      `# Worktree (PM pre-creates; lane never touches the main checkout)`,
      command,
      `cd ${path}`,
      ``,
      `# Branch discipline`,
      `push only ${branch}; PR to origin/main; never push main.`,
      ``,
      `# Budget`,
      budget.line,
      ``,
      `# Report (close-out evidence)`,
      `commit hash · CI run link · test count · file:line root cause (bug tickets)`,
    ].join("\n");
    return {
      number: t.number,
      title: t.title,
      worktree: { branch, path, command },
      context,
      budget,
    };
  });
}

interface PlanInput {
  tickets: Ticket[];
  /** name → optionId for Status and Priority single-select fields. */
  statusOptions: Record<string, string>;
  priorityOptions: Record<string, string>;
  statusFieldId: string;
  priorityFieldId: string;
  /** Milestone title → id (open milestones). */
  milestones: Record<string, string>;
  /** Label name → id (only existing labels; closed vocabulary). */
  labels: Record<string, string>;
  /** Extra issue node ids not present in tickets (e.g. closed blockers). */
  extraIssueIds?: Record<number, string>;
}

interface Resolution {
  ops: ResolvedOp[];
  willChange: PlannedChange[];
  noOps: PlannedChange[];
  sideEffects: { number: number; note: string }[];
  errors: string[];
}

const SIDE_EFFECT_NOTES = {
  inProgress:
    "Status=In Progress is PM-owned; project-board-sync's guard keeps it against later label/milestone events.",
  derivedStatus:
    "Status is sync-derived on the next issue event (open+milestone→Todo, milestone-less→Backlog); milestone and Status intent must agree.",
  closedStatus: "Done/Canceled are close-event derived; PM never targets them directly.",
  readyForHuman:
    "ready-for-human → Wait for user derivation on the next labeled event (user queue).",
  blockedAxisOnly:
    "Blocking lives on the dependency axis only — no Status write accompanies an edge (轴分离, tracker-schema 2026-10-04).",
  priorityFieldTruth:
    "Priority field is the sole importance truth (no label twin); workflow never writes it.",
} as const;

function planStatusOrPriority(
  mutation: Extract<Mutation, { op: "setStatus" | "setPriority" }>,
  input: PlanInput,
  ticket: Ticket,
  res: Resolution,
): void {
  const isStatus = mutation.op === "setStatus";
  if (isStatus && (mutation.value === "Done" || mutation.value === "Canceled")) {
    res.errors.push(
      `#${mutation.number}: setStatus ${mutation.value} rejected — close-event derived (${SIDE_EFFECT_NOTES.closedStatus})`,
    );
    return;
  }
  const fieldId = isStatus ? input.statusFieldId : input.priorityFieldId;
  const optionMap = isStatus ? input.statusOptions : input.priorityOptions;
  const optionId = optionMap[mutation.value];
  if (optionId === undefined) {
    res.errors.push(
      `#${mutation.number}: ${mutation.op} "${mutation.value}" not in closed vocabulary ${Object.keys(optionMap).join("/")}`,
    );
    return;
  }
  const from = isStatus ? ticket.status : ticket.priority;
  if (ticket.itemId === null) {
    res.ops.push({ kind: "addProjectItem", number: ticket.number, issueNodeId: ticket.id });
  }
  const itemId = ticket.itemId ?? "PENDING_BOARD";
  res.willChange.push({
    mutation,
    kind: from === mutation.value ? "no-op" : "change",
    field: isStatus ? "Status" : "Priority",
    from,
    to: mutation.value,
    sideEffect: isStatus
      ? mutation.value === "In Progress"
        ? SIDE_EFFECT_NOTES.inProgress
        : SIDE_EFFECT_NOTES.derivedStatus
      : SIDE_EFFECT_NOTES.priorityFieldTruth,
  });
  if (from !== mutation.value) {
    res.ops.push({
      kind: mutation.op,
      number: ticket.number,
      itemId,
      fieldId,
      optionId,
      value: mutation.value,
    });
  }
}

/** Pure preflight diff + op resolution. Errors never produce ops. */
export function planDiff(mutations: readonly Mutation[], input: PlanInput): Resolution {
  const res: Resolution = { ops: [], willChange: [], noOps: [], sideEffects: [], errors: [] };
  const byNumber = new Map(input.tickets.map((t) => [t.number, t]));

  for (const mutation of mutations) {
    const ticket = byNumber.get(mutation.number);
    if (ticket === undefined) {
      res.errors.push(`#${mutation.number}: ticket not found in snapshot`);
      continue;
    }
    if (ticket.state === "CLOSED") {
      res.errors.push(
        `#${mutation.number}: ticket is CLOSED — board writes target open tickets only`,
      );
      continue;
    }

    switch (mutation.op) {
      case "setStatus":
      case "setPriority": {
        planStatusOrPriority(mutation, input, ticket, res);
        break;
      }
      case "setMilestone": {
        const from = ticket.milestone;
        let milestoneId: string | null = null;
        if (mutation.value !== null) {
          const id = input.milestones[mutation.value];
          if (id === undefined) {
            res.errors.push(
              `#${mutation.number}: milestone "${mutation.value}" not found among open milestones (closed vocabulary)`,
            );
            break;
          }
          milestoneId = id;
        }
        res.willChange.push({
          mutation,
          kind: from === mutation.value ? "no-op" : "change",
          field: "Milestone",
          from,
          to: mutation.value ?? "(none)",
          sideEffect: SIDE_EFFECT_NOTES.derivedStatus,
        });
        if (from !== mutation.value) {
          res.ops.push({
            kind: "setMilestone",
            number: ticket.number,
            issueNodeId: ticket.id,
            milestoneId,
            value: mutation.value,
          });
        }
        break;
      }
      case "addBlockedBy": {
        if (mutation.blocker === mutation.number) {
          res.errors.push(`#${mutation.number}: self-blocking edge rejected`);
          break;
        }
        const already = ticket.blockedBy.some((b) => b.number === mutation.blocker);
        if (already) {
          res.noOps.push({
            mutation,
            kind: "no-op",
            field: "blockedBy",
            from: `#${mutation.blocker}`,
            to: `#${mutation.blocker}`,
          });
          break;
        }
        const blockerTicket = byNumber.get(mutation.blocker);
        const blockerNodeId = blockerTicket?.id ?? input.extraIssueIds?.[mutation.blocker];
        if (blockerNodeId === undefined) {
          res.errors.push(
            `#${mutation.blocker}: blocker not found in snapshot/refs — resolve its node id first`,
          );
          break;
        }
        res.willChange.push({
          mutation,
          kind: "change",
          field: "blockedBy",
          from: null,
          to: `#${mutation.blocker}`,
          sideEffect: SIDE_EFFECT_NOTES.blockedAxisOnly,
        });
        res.ops.push({
          kind: "addBlockedBy",
          number: ticket.number,
          issueNodeId: ticket.id,
          blocker: mutation.blocker,
          blockerNodeId,
        });
        break;
      }
      case "addLabels": {
        if (mutation.labels.length === 0) {
          res.noOps.push({
            mutation,
            kind: "no-op",
            field: "labels",
            from: null,
            to: "(empty)",
          });
          break;
        }
        const missing = mutation.labels.filter((l) => input.labels[l] === undefined);
        if (missing.length > 0) {
          res.errors.push(
            `#${mutation.number}: labels ${missing.join(", ")} not in repository vocabulary — add to tracker-schema.md first (invariant 3)`,
          );
          break;
        }
        const fresh = mutation.labels.filter((l) => !ticket.labels.includes(l));
        if (mutation.labels.includes("ready-for-human")) {
          res.sideEffects.push({ number: ticket.number, note: SIDE_EFFECT_NOTES.readyForHuman });
        }
        if (fresh.length === 0) {
          res.noOps.push({
            mutation,
            kind: "no-op",
            field: "labels",
            from: mutation.labels.join(","),
            to: mutation.labels.join(","),
          });
          break;
        }
        res.willChange.push({
          mutation,
          kind: "change",
          field: "labels",
          from: null,
          to: fresh.join(", "),
        });
        const labelIds: string[] = [];
        for (const l of fresh) {
          const labelId = input.labels[l];
          if (labelId === undefined) {
            throw new Error(`#${ticket.number}: label ${l} lost between check and resolve`);
          }
          labelIds.push(labelId);
        }
        res.ops.push({
          kind: "addLabels",
          number: ticket.number,
          issueNodeId: ticket.id,
          labels: fresh,
          labelIds,
        });
        break;
      }
    }
  }
  return res;
}

/** Cascade plan: pure. closeNumber just closed — what unlocks, what flips. */
export function planCascade(
  snap: Pick<Snapshot, "tickets">,
  closedNumber: number,
): { unblocked: number[]; flips: Mutation[]; dispatchableDelta: number[] } {
  const before = new Set(dispatchable(snap).map((t) => t.number));
  const unblockedTickets = snap.tickets.filter(
    (t) =>
      t.state === "OPEN" &&
      t.blockedBy.some((b) => b.number === closedNumber) &&
      t.blockedBy.every((b) => b.number === closedNumber || b.state !== "OPEN"),
  );
  const flips: Mutation[] = unblockedTickets
    .filter((t) => t.status === "Backlog")
    .map((t) => ({ op: "setStatus", number: t.number, value: "Todo" }) as const);
  const flippedNumbers = new Set(flips.map((f) => f.number));
  // The snapshot predates the close event landing on the board, so the
  // after-set must SIMULATE it: the edge into closedNumber reads CLOSED.
  const afterTickets = snap.tickets.map((t) =>
    flippedNumbers.has(t.number) || t.blockedBy.some((b) => b.number === closedNumber)
      ? {
          ...t,
          status: flippedNumbers.has(t.number) ? ("Todo" as const) : t.status,
          blockedBy: t.blockedBy.map((b) =>
            b.number === closedNumber ? { ...b, state: "CLOSED" as const } : b,
          ),
        }
      : t,
  );
  const after = new Set(dispatchable({ tickets: afterTickets }).map((t) => t.number));
  const dispatchableDelta = [...after].filter((n) => !before.has(n)).sort((a, b) => a - b);
  return {
    unblocked: unblockedTickets.map((t) => t.number).sort((a, b) => a - b),
    flips,
    dispatchableDelta,
  };
}

// ---------------------------------------------------------------------------
// Filing (#151): intake → create → closed-vocab labels → fields → edges → status
// ---------------------------------------------------------------------------

/** Confidence floor for auto-applying a classified dimension at filing time
 *  (gateOf's auto-apply threshold, applied per-dimension). */
export const FILE_CONFIDENCE_FLOOR = 0.8;

/** Raw filing request. Everything else derives from intake or resolves live
 *  — the caller never supplies labels/fields (that is how vocabulary drifts). */
export interface FileSpec {
  title: string;
  body: string;
  /** Issue numbers the new ticket is blocked by (dependency axis only). */
  blockedBy?: number[];
}

/** The complete write plan for one filing — every value board-truth. */
export interface FilePlan {
  /** Derived labels, ALL registered in the repository vocabulary. */
  labels: string[];
  /** Milestone title; the id is resolved live for the write, the number for
   *  the report (title → { id, number } map — runtime-resolved, never
   *  hardcoded). */
  milestone: string | null;
  milestoneNumber: number | null;
  priority: PriorityName | null;
  /** Wave scheduling: needs_human → Wait for user (ready-for-human
   *  derivation) · scheduled → Todo · unscheduled → Backlog — mirrors the
   *  sync derivation so milestone and Status intent agree. */
  status: StatusName;
  blockedBy: number[];
}

export type FileDimension =
  | "milestone"
  | "block"
  | "type"
  | "priority"
  | "needs_probe"
  | "needs_human";

/** A classified dimension below the confidence floor: PM re-rules it. */
export interface FileReviewItem {
  dimension: FileDimension;
  suggested: string | null;
  confidence: number;
}

export interface FileReport {
  ok: boolean;
  dryRun: boolean;
  /** Raw judge verdict the plan was derived from (audit trail). */
  intake: IntakeResult;
  plan: FilePlan;
  /** Dimensions below FILE_CONFIDENCE_FLOOR — suggested, never auto-applied. */
  pmReview: FileReviewItem[];
  errors: string[];
  /** Set only after a confirmed filing passed post-write verification. */
  created?: { number: number; id: string; url: string | null };
}

const FILE_DIMENSIONS = [
  "milestone",
  "block",
  "type",
  "priority",
  "needs_probe",
  "needs_human",
] as const satisfies readonly FileDimension[];

/**
 * Pure filing plan (no I/O): classified dimensions at/above the confidence
 * floor become writes; anything below lands in pmReview untouched — a
 * demoted dimension contributes NOTHING to the plan (its suggestion is
 * listed for PM re-ruling instead). Status follows the APPLIED plan only:
 * applied needs_human → Wait for user, else scheduled → Todo, else Backlog.
 */
export function planFile(
  spec: Pick<FileSpec, "blockedBy">,
  cls: IntakeResult,
): { plan: Omit<FilePlan, "milestoneNumber">; pmReview: FileReviewItem[] } {
  const confident = (d: FileDimension): boolean => cls.confidence[d] >= FILE_CONFIDENCE_FLOOR;
  const labels: string[] = [];
  if (cls.block !== null && cls.block !== "none" && confident("block")) labels.push(cls.block);
  if (cls.type !== null && confident("type")) labels.push(cls.type);
  if (cls.needs_human && confident("needs_human")) labels.push("ready-for-human");
  const milestone =
    cls.milestone !== null && cls.milestone !== "none" && confident("milestone")
      ? cls.milestone
      : null;
  const priority = cls.priority !== null && confident("priority") ? cls.priority : null;
  const status: StatusName =
    cls.needs_human && confident("needs_human") ? "Wait for user" : milestone !== null ? "Todo" : "Backlog";
  const suggestedOf = (d: FileDimension): string | null => {
    const v: unknown = cls[d];
    return typeof v === "string" ? v : typeof v === "boolean" ? String(v) : null;
  };
  const pmReview = FILE_DIMENSIONS.filter((d) => !confident(d)).map((d) => ({
    dimension: d,
    suggested: suggestedOf(d),
    confidence: cls.confidence[d],
  }));
  return {
    plan: {
      labels,
      milestone,
      priority,
      status,
      blockedBy: [...new Set(spec.blockedBy ?? [])].sort((a, b) => a - b),
    },
    pmReview,
  };
}

// ---------------------------------------------------------------------------
// Async surface — snapshot / preflight / apply / cascade / intake
// ---------------------------------------------------------------------------

/** Runtime type-guard: `v` is a member of the closed vocabulary. */
function inVocab<V extends readonly string[]>(xs: V, v: string): v is V[number] {
  return xs.includes(v);
}

/**
 * Runtime guard: a `{ name }` shape (board single-select value) → a closed-
 * vocabulary name, or null. Validates against the vocab BEFORE asserting, so
 * a drifted board can never smuggle an unknown Status/Priority through.
 */
function vocabNameOf<V extends readonly string[]>(value: unknown, vocab: V): V[number] | null {
  if (typeof value !== "object" || value === null || !("name" in value)) return null;
  const name: unknown = value.name;
  if (typeof name !== "string" || !inVocab(vocab, name)) return null;
  return name;
}

function rawToTicket(raw: RawIssueNode): Ticket {
  return {
    number: raw.number,
    id: raw.id,
    title: raw.title,
    body: raw.bodyText ?? "",
    state: raw.state,
    milestone: raw.milestone?.title ?? null,
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
    blockedBy: (raw.blockedBy?.nodes ?? []).map((b) => ({
      number: b.number,
      state: b.state,
      title: b.title,
    })),
    itemId: null,
    status: null,
    priority: null,
  };
}

/** Full board state in a single paginated pass (items + open issues). */
export async function snapshot(): Promise<Snapshot> {
  const tickets = new Map<number, Ticket>();
  let itemCursor: string | null = null;
  let issueCursor: string | null = null;
  let itemsDone = false;
  let issuesDone = false;
  let truncated = false;
  const MAX_PAGES = 20; // guard ceiling: 20 × 100 ≫ board size; flags truncation

  for (let page = 0; page < MAX_PAGES && !(itemsDone && issuesDone); page += 1) {
    const data = await gql(TEMPLATES.snapshot, {
      id: PROJECT_ID,
      owner: REPO.split("/")[0],
      repo: REPO_DIR,
      itemCursor,
      issueCursor,
    });
    const project = data.project as {
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RawBoardItem[];
      };
    } | null;
    if (project !== null) {
      for (const item of project.items.nodes) {
        const content = item.content;
        if (content?.__typename !== "Issue" || content.number === undefined) {
          continue;
        }
        const ticket = rawToTicket(content as RawIssueNode);
        ticket.itemId = item.id;
        ticket.status = vocabNameOf(item.status, STATUS_OPTIONS);
        ticket.priority = vocabNameOf(item.priority, PRIORITY_OPTIONS);
        tickets.set(ticket.number, ticket);
      }
      itemsDone = !project.items.pageInfo.hasNextPage;
      itemCursor = project.items.pageInfo.endCursor;
    } else {
      itemsDone = true;
    }
    const repository = data.repository as {
      issues: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RawIssueNode[];
      };
    } | null;
    if (repository !== null) {
      for (const raw of repository.issues.nodes) {
        if (!tickets.has(raw.number)) tickets.set(raw.number, rawToTicket(raw));
      }
      issuesDone = !repository.issues.pageInfo.hasNextPage;
      issueCursor = repository.issues.pageInfo.endCursor;
    } else {
      issuesDone = true;
    }
  }
  if (!(itemsDone && issuesDone)) truncated = true;

  return {
    projectId: PROJECT_ID,
    repo: REPO,
    tickets: [...tickets.values()].sort((a, b) => a.number - b.number),
    truncated,
  };
}

interface FieldsShape {
  fields: {
    nodes: ({ id: string; name: string; options: { id: string; name: string }[] } | null)[];
  };
}

/** Runtime field/option resolution — option ids are NEVER hardcoded. */
async function resolveSingleSelects(): Promise<{
  statusFieldId: string;
  priorityFieldId: string;
  statusOptions: Record<string, string>;
  priorityOptions: Record<string, string>;
}> {
  const data = await gql(TEMPLATES.fields, { id: PROJECT_ID });
  const nodes = (data.node as FieldsShape | null)?.fields.nodes.filter(Boolean) ?? [];
  const status = nodes.find((f) => f?.name === "Status");
  const priority = nodes.find((f) => f?.name === "Priority");
  if (status === undefined || status === null) throw new Error("Status field not found on project");
  if (priority === undefined || priority === null)
    throw new Error("Priority field not found on project");
  const toMap = (f: { options: { id: string; name: string }[] }): Record<string, string> =>
    Object.fromEntries(f.options.map((o) => [o.name, o.id]));
  return {
    statusFieldId: status.id,
    priorityFieldId: priority.id,
    statusOptions: toMap(status),
    priorityOptions: toMap(priority),
  };
}

interface RefsShape {
  repository: {
    issue: { id: string } | null;
    label: { id: string; name: string } | null;
    milestones: { nodes: { id: string; title: string }[] };
  } | null;
}

/**
 * Preflight (BoardSmith discipline): read current values → compute diff →
 * report willChange/noOps/sideEffects/errors with fully-resolved ops.
 * Resolve-only lookups (label/milestone/blocker ids) happen here so apply
 * never guesses.
 */
export async function preflight(mutations: readonly Mutation[]): Promise<PreflightReport> {
  const [snap, selects] = await Promise.all([snapshot(), resolveSingleSelects()]);

  // Resolution extras: labels vocabulary, milestones, blocker node ids.
  const needLabels = new Set(mutations.flatMap((m) => (m.op === "addLabels" ? m.labels : [])));
  const needBlockers = new Set(
    mutations.flatMap((m) => (m.op === "addBlockedBy" ? [m.blocker] : [])),
  );
  const snapshotNumbers = new Set(snap.tickets.map((t) => t.number));
  const unresolvedBlockers = [...needBlockers].filter((n) => !snapshotNumbers.has(n));

  const labels: Record<string, string> = {};
  for (const name of needLabels) {
    const data = await gql(
      `query($owner: String!, $repo: String!, $name: String!) { repository(owner: $owner, name: $repo) { label(name: $name) { id name } } }`,
      { owner: REPO.split("/")[0], repo: REPO_DIR, name },
    );
    const label = (data.repository as RefsShape["repository"])?.label;
    if (label !== null && label !== undefined) labels[label.name] = label.id;
  }

  let milestones: Record<string, string> = {};
  const extraIssueIds: Record<number, string> = {};
  const needsMilestones = mutations.some((m) => m.op === "setMilestone");
  if (needsMilestones || unresolvedBlockers.length > 0) {
    const data = await gql(
      `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { milestones(first: 50, states: OPEN) { nodes { id title } } } }`,
      { owner: REPO.split("/")[0], repo: REPO_DIR },
    );
    milestones = Object.fromEntries(
      ((data.repository as RefsShape["repository"])?.milestones.nodes ?? []).map((m) => [
        m.title,
        m.id,
      ]),
    );
  }
  for (const n of unresolvedBlockers) {
    const data = await gql(
      `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { id } } }`,
      { owner: REPO.split("/")[0], repo: REPO_DIR, number: n },
    );
    const id = (data.repository as RefsShape["repository"])?.issue?.id;
    if (typeof id === "string" && id !== "") extraIssueIds[n] = id;
  }

  const res = planDiff(mutations, {
    tickets: snap.tickets,
    ...selects,
    milestones,
    labels,
    extraIssueIds,
  });
  const sideEffects = res.willChange
    .filter((c): c is typeof c & { sideEffect: string } => c.sideEffect !== undefined)
    .map((c) => ({ number: c.mutation.number, note: c.sideEffect }));
  return { ...res, sideEffects: [...res.sideEffects, ...sideEffects] };
}

function batchOps(ops: readonly ResolvedOp[]): ResolvedOp[][] {
  // Board-adds first, then group the rest by ticket, cap batch size at 10.
  const boardAdds = ops.filter((o) => o.kind === "addProjectItem");
  const rest = ops.filter((o) => o.kind !== "addProjectItem");
  const byTicket = new Map<number, ResolvedOp[]>();
  for (const op of rest) {
    const list = byTicket.get(op.number) ?? [];
    list.push(op);
    byTicket.set(op.number, list);
  }
  const flat: ResolvedOp[][] = [];
  if (boardAdds.length > 0) flat.push(boardAdds);
  const groups = [...byTicket.values()];
  for (let i = 0; i < groups.length; i += 10) {
    flat.push(groups.slice(i, i + 10).flat());
  }
  return flat.filter((b) => b.length > 0);
}

/**
 * Executes one resolved op. Board-adds return the freshly-created ProjectV2
 * item id into `itemIds` — later same-ticket ops carry the PENDING_BOARD
 * sentinel (the id did not exist at preflight time) and substitute here.
 */
async function execOp(op: ResolvedOp, itemIds: Map<number, string>): Promise<void> {
  switch (op.kind) {
    case "addProjectItem": {
      const data = await gql(TEMPLATES.addProjectItem, {
        projectId: PROJECT_ID,
        contentId: op.issueNodeId,
      });
      const payload = data.addProjectV2ItemById;
      if (payload !== null && typeof payload === "object" && "item" in payload) {
        const item = payload.item;
        if (
          item !== null &&
          typeof item === "object" &&
          "id" in item &&
          typeof item.id === "string"
        ) {
          itemIds.set(op.number, item.id);
        }
      }
      return;
    }
    case "setStatus":
    case "setPriority": {
      const itemId = op.itemId === "PENDING_BOARD" ? itemIds.get(op.number) : op.itemId;
      if (itemId === undefined) {
        throw new Error(
          `#${op.number}: ${op.kind} without a board item — addProjectItem must run first`,
        );
      }
      await gql(TEMPLATES.setSingleSelect, {
        projectId: PROJECT_ID,
        itemId,
        fieldId: op.fieldId,
        optionId: op.optionId,
      });
      return;
    }
    case "setMilestone":
      await gql(TEMPLATES.setMilestone, { id: op.issueNodeId, milestoneId: op.milestoneId });
      return;
    case "addBlockedBy":
      await gql(TEMPLATES.addBlockedBy, {
        issueId: op.issueNodeId,
        blockingIssueId: op.blockerNodeId,
      });
      return;
    case "addLabels":
      await gql(TEMPLATES.addLabels, { labelableId: op.issueNodeId, labelIds: op.labelIds });
      return;
  }
}

interface VerifyIssue {
  milestone: { title: string } | null;
  labels: { nodes: { name: string }[] | null } | null;
  blockedBy: { nodes: { number: number; state: IssueState }[] | null } | null;
  projectItems: {
    nodes: {
      id: string;
      project: { id: string };
      status: { name: string } | null;
      priority: { name: string } | null;
    }[];
  };
}

/** Re-reads affected tickets; returns per-op verification errors (empty = clean). */
async function verifyBatch(batch: readonly ResolvedOp[]): Promise<string[]> {
  const numbers = [...new Set(batch.map((op) => op.number))];
  const { query, aliases } = verifyQuery(numbers);
  const data = await gql(query, { owner: REPO.split("/")[0], repo: REPO_DIR });
  const repo = (data.repository as RefsShape["repository"] | null) ?? null;
  if (repo === null) return ["verification query returned no repository"];
  const errors: string[] = [];
  const byAlias = new Map<string, VerifyIssue | null>();
  for (let i = 0; i < numbers.length; i += 1) {
    const key = aliases[i];
    if (key !== undefined)
      byAlias.set(key, (repo as unknown as Record<string, VerifyIssue | null>)[key] ?? null);
  }
  for (const op of batch) {
    const issue = byAlias.get(`i${op.number}`) ?? null;
    if (issue === null) {
      errors.push(`#${op.number}: not readable at verification`);
      continue;
    }
    const labelNames = new Set((issue.labels?.nodes ?? []).map((l) => l.name));
    const item = issue.projectItems.nodes.find((n) => n.project.id === PROJECT_ID) ?? null;
    switch (op.kind) {
      case "addProjectItem":
        if (item === null)
          errors.push(`#${op.number}: still not boarded after addProjectV2ItemById`);
        break;
      case "setStatus":
      case "setPriority":
        if (item === null) {
          errors.push(`#${op.number}: no board item for ${op.kind} verification`);
        } else {
          const actual = op.kind === "setStatus" ? item.status?.name : item.priority?.name;
          if (actual !== op.value) {
            errors.push(
              `#${op.number}: ${op.kind} drift — expected ${op.value}, read ${actual ?? "null"}`,
            );
          }
        }
        break;
      case "setMilestone": {
        const actual = issue.milestone?.title ?? null;
        if (actual !== op.value) {
          errors.push(
            `#${op.number}: milestone drift — expected ${op.value ?? "null"}, read ${actual ?? "null"}`,
          );
        }
        break;
      }
      case "addBlockedBy":
        if (!issue.blockedBy?.nodes?.some((b) => b.number === op.blocker)) {
          errors.push(`#${op.number}: blockedBy #${op.blocker} edge missing after write`);
        }
        break;
      case "addLabels":
        for (const l of op.labels) {
          if (!labelNames.has(l)) errors.push(`#${op.number}: label ${l} missing after write`);
        }
        break;
    }
  }
  return errors;
}

function renderPreflight(report: PreflightReport): string {
  const lines: string[] = ["== pm-autopilot preflight (dry-run diff) =="];
  for (const c of report.willChange) {
    lines.push(`  CHANGE #${c.mutation.number} ${c.field}: ${c.from ?? "∅"} → ${c.to}`);
    if (c.sideEffect !== undefined) lines.push(`    side-effect: ${c.sideEffect}`);
  }
  for (const c of report.noOps)
    lines.push(`  NO-OP  #${c.mutation.number} ${c.field}: already ${c.to}`);
  for (const s of report.sideEffects) lines.push(`  NOTE   #${s.number}: ${s.note}`);
  for (const e of report.errors) lines.push(`  ERROR  ${e}`);
  if (
    report.willChange.length === 0 &&
    report.noOps.length === 0 &&
    report.sideEffects.length === 0 &&
    report.errors.length === 0
  ) {
    lines.push("  (nothing to do)");
  }
  return lines.join("\n");
}

/**
 * The only write path. Without {confirm: true}: dry-run — prints the
 * preflight diff, issues zero writes, returns the report. With confirm:
 * preflight → batched writes (board-adds first, then ≤10-op ticket groups)
 * → per-batch re-verify → abort remaining batches on any drift.
 */
export async function apply(
  mutations: readonly Mutation[],
  opts: { confirm?: boolean } = {},
): Promise<ApplyReport> {
  const report = await preflight(mutations);
  const base: ApplyReport = {
    ok: false,
    dryRun: !opts.confirm,
    preflight: report,
    appliedBatches: [],
    verified: false,
    errors: report.errors,
  };
  if (report.errors.length > 0 || report.ops.length === 0) {
    console.log(renderPreflight(report));
    return { ...base, ok: report.errors.length === 0 };
  }
  if (!opts.confirm) {
    console.log(renderPreflight(report));
    console.log("dry-run: zero writes issued (pass { confirm: true } to apply)");
    return { ...base, ok: true };
  }

  const batches = batchOps(report.ops);
  const itemIds = new Map<number, string>();
  for (const batch of batches) {
    for (const op of batch) await execOp(op, itemIds);
    const verifyErrors = await verifyBatch(batch);
    if (verifyErrors.length > 0) {
      const detail = verifyErrors.join("; ");
      console.error(`pm-autopilot: verification FAILED — aborting remaining batches: ${detail}`);
      return {
        ...base,
        ok: false,
        appliedBatches: [],
        verifyFailure: { batch: batches.map((b) => b.map((op) => op.number)), detail },
      };
    }
    base.appliedBatches.push(batch.map((op) => op.number));
  }
  base.verified = true;
  base.ok = true;
  return base;
}

/** Delivery hook: blocker `closedNumber` closed → unlock + scheduling callback. */
export async function cascade(
  closedNumber: number,
  opts: { confirm?: boolean } = {},
): Promise<CascadeReport> {
  const snap = await snapshot();
  const plan = planCascade(snap, closedNumber);
  const report: CascadeReport = {
    closedNumber,
    unblocked: plan.unblocked,
    flippedToTodo: plan.flips.map((f) => f.number),
    dispatchableDelta: plan.dispatchableDelta,
    dryRun: !opts.confirm,
  };
  console.log(
    `== cascade #${closedNumber} ==\n` +
      `  unblocked: ${plan.unblocked.map((n) => `#${n}`).join(", ") || "(none)"}\n` +
      `  Backlog→Todo callbacks: ${plan.flips.map((f) => `#${f.number}`).join(", ") || "(none)"}\n` +
      `  dispatchable delta: +${plan.dispatchableDelta.map((n) => `#${n}`).join(", +") || "(none)"}` +
      (opts.confirm ? "" : "\n  dry-run (pass { confirm: true } to write)"),
  );
  if (plan.flips.length > 0) {
    report.apply = await apply(plan.flips, opts);
    report.dryRun = !(report.apply.ok && !report.apply.dryRun);
  }
  return report;
}

interface VocabRepository {
  id: string;
  labels: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { id: string; name: string }[];
  };
  milestones: { nodes: { id: string; number: number; title: string }[] };
}

function renderFileReport(spec: FileSpec, report: FileReport): string {
  const lines = [
    `== AP.file ${report.dryRun ? "preview (dry-run)" : "filing report"} ==`,
    `  TITLE     ${spec.title}`,
    `  LABELS    ${report.plan.labels.join(", ") || "(none)"}`,
    `  MILESTONE ${report.plan.milestone ?? "(none)"}${
      report.plan.milestoneNumber !== null ? ` (#${report.plan.milestoneNumber})` : ""
    }`,
    `  PRIORITY  ${report.plan.priority ?? "(unset)"}`,
    `  STATUS    ${report.plan.status}`,
    `  EDGES     blockedBy ${report.plan.blockedBy.map((n) => `#${n}`).join(", ") || "(none)"}`,
  ];
  for (const r of report.pmReview) {
    lines.push(
      `  REVIEW    ${r.dimension} → ${r.suggested ?? "(none)"} ` +
        `(confidence ${r.confidence.toFixed(2)}) — below floor ${FILE_CONFIDENCE_FLOOR}, PM re-rules`,
    );
  }
  for (const e of report.errors) lines.push(`  ERROR     ${e}`);
  if (report.created !== undefined) lines.push(`  CREATED   #${report.created.number} (${report.created.url ?? "no url"})`);
  return lines.join("\n");
}

/**
 * Post-write verification of one fresh filing: re-reads the created issue
 * and asserts the plan landed completely (labels/milestone/Priority/Status/
 * edges) AND that zero unregistered labels exist on it (invariant 5, read-
 * back form — GraphQL ids cannot fabricate labels, this catches drift).
 */
async function verifyFiling(
  number: number,
  plan: FilePlan,
  vocabulary: Set<string>,
): Promise<string[]> {
  const { query, aliases } = verifyQuery([number]);
  const data = await gql(query, { owner: REPO.split("/")[0], repo: REPO_DIR });
  const repo = (data.repository as RefsShape["repository"] | null) ?? null;
  const issue =
    repo === null ? null : ((repo as unknown as Record<string, VerifyIssue | null>)[aliases[0] ?? ""] ?? null);
  if (issue === null) return [`#${number}: not readable at post-filing verification`];
  const errors: string[] = [];
  const readLabels = (issue.labels?.nodes ?? []).map((l) => l.name);
  for (const l of plan.labels) {
    if (!readLabels.includes(l)) errors.push(`#${number}: label ${l} missing after filing`);
  }
  for (const l of readLabels) {
    if (!vocabulary.has(l)) {
      errors.push(`#${number}: UNREGISTERED label ${l} present — invariant 5 violated`);
    }
  }
  const readMilestone = issue.milestone?.title ?? null;
  if (readMilestone !== plan.milestone) {
    errors.push(
      `#${number}: milestone drift — expected ${plan.milestone ?? "null"}, read ${readMilestone ?? "null"}`,
    );
  }
  const item = issue.projectItems.nodes.find((n) => n.project.id === PROJECT_ID) ?? null;
  if (item === null) {
    errors.push(`#${number}: not boarded after filing`);
  } else {
    if (item.status?.name !== plan.status) {
      errors.push(
        `#${number}: status drift — expected ${plan.status}, read ${item.status?.name ?? "null"}`,
      );
    }
    if (plan.priority !== null && item.priority?.name !== plan.priority) {
      errors.push(
        `#${number}: priority drift — expected ${plan.priority}, read ${item.priority?.name ?? "null"}`,
      );
    }
  }
  for (const b of plan.blockedBy) {
    if (!issue.blockedBy?.nodes?.some((e) => e.number === b)) {
      errors.push(`#${number}: blockedBy #${b} edge missing after filing`);
    }
  }
  return errors;
}

/**
 * Ticket-filing automation (#151): body → AP.intake (jev classification) →
 * issue creation → closed-vocabulary labels → field writes → optional
 * blocking edges → wave Status. DRY-RUN default: `file(spec)` previews the
 * complete plan with zero writes; `file(spec, { confirm: true })` creates.
 *
 * Invariant-5 guard: derived labels must exist in the repository vocabulary
 * BEFORE anything is created — the REST create path auto-creates unknown
 * label names, so filing goes GraphQL-only (createIssue carries no labels;
 * addLabels uses pre-resolved ids) and hard-fails (zero writes, even on
 * confirm) on any unregistered name. Dimensions the judge classified below
 * FILE_CONFIDENCE_FLOOR never auto-apply: they are demoted to the pmReview
 * list for PM re-ruling. The milestone title → number map is resolved from
 * the live repository at runtime, never hardcoded.
 */
export async function file(
  spec: FileSpec,
  opts: { confirm?: boolean } = {},
): Promise<FileReport> {
  const cls = await intake(spec.body);
  const { plan: derived, pmReview } = planFile(spec, cls);
  const errors: string[] = [];
  const plan: FilePlan = { ...derived, milestoneNumber: null };
  const owner = REPO.split("/")[0];

  // Runtime resolution: full label vocabulary + open milestones (id + number)
  // + Status/Priority field option ids. Reads only — legal in dry-run.
  let repoId: string | null = null;
  const labelIds: Record<string, string> = {};
  const vocabulary = new Set<string>();
  let milestoneRef: { id: string; number: number } | null = null;
  let labelCursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const data = await gql(TEMPLATES.repoVocabulary, { owner, repo: REPO_DIR, labelCursor });
    const repo = (data.repository as VocabRepository | null) ?? null;
    if (repo === null) {
      errors.push("repository not readable — vocabulary resolution failed");
      break;
    }
    repoId = repo.id;
    for (const l of repo.labels.nodes) {
      labelIds[l.name] = l.id;
      vocabulary.add(l.name);
    }
    if (plan.milestone !== null) {
      const m = repo.milestones.nodes.find((n) => n.title === plan.milestone);
      if (m !== undefined) milestoneRef = { id: m.id, number: m.number };
    }
    if (!repo.labels.pageInfo.hasNextPage) break;
    labelCursor = repo.labels.pageInfo.endCursor;
  }
  if (plan.milestone !== null && milestoneRef === null) {
    errors.push(
      `milestone "${plan.milestone}" not found among open milestones (closed vocabulary)`,
    );
  }
  plan.milestoneNumber = milestoneRef?.number ?? null;

  // Invariant-5 HARD guard: unregistered label → no filing at all.
  const unresolvedLabels = plan.labels.filter((l) => labelIds[l] === undefined);
  if (unresolvedLabels.length > 0) {
    errors.push(
      `labels ${unresolvedLabels.join(", ")} not registered in repository vocabulary — ` +
        "add to tracker-schema.md first (invariant 5: REST auto-creates unknown labels)",
    );
  }

  // Field option resolution against the live project (BoardSmith: ids are
  // never guessed).
  const selects = await resolveSingleSelects();
  const statusOptionId = selects.statusOptions[plan.status];
  let statusWrite: { optionId: string; value: StatusName } | null = null;
  if (statusOptionId === undefined) {
    errors.push(
      `Status "${plan.status}" not in project closed vocabulary ${Object.keys(selects.statusOptions).join("/")}`,
    );
  } else {
    statusWrite = { optionId: statusOptionId, value: plan.status };
  }
  let priorityWrite: { optionId: string; value: PriorityName } | null = null;
  if (plan.priority !== null) {
    const priorityOptionId = selects.priorityOptions[plan.priority];
    if (priorityOptionId === undefined) {
      errors.push(`Priority "${plan.priority}" not in project closed vocabulary`);
    } else {
      priorityWrite = { optionId: priorityOptionId, value: plan.priority };
    }
  }

  // Blocker node ids (dependency axis; edges are the only cross-issue write).
  const blockerIds: Record<number, string> = {};
  for (const n of plan.blockedBy) {
    const data = await gql(
      `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { id } } }`,
      { owner, repo: REPO_DIR, number: n },
    );
    const id = (data.repository as RefsShape["repository"] | null)?.issue?.id;
    if (typeof id !== "string" || id === "") {
      errors.push(`#${n}: blocker not found — cannot wire an edge to a nonexistent issue`);
    } else {
      blockerIds[n] = id;
    }
  }

  const base: FileReport = { ok: false, dryRun: !opts.confirm, intake: cls, plan, pmReview, errors };
  if (errors.length > 0 || !opts.confirm) {
    console.log(renderFileReport(spec, base));
    if (opts.confirm !== true) {
      console.log("dry-run: zero writes issued (pass { confirm: true } to file)");
    }
    return { ...base, ok: errors.length === 0 };
  }

  // Confirmed path. Creation first (GraphQL carries no labels — invariant 5),
  // then labels by pre-resolved id, then board/field/edge ops via the same
  // batched exec path AP.apply uses.
  const createData = await gql(TEMPLATES.createIssue, {
    repositoryId: repoId,
    title: spec.title,
    body: spec.body,
    milestoneId: milestoneRef?.id ?? null,
  });
  const payload = createData.createIssue as
    | { issue: { id: string; number: number; url: string | null } | null }
    | null;
  const issue = payload?.issue ?? null;
  if (issue === null) throw new Error("AP.file: createIssue returned no issue");

  if (plan.labels.length > 0) {
    const ids: string[] = [];
    for (const l of plan.labels) {
      const id = labelIds[l];
      if (id === undefined) throw new Error(`AP.file: label ${l} lost between guard and write`);
      ids.push(id);
    }
    await gql(TEMPLATES.addLabels, { labelableId: issue.id, labelIds: ids });
  }

  const ops: ResolvedOp[] = [{ kind: "addProjectItem", number: issue.number, issueNodeId: issue.id }];
  if (priorityWrite !== null) {
    ops.push({
      kind: "setPriority",
      number: issue.number,
      itemId: "PENDING_BOARD",
      fieldId: selects.priorityFieldId,
      optionId: priorityWrite.optionId,
      value: priorityWrite.value,
    });
  }
  if (statusWrite === null) throw new Error("AP.file: status option lost between guard and write");
  ops.push({
    kind: "setStatus",
    number: issue.number,
    itemId: "PENDING_BOARD",
    fieldId: selects.statusFieldId,
    optionId: statusWrite.optionId,
    value: statusWrite.value,
  });
  for (const n of plan.blockedBy) {
    const blockerNodeId = blockerIds[n];
    if (blockerNodeId === undefined) {
      throw new Error(`AP.file: blocker #${n} lost between guard and write`);
    }
    ops.push({
      kind: "addBlockedBy",
      number: issue.number,
      issueNodeId: issue.id,
      blocker: n,
      blockerNodeId,
    });
  }
  const itemIds = new Map<number, string>();
  for (const batch of batchOps(ops)) {
    for (const op of batch) await execOp(op, itemIds);
  }

  const verifyErrors = await verifyFiling(issue.number, plan, vocabulary);
  const created = { number: issue.number, id: issue.id, url: issue.url };
  if (verifyErrors.length > 0) {
    errors.push(...verifyErrors);
    console.error(`AP.file: post-filing verification FAILED: ${verifyErrors.join("; ")}`);
    return { ...base, errors, created };
  }
  const report: FileReport = { ...base, ok: true, created };
  console.log(renderFileReport(spec, report));
  return report;
}

/**
 * Atomic intake question set (#131 CRITICAL): milestone/block/type/priority +
 * dor_evidence as choice; needs_probe/needs_human as noul. Exactly these
 * seven — the export doubles as the L1 suite's request-shape oracle.
 */
export const INTAKE_QUESTIONS: Record<string, unknown> = {
  milestone: {
    type: "choice",
    instructions:
      "Which milestone (phase axis, tracker-schema.md) does this ticket belong to? Judge by scope/urgency in the body, not by mention only. 'none' = unscheduled/backlog.",
    criteria: {
      M0: "foundational platform work gating everything else",
      M1: "current execution wave (core semantics/visible damage)",
      M2: "next wave",
      M3: "far-term/polish",
      none: "no milestone — un-scheduled backlog item",
    },
  },
  block: {
    type: "choice",
    instructions:
      "Which territory (block 轴) does the ticket primarily touch? Cross-block tickets: pick the dominant one. scope:infra = platform/infra cross-cutting with no block correspondence.",
    criteria: {
      "block:bb-ux": "bb surface/UX work (bb repo)",
      "block:agent-content": "agent-facing content/prompts/docs",
      "block:agent-harness": "agent runtime/harness/platform plumbing",
      "scope:infra": "infra cross-cutting (no block twin)",
      none: "no territory label applies",
    },
  },
  type: {
    type: "choice",
    instructions: "Work-type axis.",
    criteria: {
      "type:implementation": "ships code/config",
      "type:research": "produces findings/documents, zero fixes",
      "type:decision": "produces a ruling/ADR",
    },
  },
  priority: {
    type: "choice",
    instructions:
      "Importance tier (Priority field vocabulary, three tiers capped). P0=放行/阻止/资损 (release-blocking, user-stopping, money-losing); P1=核心语义或可见损伤; P2=卫生.",
    criteria: {
      P0: "release/user/money blocking",
      P1: "core semantics or visible damage",
      P2: "hygiene",
    },
  },
  dor_evidence: {
    type: "choice",
    instructions:
      "DoR evidence class present in the body: probe = cited spike/probe conclusion; anchors = cited bb/omp anchor points; none = neither.",
    criteria: {
      probe: "spike/probe result quoted in the body",
      anchors: "bb/omp anchor references quoted in the body",
      none: "no DoR evidence in the body",
    },
  },
  needs_probe: {
    type: "noul",
    instructions:
      "Probability that this ticket needs a spike/probe (uncertain ground, unknown mechanism) before implementation can be planned. 0 = scope fully known, 1 = pure unknown.",
    criteria: { true: "needs a probe first", false: "implementable as specified" },
  },
  needs_human: {
    type: "noul",
    instructions:
      "Probability that this ticket requires a human ruling before work (taste call, money/legal exposure, contradictory requirements, scope ambiguity the board cannot resolve). 0 = autonomous-dispatch safe, 1 = human must rule first.",
    criteria: { true: "route to ready-for-human", false: "autonomous dispatch safe" },
  },
};

const INTAKE_MILESTONES = ["M0", "M1", "M2", "M3", "none"] as const;
const INTAKE_BLOCKS = [
  "block:bb-ux",
  "block:agent-content",
  "block:agent-harness",
  "scope:infra",
  "none",
] as const;
const INTAKE_TYPES = ["type:implementation", "type:research", "type:decision"] as const;
const INTAKE_EVIDENCE = ["probe", "anchors", "none"] as const;

export type GateAction = "auto-apply" | "pm-review" | "needs-human";

/**
 * Confidence gate (#131 CRITICAL): ≥0.8 auto-apply · 0.5–0.8 PM review ·
 * <0.5 needs-human. Exported domain concept — the PM loop reads the gate,
 * never re-derives thresholds.
 */
export function gateOf(confidence: number): GateAction {
  if (confidence >= 0.8) return "auto-apply";
  if (confidence >= 0.5) return "pm-review";
  return "needs-human";
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Pure judge-reply → IntakeResult (gate included); unit-testable without any
 * transport. noul answers carry P(true): polarity = v ≥ 0.5, confidence in
 * the polarity = max(v, 1−v). Out-of-vocabulary choices report null for the
 * field, confidence 0 — dragging the weakest-link gate to needs-human.
 */
export function classifyIntake(reply: JudgeReply): IntakeResult {
  const pick = <T extends readonly string[]>(
    key: string,
    vocab: T,
  ): { value: T[number] | null; confidence: number } => {
    const a = reply.answers[key];
    if (a === undefined || typeof a.choice !== "string" || !inVocab(vocab, a.choice)) {
      return { value: null, confidence: 0 };
    }
    return {
      value: a.choice,
      confidence: typeof a.confidence === "number" ? clamp01(a.confidence) : 0,
    };
  };
  const noul = (key: string): { value: boolean; confidence: number } => {
    const a = reply.answers[key];
    if (a === undefined || typeof a.noul !== "number") return { value: false, confidence: 0 };
    const v = clamp01(a.noul);
    return { value: v >= 0.5, confidence: Math.max(v, 1 - v) };
  };
  const milestone = pick("milestone", INTAKE_MILESTONES);
  const block = pick("block", INTAKE_BLOCKS);
  const type = pick("type", INTAKE_TYPES);
  const priority = pick("priority", PRIORITY_OPTIONS);
  const dorEvidence = pick("dor_evidence", INTAKE_EVIDENCE);
  const probe = noul("needs_probe");
  const human = noul("needs_human");
  const confidence = {
    milestone: milestone.confidence,
    block: block.confidence,
    type: type.confidence,
    priority: priority.confidence,
    dor_evidence: dorEvidence.confidence,
    needs_probe: probe.confidence,
    needs_human: human.confidence,
  };
  return {
    milestone: milestone.value,
    block: block.value,
    type: type.value,
    priority: priority.value,
    dor_evidence: dorEvidence.value,
    needs_probe: probe.value,
    needs_human: human.value,
    confidence,
    gate: gateOf(Math.min(...Object.values(confidence))),
    judgeModel: typeof reply.model === "string" ? reply.model : undefined,
  };
}

/** Judge-classify a raw ticket body against the closed vocabularies: one real
 *  model call, never auto-writes — the gate decides who reads the result. */
export async function intake(body: string): Promise<IntakeResult> {
  const state =
    "Classify this cloudflare-agent-project ticket for the tracker " +
    "(docs/agents/tracker-schema.md axes). Judge by what the body ships, " +
    "not by label mentions alone. Ticket body:\n" +
    body;
  return classifyIntake(await (injected?.judge ?? defaultJudge)(state, INTAKE_QUESTIONS));
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export const AP = {
  snapshot,
  dispatchable,
  intake,
  classifyIntake,
  gateOf,
  resolveJeapiKey,
  preflight,
  apply,
  cascade,
  file,
  planFile,
  dispatchPackets,
  /** Pure internals, exposed for tests/inspection. */
  pure: { slugify, planDiff, planCascade, budgetOf, FILE_CONFIDENCE_FLOOR },
  /** Judge layer: question oracle + real transport (tests mock via fetch). */
  judge: { INTAKE_QUESTIONS, JEV_URL, JEV_MODEL, defaultJudge },
  /** Config actually in effect. */
  config: { PROJECT_ID, REPO },
} as const;

const globalScope = globalThis as { AP?: typeof AP };
globalScope.AP ??= AP;
