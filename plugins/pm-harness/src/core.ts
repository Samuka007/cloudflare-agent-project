/**
 * plugins/pm-harness/src/core.ts — #131 PM autopilot core, relocated #270.
 *
 * #270 relocation: this was scripts/pm-autopilot.ts. The omp custom-tool
 * plugin package (plugins/pm-harness — pm_lane/pm_apply/pm_audit/pm_release/
 * pm_ledger in ./tools.ts) now owns it; scripts/pm-harness.ts still
 * cache-bust-imports this file for the eval-kernel %load flow, and the L1
 * suite lives beside it in ../test/. Nothing about the module contract
 * changed: %load-able TypeScript, stateless-reentrant, board = only truth.
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
 *     %load "plugins/pm-harness/src/core.ts"
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
 * Closeout gate (#277 — 实现票交付→验收 lane 出证据→才可 merge/close):
 *
 *     AP.closeout(266, "acceptance-lane",
 *                 { evidence: "comment-url", deploymentVersion: "ece470f" });
 *                                      // records the evidence trio on the
 *                                      // .pm-closeouts.jsonl ledger; refuses an
 *                                      // incomplete trio (无证据不关票).
 *     AP.audit(snap, { closeouts: AP.closeoutLedger().events });
 *                                      // rule 7 closeoutNoEvidence: a delivered
 *                                      // type:implementation/type:bug ticket with
 *                                      // no accepted entry — backfill or reopen.
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
 * Explicit spec fields (#151 fix) are authoritative — jev only fills what the
 * spec leaves undefined, and a post-create failure rolls the filing back
 * (board item removed, issue closed as not_planned):
 *
 *     await AP.file({ title, body, labels: ["type:implementation", "block:agent-harness"],
 *                     milestone: "M1", priority: "P1" }, { confirm: true });
 *                                      // exact-milestone match; explicit pins are
 *                                      // never re-classified or demoted.
 *
 * Dispatch gate (#171, recalibrated #199) — AP.lane: board-predicate
 * refusal → worktree provision → isolated spawn, with the DoR table riding
 * along as advisory. Structure replaces PM recall; a bare spawn of the main
 * checkout is no longer expressible:
 *
 *     const t = AP.dispatchable(snap)[0];
 *     await AP.lane(197);                 // number entry: snapshot self-fetch (#199)
 *     await AP.lane(t);                   // dry-run: DoR table + spawn plan, zero writes
 *     await AP.lane(t, { agent: "task" }, { confirm: true });
 *                                      // runs `git worktree add <herdr path>
 *                                      // -b lane/<ticket>-<slug> origin/main`, returns
 *                                      // spawn { agent, isolated: true, task, context }.
 *                                      // A failed board predicate refuses dispatch;
 *                                      // DoR gaps (三问/验收/锚点, #224) are
 *                                      // advisory — they print, never refuse.
 *     // confirm additionally spawns for real through the transport (#206:
 *     // default = globalThis.agent(prompt, {isolated: true, label}); the
 *     // registerSpawn slot overrides for tests/custom weaves) and then owns
 *     // the board flip (Status → In Progress via the guarded AP.apply write).
 *     // transport-missing is reported on the report — never silent. Batch:
 *     await AP.lane([197, 206]);          // one report per ticket
 *
 * Dependency edges ride the dispatch (#393): `AP.lane(t, {}, { confirm: true,
 * blockedBy: [387] })` materializes the narrated dependency as a blockedBy
 * edge in the same dispatch — the existing addBlockedBy primitive, the same
 * preflight as AP.apply — so prose dependencies stop dying as prose. Dry-run
 * plans them; a failed spawn writes nothing.
 *
 * Board drift audit (#181) — the PM beat opens with a reconcile, then
 * dispatches. Pure rules over the snapshot; output feeds AP.apply directly:
 *
 *     const snap = await AP.snapshot();
 *     const rep = AP.audit(snap, { activeLanes: [181, 197] }); // roster from proc://
 *     console.table(rep.drift);          // findings + per-ticket detail
 *     await AP.apply(rep.mutations);     // dry-run: the preflight diff, no writes
 *     await AP.apply(rep.mutations, { confirm: true }); // one-shot reconcile
 *
 * Rules: (1) CLOSED but Status∉{Done,Canceled} and (2) In Progress on a
 * CLOSED issue converge through the sync-derived Status (wontfix→Canceled,
 * else Done — the one closed-ticket write apply accepts); (3) active-lane
 * tickets not reading In Progress flip back; (4) dispatchable Todos
 * untouched for more than FRONTIER_AGE_DAYS days surface as dispatch
 * reminders (mutation: null — the repair is AP.lane, not a write); (8)
 * proseDependencyWithoutEdge (#393) — a ticket whose body narrates a
 * dependency (依赖/前置/须先/倒查/blocked + #n) at a ticket on this board with
 * no blockedBy edge to match: advisory (mutation: null), the repair is an
 * apply edge or a blockedBy dispatch arg. Re-run audit after the apply:
 * `clean` is the beat's green light.
 *
 * Shared-resource lease ledger (#240) — browser (CDP/thread) first. 口头纪律
 * 结构化 (#239 comment 5988466175): every browser lane holds a NAMED tab and a
 * dedicated staging-thread prefix, and releases on delivery — the ledger
 * enforces it mechanically instead of by PM recall. Storage is an append-only
 * repo-local jsonl (`.pm-leases.jsonl`, gitignored; `PM_LEASES_PATH` env or
 * the `leasesPath` option overrides):
 *
 *     AP.lease("browser", { lane: "lane-239-x", tabName: "l239-accept",
 *                           threadPrefix: "l239-", number: 239 });
 *                                      // registers; REFUSES a collision (same
 *                                      // tab/prefix actively held by another lane)
 *     AP.release("browser", { lane: "lane-239-x" });
 *                                      // sets releasedAt; no active lease ⇒ throw
 *     AP.ledger();                     // { events, active } — the audit's rule-6 input
 *     AP.audit(snap, { activeLanes, leases: AP.ledger().events });
 *                                      // rule 6 drift list: browser lane without a
 *                                      // lease · same tab/prefix held by two lanes ·
 *                                      // delivered ticket with the lease still open
 *
 * AP.lane auto-carries it: a ticket mentioning 浏览器/browser/CDP/Chrome gets a
 * deterministic lease (tab `l<number>`, thread prefix `l<number>-`, roster
 * lane id) — the spawn context carries the lease section (named tab + thread
 * prefix + release obligation) and the confirm path registers the lease at
 * spawn time, rolling it back if the spawn throws. Dry-run plans it, writes
 * nothing.
 *
 * PM session bootstrap = ONE cell (persistent carrier, #206):
 *
 *     %load "scripts/pm-harness.ts"
 *     // cache-busted AP import → globalThis.AP, transport weave, AP_READY flag
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
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  /** Last issue update, ISO 8601 (#181 rule-4 aging proxy — any issue event
   *  refreshes it; reminder input, never a guard input). */
  updatedAt: string;
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
  /** git executor seam — AP.lane worktree provisioning. L1 injects a
   *  recorder (zero filesystem side effects); default shells out to git. */
  runGit?: (args: string[], cwd: string) => string;
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

const defaultRunGit = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

function runGit(args: string[], cwd: string): string {
  const fn = injected?.runGit ?? defaultRunGit;
  return fn(args, cwd);
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
          id number title state bodyText updatedAt
          milestone { title }
          labels(first: 50) { nodes { name } }
          blockedBy(first: 50) { nodes { number state title } }
        } }
      } } } }
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 100, after: $issueCursor) { pageInfo { hasNextPage endCursor }
      nodes { id number title state bodyText updatedAt
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
  /** #151 rollback: filing is all-or-nothing. GitHub cannot delete issues,
   *  so a failed post-create write undoes itself by removing the board item
   *  and closing the issue as not_planned. */
  deleteProjectItem: `mutation($projectId: ID!, $itemId: ID!) {
  deleteProjectV2ItemById(input: { projectId: $projectId, itemId: $itemId }) { deletedItemId }
}`,
  closeIssue: `mutation($id: ID!, $stateReason: IssueStateReason) {
  updateIssue(input: { id: $id, state: CLOSED, stateReason: $stateReason }) { issue { number state } }
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
  updatedAt: string;
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
// Semantic level (#199): a budget is any line naming the axis (预算/budget/
// 墙钟/wall 时钟/efficienc) or carrying a wall-clock time expression
// (≤1.5h / 40min / 30分钟 / 2 hours) — no colon shape required; real writing
// is "预算 ≤1.5h", not "预算：≤1.5h", and the detector must read the same
// language the tickets do.
const BUDGET_PATTERN =
  /^\s*(?:[-*]\s*)?(?:.*(?:预算|budget|wall\s*时钟|墙钟|efficienc).*|.*\d+(?:\.\d+)?\s*(?:min(?:ute)?s?|h(?:ours?|rs?)?|分钟)(?![a-z]).*)$/im;

function budgetOf(body: string): { source: "body" | "skeleton"; line: string } {
  const matched = BUDGET_PATTERN.exec(body)?.[0];
  if (matched) {
    return { source: "body", line: matched.trim() };
  }
  return {
    source: "skeleton",
    line: "预算行缺失：墙钟 ≤ __min；资源上限 __；等待方式：交付即回（超 50% 须解释）",
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
      `# Close-out prohibitions (PM-owned steps — violations get rolled back)`,
      `1. Do NOT close the issue. Closing is PM-owned: PM registers acceptance`,
      `   evidence (AP.closeout ledger) first, then ticks the ticket's`,
      `   acceptance boxes, then closes. The lane reports; it never closes.`,
      `2. Do NOT edit CHANGELOG.md. PM writes the changelog entry at merge`,
      `   time (three merge conflicts proved per-lane entries collide).`,
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

// ---------------------------------------------------------------------------
// AP.lane (#171) — the dispatch gate: DoR preflight → worktree provision →
// isolated spawn packet. Composes dispatchable/dispatchPackets; confirm-path
// side effects: `git worktree add` (#171), the real spawn (#206 transport),
// and the guarded board Status flip (#206, the pipeline owns it).
// ---------------------------------------------------------------------------

/** One DoR line printed per dispatch: gate item, pass/fail, body evidence. */
export interface DorCheck {
  key: "three-questions" | "acceptance" | "anchors";
  label: string;
  ok: boolean;
  /** First body line backing the check (trimmed); null when absent. */
  evidence: string | null;
}

const DOR_LINE_ITEMS: readonly {
  key: DorCheck["key"];
  label: string;
  pattern: RegExp;
}[] = [
  {
    key: "three-questions",
    label: "①复用三问答案引用",
    pattern: /三问|bb\s*有形状|omp\s*有语义|平台缝|hitl/i,
  },
  {
    key: "acceptance",
    label: "②验收产品面可观察",
    pattern: /验收|acceptance/i,
  },
  {
    key: "anchors",
    label: "③上游锚点",
    // Semantic level (#199): an anchor is 锚/anchor wording, a § reference,
    // a bb:/omp: pointer, or a file path (pathed or bare-filename, line
    // range optional) — "上游锚：spec §D2-D4" and "按 agent-do.ts:1099" are
    // anchors though neither contains the literal word 锚点.
    pattern:
      /锚|anchor|§\s*\S|(?:^|\s)(?:bb|omp)\s*[：:]\s*\S|[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z]\w{0,7}|\b[\w@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|sh|md|json|ya?ml|toml|sql|css|html|nix|tf|env|conf)\b/i,
  },
];

/**
 * The three DoR gate items (#171; trimmed to three by #224 — budget and
 * precedent left the gate, budgetOf survives only as the packet info line):
 * 复用三问答案引用 / 验收面 / 上游锚点. Detection is semantic (#199) —
 * matched against how tickets are actually written (锚：/§refs/file paths),
 * not a pinned word form. Pure line heuristics; the L1 suite pins them;
 * anything smarter belongs in intake.
 */
export function dorChecklist(body: string): DorCheck[] {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const firstMatch = (re: RegExp): string | null => lines.find((l) => re.test(l)) ?? null;
  return DOR_LINE_ITEMS.map((item) => {
    const evidence = firstMatch(item.pattern);
    return { key: item.key, label: item.label, ok: evidence !== null, evidence };
  });
}

/** The spawn packet AP.lane hands back — paste into the omp `task` tool.
 *  `isolated: true` is structural (#171): the gate never produces a shared-
 *  worktree spawn, that is the whole point. */
export interface LaneSpawnSpec {
  agent: string;
  isolated: true;
  /** Shared context (contract/interfaces); null when none supplied. */
  context: string | null;
  /** Full lane instructions — the DispatchPacket context. */
  task: string;
  model?: string;
}

export interface LaneDispatchReport {
  ok: boolean;
  dryRun: boolean;
  number: number;
  title: string;
  /** Board predicate held (open ∧ Todo ∧ no open blockers ∧ ¬rfh). */
  dispatchable: boolean;
  /** Advisory only (#199): informs the PM, never refuses. */
  dor: DorCheck[];
  refused: boolean;
  /** Only the board predicate refuses (#199) — DoR gaps are advisory. */
  refusalReasons: string[];
  worktree: WorktreePlan;
  /** True only when the confirm path actually ran `git worktree add`. */
  worktreeCreated: boolean;
  /** Null when refused — a refused ticket never yields a spawn packet. */
  spawn: LaneSpawnSpec | null;
  /** #240 browser lease plan — null when the ticket never mentions a browser.
   *  Dry-run: planned, not registered; confirm: registered in the ledger at
   *  spawn time (rolled back if the spawn throws). */
  lease: LaneLeasePlan | null;
  /** #393 dependency-edge plan/outcome — null when the dispatch carried no
   *  blockedBy arg. Dry-run: the pure plan; confirm: materialized after a
   *  successful spawn via the guarded apply write (a failed spawn never
   *  writes edges). */
  blockedBy: LaneEdgePlan | null;
  /** #206 confirm path: the transport actually spawned. False on dry-run,
   *  refusal, transport-missing, or a spawn throw. */
  spawned: boolean;
  /** Which transport fired: the registerSpawn slot, the default kernel
   *  global, the #270 detached-omp fallback, or "missing" — reported, never
   *  silent. Null before spawn. */
  transport: SpawnTransportKind | "missing" | null;
  /** Raw handle from the transport (omp `agent()` handle); null otherwise. */
  agentHandle: unknown;
  /** Roster id extracted from the handle, when it carries one. */
  agentId: string | null;
  /** Transport-missing reason or spawn throw message; null on success. */
  spawnError: string | null;
  /** #206: the dispatch pipeline owns the board flip — after a successful
   *  spawn, AP.apply (guarded write) sets Status → In Progress (it verifies,
   *  so a raced flip would no-op rather than re-write; lane's predicate
   *  refuses non-Todo tickets anyway). False on dry-run/refusal/spawn
   *  failure or a failed flip. */
  statusFlipped: boolean;
  /** Flip failure detail (preflight errors / verify drift); null on success. */
  statusError: string | null;
  errors: string[];
}

export interface LaneAgentSpec {
  /** omp agent type (default "task"). */
  agent?: string;
  model?: string;
  /** Shared context — contracts/interfaces lanes must honour. */
  context?: string;
  /** #240 browser-lease name override — defaults derive from the ticket
   *  number (tab `l<number>`, thread prefix `l<number>-`). */
  lease?: { tabName?: string; threadPrefix?: string };
}

/** What the gate hands a spawn transport (#206): the full lane task, the
 *  roster label, and the packet facts. The default transport consumes
 *  prompt+label; richer weaves (pm-harness, tests) may read the rest. */
export interface SpawnRequest {
  /** Full lane context — the DispatchPacket context (worktree + discipline). */
  prompt: string;
  /** Roster label, derived from the branch slug: `lane-<number>-<slug>`. */
  label: string;
  /** omp agent type from LaneAgentSpec (default "task"). */
  agent: string;
  /** Shared context, or null. */
  context: string | null;
  model?: string;
  /** #270: the provisioned worktree path (home-expanded), when the dispatch
   *  pipeline created one. The detached-omp fallback transports the lane
   *  there via `--cwd`; kernel transports ignore it (the lane context text
   *  already names the path). */
  cwd?: string;
}

/** One isolated subagent spawn. The default impl wraps the omp eval kernel's
 *  native `agent(prompt, {isolated, label})` — full subagent transport
 *  (keep-alive, agent:// liveness, history transcript). */
export type SpawnFn = (p: SpawnRequest) => unknown;

type KernelAgent = (prompt: string, opts: { isolated: boolean; label: string }) => unknown;

let spawnOverride: SpawnFn | null = null;

/** #206 transport override slot: tests inject a recorder mock; custom weaves
 *  (pm-harness) wrap the kernel agent explicitly. Pass null to restore the
 *  default globalThis.agent path. */
export function registerSpawn(fn: SpawnFn | null): void {
  spawnOverride = fn;
}

/** #270 fallback tier, installed by the plugin's tool layer at factory time:
 *  a host-side detached `omp -p` lane (no eval kernel required). Tests import
 *  core directly and never install it, so the transport-missing contract is
 *  unchanged there. Pass null to uninstall. */
let spawnFallback: SpawnFn | null = null;

export function registerSpawnFallback(fn: SpawnFn | null): void {
  spawnFallback = fn;
}

/** Test seam (#270, _inject convention): whether the fallback slot holds a
 *  transport — lets the tools suite assert the factory installs it without
 *  dispatching through a real detached spawn. */
export function _spawnFallbackInstalled(): boolean {
  return spawnFallback !== null;
}

export type SpawnTransportKind = "registered" | "default" | "fallback";

/** Resolves the transport in force at spawn time: registered override →
 *  default kernel global → #270 plugin fallback → "missing" (reported on the
 *  report, never a silent skip — a confirm run without a transport is an
 *  incomplete dispatch). */
function resolveSpawn():
  { fn: SpawnFn; transport: SpawnTransportKind } | { missing: string } {
  if (spawnOverride !== null) return { fn: spawnOverride, transport: "registered" };
  // omp eval-kernel global as a named unchecked view by design: the typeof
  // guard below is the runtime validation (absent global → transport-missing).
  const kernelScope = globalThis as { agent?: KernelAgent };
  if (typeof kernelScope.agent === "function") {
    const agent = kernelScope.agent;
    return { fn: (p) => agent(p.prompt, { isolated: true, label: p.label }), transport: "default" };
  }
  const noDetach = process.env.PM_LANE_NO_DETACH === "1";
  if (spawnFallback !== null && !noDetach) return { fn: spawnFallback, transport: "fallback" };
  if (noDetach) {
    return {
      missing:
        "no spawn transport: typeof globalThis.agent !== 'function' and the detached-omp " +
        "fallback is disabled (PM_LANE_NO_DETACH=1) — %load scripts/pm-harness.ts in the omp " +
        "eval kernel, or AP.registerSpawn(fn) (tests/custom weaves)",
    };
  }
  return {
    missing:
      "no spawn transport: typeof globalThis.agent !== 'function' and no fallback registered " +
      "(tools.ts installs one; tests/custom weaves use AP.registerSpawn(fn))",
  };
}

/** Best-effort roster id from a transport handle: string handles pass
 *  through; `{id}`/`{name}` objects unwrap; anything else stays opaque. */
function agentIdOf(handle: unknown): string | null {
  if (typeof handle === "string") return handle;
  if (handle !== null && typeof handle === "object") {
    const h = handle as { id?: unknown; name?: unknown };
    if (typeof h.id === "string") return h.id;
    if (typeof h.name === "string") return h.name;
  }
  return null;
}

const expandHome = (p: string): string =>
  p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;

const truncateLine = (line: string, max: number): string =>
  line.length > max ? `${line.slice(0, max - 1)}…` : line;

/** number → Ticket through a fresh snapshot (#199): the PM's first move is
 *  `lane(197)`, not a snapshot fetch. Throws only when the number is not on
 *  the board — every other judgement stays with the normal gate flow. */
async function ticketOnBoard(number: number): Promise<Ticket> {
  const snap = await snapshot();
  const found = snap.tickets.find((t) => t.number === number);
  if (found === undefined) {
    throw new Error(
      `AP.lane: #${number} not on board — file it first (AP.file) or check the number`,
    );
  }
  return found;
}

function renderLaneReport(r: LaneDispatchReport): string {
  const lines = [
    `== AP.lane ${
      r.refused ? "REFUSED" : r.dryRun ? "plan (dry-run)" : r.ok ? "dispatched" : "incomplete"
    } #${r.number} ==`,
    `  TICKET    ${r.title}`,
    `  BOARD     ${r.dispatchable ? "dispatchable" : "NOT dispatchable (board predicate)"}`,
  ];
  for (const c of r.dor) {
    lines.push(
      `  DoR ${c.ok ? "✓" : "✗"} ${c.label}` +
        (c.evidence !== null ? ` — ${truncateLine(c.evidence, 80)}` : " — MISSING"),
    );
  }
  if (r.dor.some((c) => !c.ok)) {
    lines.push("  DoR note  advisory — gaps do NOT refuse (#199); PM judges before spawning");
  }
  lines.push(
    `  WORKTREE  ${r.worktree.branch} @ ${r.worktree.path}` +
      (r.worktreeCreated ? " (created)" : r.dryRun ? " (dry-run)" : ""),
  );
  lines.push(`  COMMAND   ${r.worktree.command}`);
  if (r.lease !== null) {
    lines.push(
      `  LEASE     tab=${r.lease.tabName} prefix=${r.lease.threadPrefix}` +
        (r.lease.registered
          ? " (registered)"
          : r.dryRun
            ? " (dry-run — registered on confirm)"
            : " (NOT registered)"),
    );
  }
  if (r.blockedBy !== null) {
    const e = r.blockedBy;
    const refs = (bs: readonly number[]): string => bs.map((b) => `#${b}`).join(", ");
    if (e.applied.length > 0) {
      lines.push(`  EDGES     applied ${refs(e.applied)}`);
    } else if (r.dryRun) {
      lines.push(`  EDGES     plan ${refs(e.requested)} — materialize on confirm (addBlockedBy)`);
    } else if (e.already.length === 0 && e.errors.length === 0) {
      lines.push(`  EDGES     plan ${refs(e.requested)} — NOT applied (dispatch failed first)`);
    } else {
      lines.push(`  EDGES     none written (see already/ERROR lines)`);
    }
    if (e.already.length > 0) lines.push(`  EDGES     already ${refs(e.already)} (no-op)`);
    for (const err of e.errors) lines.push(`  EDGES     ERROR ${err}`);
  }
  if (r.spawn !== null) {
    lines.push(
      `  SPAWN     agent=${r.spawn.agent} isolated=${String(r.spawn.isolated)}` +
        (r.spawn.model !== undefined ? ` model=${r.spawn.model}` : "") +
        " — report.spawn carries the full omp task args",
    );
  }
  if (!r.dryRun && !r.refused) {
    lines.push(
      r.spawned
        ? `  SPAWN     transport=${r.transport} → ${r.agentId ?? "(handle returned)"} — live lane`
        : `  SPAWN     NOT SPAWNED (transport=${r.transport}) — ${r.spawnError}`,
    );
    lines.push(
      r.statusFlipped
        ? "  STATUS    board → In Progress (guarded write, verified)"
        : `  STATUS    NOT flipped — ${r.statusError ?? "spawn failed"}`,
    );
  }
  for (const e of r.refusalReasons) lines.push(`  REFUSED   ${e}`);
  for (const e of r.errors) lines.push(`  ERROR     ${e}`);
  if (r.dryRun && !r.refused) {
    lines.push(
      `  PM        confirm spawns the lane for real and flips Status → In Progress (guarded write)`,
    );
  }
  return lines.join("\n");
}

/**
 * The dispatch gate (#171), recalibrated by #199 into plain spawn
 * scaffolding: its value is the guarantees — deterministic herdr worktree,
 * isolated-only spawn packet, board-truth refusal — not prose policing.
 * 假的严谨约束等于真的破坏推进: the first real use rejected #197 four
 * times on word-form checks while the body carried real anchors and budget.
 *
 * Entry is number | Ticket | Array (#199, batch #206): a number resolves through a fresh
 * snapshot and throws only when it is not on the board. AP.lane (a) refuses
 * — zero side effects — on the ONE structural check, the board predicate
 * (open ∧ Todo ∧ no open blockers ∧ ¬ready-for-human); the three-item DoR
 * table rides along as ADVISORY for the PM and never refuses; (b) on
 * confirm, runs
 * `git worktree add <herdr path> -b lane/<ticket>-<slug> origin/main` at the
 * deterministic herdr path (naming reused from dispatchPackets); (c, #206)
 * spawns the lane for real through the spawn transport — default
 * `(p) => globalThis.agent(p.prompt, {isolated: true, label: p.label})`, the
 * registerSpawn slot overrides (test mock / pm-harness weave) — and then
 * OWNS the board flip: Status → In Progress via AP.apply's guarded write
 * (which verifies, so an already-flipped ticket is a no-op, not a race).
 * Transport-missing and spawn throws mark the report incomplete (ok=false,
 * spawnError set) — never a silent skip; the flip only follows a successful
 * spawn (the board must reflect reality). (d) always
 * returns the omp spawn packet with `isolated: true` baked in — a bare
 * spawn of the main checkout is no longer expressible through this gate.
 *
 * Batch entry (#206): an array dispatches every ticket as one wave (parallel
 * laneOne runs) and resolves to one report per ticket, input order.
 *
 * DRY-RUN default (consistent with apply/file): prints the DoR table +
 * worktree/spawn plan, creates nothing.
 */
export async function lane(
  ticket: number | Ticket,
  agentSpec?: LaneAgentSpec,
  opts?: {
    confirm?: boolean;
    base?: string;
    cwd?: string;
    leasesPath?: string;
    /** #393: dependency edges materialized with the dispatch (addBlockedBy,
     *  same preflight as apply). */
    blockedBy?: readonly number[];
  },
): Promise<LaneDispatchReport>;

export async function lane(
  ticket: (number | Ticket)[],
  agentSpec?: LaneAgentSpec,
  opts?: {
    confirm?: boolean;
    base?: string;
    cwd?: string;
    leasesPath?: string;
    blockedBy?: readonly number[];
  },
): Promise<LaneDispatchReport[]>;

export async function lane(
  ticket: number | Ticket | (number | Ticket)[],
  agentSpec: LaneAgentSpec = {},
  opts: {
    confirm?: boolean;
    base?: string;
    cwd?: string;
    leasesPath?: string;
    blockedBy?: readonly number[];
  } = {},
): Promise<LaneDispatchReport | LaneDispatchReport[]> {
  if (Array.isArray(ticket)) {
    return Promise.all(ticket.map((t) => laneOne(t, agentSpec, opts)));
  }
  return laneOne(ticket, agentSpec, opts);
}

async function laneOne(
  ticket: number | Ticket,
  agentSpec: LaneAgentSpec,
  opts: {
    confirm?: boolean;
    base?: string;
    cwd?: string;
    leasesPath?: string;
    blockedBy?: readonly number[];
  },
): Promise<LaneDispatchReport> {
  const t = typeof ticket === "number" ? await ticketOnBoard(ticket) : ticket;
  const [packet] = dispatchPackets([t]);
  if (packet === undefined) throw new Error("AP.lane: dispatchPackets returned no packet");
  const dor = dorChecklist(t.body);
  // #240: a ticket that mentions a browser gets a lease — deterministic names
  // from the ticket number (agentSpec.lease overrides), roster lane id from
  // the same label the spawn transport uses.
  const leasePlan: LaneLeasePlan | null = browserInvolved(t)
    ? {
        browserInvolved: true,
        lane: packet.worktree.branch.replaceAll("/", "-"),
        tabName: agentSpec.lease?.tabName ?? `l${t.number}`,
        threadPrefix: agentSpec.lease?.threadPrefix ?? `l${t.number}-`,
        registered: false,
      }
    : null;
  // #393: the pure edge plan from the ticket in hand — same facts the
  // confirm-path apply will re-derive through preflight. A duplicate
  // requested blocker dedups here; a self-edge surfaces as a plan error
  // (planDiff's verdict), never a silent drop.
  const requestedBlockers = [...new Set(opts.blockedBy ?? [])];
  const edgePlan: LaneEdgePlan | null =
    requestedBlockers.length > 0
      ? {
          requested: requestedBlockers,
          already: requestedBlockers.filter((b) => t.blockedBy.some((e) => e.number === b)),
          applied: [],
          errors: requestedBlockers
            .filter((b) => b === t.number)
            .map(() => `#${t.number}: self-blocking edge rejected`),
        }
      : null;
  const isDispatchable = dispatchable({ tickets: [t] }).length > 0;
  const refusalReasons: string[] = [];
  if (!isDispatchable) {
    refusalReasons.push(
      "board predicate unmet (open ∧ Todo ∧ no open blockers ∧ ¬ready-for-human) — flip Status via AP.apply first",
    );
  }
  const dryRun = !opts.confirm;
  const report: LaneDispatchReport = {
    ok: false,
    dryRun,
    number: t.number,
    title: t.title,
    dispatchable: isDispatchable,
    dor,
    refused: refusalReasons.length > 0,
    refusalReasons,
    worktree: packet.worktree,
    worktreeCreated: false,
    spawn: null,
    lease: leasePlan,
    blockedBy: edgePlan,
    spawned: false,
    transport: null,
    agentHandle: null,
    agentId: null,
    spawnError: null,
    statusFlipped: false,
    statusError: null,
    errors: [],
  };
  if (report.refused) {
    console.log(renderLaneReport(report));
    return report;
  }
  report.spawn = {
    agent: agentSpec.agent ?? "task",
    isolated: true,
    context: agentSpec.context ?? null,
    ...(agentSpec.model !== undefined ? { model: agentSpec.model } : {}),
    task:
      leasePlan !== null ? `${packet.context}\n\n${renderLeaseSection(leasePlan)}` : packet.context,
  };
  if (dryRun) {
    report.ok = true;
    console.log(
      renderLaneReport(report) + "\ndry-run: no worktree created (pass { confirm: true })",
    );
    return report;
  }
  const cwd = opts.cwd ?? process.cwd();
  // no existsSync pre-check: git's own failure ("already exists") is the
  // explicit signal, surfaced verbatim below — one less filesystem probe.
  const target = expandHome(packet.worktree.path);
  try {
    runGit(
      ["worktree", "add", target, "-b", packet.worktree.branch, opts.base ?? "origin/main"],
      cwd,
    );
    report.worktreeCreated = true;
  } catch (err) {
    report.errors.push(
      `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(renderLaneReport(report));
    return report;
  }
  // #206: the confirm path spawns for real. No transport → incomplete
  // dispatch (ok stays false, spawnError explains) — never a silent skip.
  const spawn = resolveSpawn();
  if ("missing" in spawn) {
    report.transport = "missing";
    report.spawnError = spawn.missing;
    console.log(renderLaneReport(report));
    return report;
  }
  report.transport = spawn.transport;
  // #240: register the browser lease BEFORE spawning — a collision aborts the
  // dispatch before a second lane ever touches the contested tab/thread, and
  // a spawn throw below rolls the registration back (the ledger must not hold
  // a lease for a lane that never started).
  if (leasePlan !== null) {
    try {
      lease(
        "browser",
        {
          lane: leasePlan.lane,
          tabName: leasePlan.tabName,
          threadPrefix: leasePlan.threadPrefix,
          number: t.number,
        },
        { path: opts.leasesPath },
      );
      leasePlan.registered = true;
    } catch (err) {
      report.errors.push(
        `browser lease registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.log(renderLaneReport(report));
      return report;
    }
  }
  try {
    report.agentHandle = await spawn.fn({
      prompt: packet.context,
      label: packet.worktree.branch.replaceAll("/", "-"),
      agent: report.spawn.agent,
      context: report.spawn.context,
      cwd: target,
      ...(report.spawn.model !== undefined ? { model: report.spawn.model } : {}),
    });
    report.spawned = true;
    report.agentId = agentIdOf(report.agentHandle);
  } catch (err) {
    report.spawnError = err instanceof Error ? err.message : String(err);
    if (leasePlan?.registered === true) {
      try {
        release("browser", { lane: leasePlan.lane }, { path: opts.leasesPath });
        leasePlan.registered = false;
      } catch (rollbackErr) {
        report.errors.push(
          `browser lease rollback failed: ${
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
          } — release manually via AP.release`,
        );
      }
    }
    console.log(renderLaneReport(report));
    return report;
  }
  // #393: dependency edges ride the dispatch — the PM never makes a second
  // apply call. Same addBlockedBy primitive, same preflight as apply (its
  // errors withhold ALL writes, so one bad blocker blocks the batch — the
  // outcome lands on report.blockedBy, never silent). Only a successful
  // spawn gets here: a failed dispatch leaves the board untouched.
  if (edgePlan !== null) {
    const edgeApply = await apply(
      edgePlan.requested.map((blocker) => ({
        op: "addBlockedBy" as const,
        number: t.number,
        blocker,
      })),
      { confirm: true },
    );
    const blockersOf = (changes: readonly PlannedChange[]): number[] =>
      changes.flatMap((c) => (c.mutation.op === "addBlockedBy" ? [c.mutation.blocker] : []));
    edgePlan.errors = [
      ...edgePlan.errors,
      ...edgeApply.preflight.errors,
      ...(edgeApply.verifyFailure !== undefined ? [edgeApply.verifyFailure.detail] : []),
    ];
    if (edgeApply.ok) {
      edgePlan.applied = blockersOf(edgeApply.preflight.willChange);
      edgePlan.already = blockersOf(edgeApply.preflight.noOps);
    }
  }
  // #206: the dispatch pipeline owns the board flip — the PM-recall version
  // drifted twice (forgot apply; cascade re-flip race). The guarded write
  // verifies, so an already-In-Progress ticket is a confirmed no-op. Only a
  // successful spawn may flip: the board must reflect reality.
  const flip = await apply([{ op: "setStatus", number: t.number, value: "In Progress" }], {
    confirm: true,
  });
  report.statusFlipped = flip.ok;
  if (!flip.ok) {
    report.statusError =
      (flip.verifyFailure?.detail ?? flip.errors.join("; ")) || "status flip failed";
  }
  report.ok = true;
  console.log(renderLaneReport(report));
  return report;
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
  closedConvergence:
    "Audit convergence write (#181): replays the close-event derived Status the sync missed (closed→Done, wontfix→Canceled) — the one closed-ticket write apply accepts.",
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
  if (
    isStatus &&
    (mutation.value === "Done" || mutation.value === "Canceled") &&
    ticket.state !== "CLOSED"
  ) {
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
      ? ticket.state === "CLOSED"
        ? SIDE_EFFECT_NOTES.closedConvergence
        : mutation.value === "In Progress"
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
      // #181 carve-out: the ONLY write a closed ticket accepts is the
      // convergence Status (Done/Canceled) — AP.audit replaying the
      // close-event sync write that went missing. Everything else stays
      // refused: board writes target open tickets.
      const convergence =
        mutation.op === "setStatus" && (mutation.value === "Done" || mutation.value === "Canceled");
      if (!convergence) {
        res.errors.push(
          `#${mutation.number}: ticket is CLOSED — board writes target open tickets only`,
        );
        continue;
      }
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
// Browser lease ledger (#240) — shared CDP/thread resources under a written
// ledger. 口头纪律结构化 (#239 comment 5988466175, 入验收规范): ① per-lane named
// tab, never the default tab or another lane's; ② the staging thread is a
// preemption resource (one in-flight turn per thread) — interactive tests
// create a dedicated thread under the lane's prefix, shared threads are
// forbidden, read-only observation sends nothing; ③ release on delivery.
// The store is an append-only jsonl — one LeaseEvent per line, replayed to
// derive the active set. AP.lane writes on dispatch; audit rule 6 reads.
// ---------------------------------------------------------------------------

/** Resource classes sharing the machine — browser first (#240); more classes
 *  (staging deploys, reserved threads, panels) join by extending the union. */
export type LeaseType = "browser";

/** Who holds what: the roster lane id, the named tab, the dedicated
 *  staging-thread prefix. `number` scopes the lease to its ticket when the
 *  holder is a ticket lane. */
export interface BrowserLeaseSpec {
  lane: string;
  tabName: string;
  threadPrefix: string;
  number?: number;
}

/** One jsonl line. A release event echoes the acquisition fields — the
 *  (type, lane, tabName, threadPrefix) tuple is the close key. */
export interface LeaseEvent {
  event: "acquired" | "released";
  type: LeaseType;
  lane: string;
  tabName: string;
  threadPrefix: string;
  number: number | null;
  acquiredAt: string;
  releasedAt: string | null;
}

/** The lane-facing lease plan AP.lane computes for a browser ticket and
 *  mirrors on LaneDispatchReport. */
export interface LaneLeasePlan {
  browserInvolved: boolean;
  /** Roster id (`lane-<number>-<slug>`) — the same label the spawn uses. */
  lane: string;
  tabName: string;
  threadPrefix: string;
  /** True once the confirm path registered the lease (false on dry-run,
   *  refusal, and after a spawn-throw rollback). */
  registered: boolean;
}

/** #393 dependency edges riding a dispatch: the requested blockers plus the
 *  plan (dry-run) or write outcome (confirm). Everything derives from the
 *  SAME preflight the apply write path uses — lane adds no second resolution
 *  truth. Dry-run: the pure plan from the ticket in hand (`applied` stays
 *  empty — the write happens on confirm); a failed spawn/dispatch never
 *  leaves `applied` populated (the board must reflect reality). */
export interface LaneEdgePlan {
  /** Blocker numbers as requested, deduped; self-edges stay visible via
   *  `errors` (planDiff rejects them there, not silently here). */
  requested: number[];
  /** Blockers whose edge already existed — preflight no-ops, nothing written. */
  already: number[];
  /** Edges this dispatch actually wrote (confirm + successful apply only). */
  applied: number[];
  /** Preflight rejections, verbatim (self-edge, blocker not on board/refs,
   *  apply verify drift). */
  errors: string[];
}

export interface LeaseOptions {
  /** Ledger file override (default: `.pm-leases.jsonl` at the repo root, or
   *  the `PM_LEASES_PATH` env). */
  path?: string;
  /** Reference clock (tests inject; default now). */
  now?: Date;
}

/** Default ledger: repo-local append-only jsonl next to `.env.local` —
 *  runtime state, gitignored, never committed. */
const DEFAULT_LEASES_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  ".pm-leases.jsonl",
);

const resolveLeasePath = (over?: string): string =>
  over ?? process.env.PM_LEASES_PATH ?? DEFAULT_LEASES_PATH;

function readLedger(path: string): LeaseEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // missing file = empty ledger, not an error
  }
  const events: LeaseEvent[] = [];
  for (const [i, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as LeaseEvent);
    } catch {
      throw new Error(
        `AP.lease ledger: corrupt jsonl at ${path}:${i + 1} — repair or delete the file`,
      );
    }
  }
  return events;
}

function appendLedger(record: LeaseEvent, path: string): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

/** Replay the event log to the active set (acquisition order). Exported pure:
 *  audit rule 6 consumes exactly this view. */
export function activeLeases(events: readonly LeaseEvent[]): LeaseEvent[] {
  const open = new Map<string, LeaseEvent>();
  for (const e of events) {
    const key = [e.type, e.lane, e.tabName, e.threadPrefix].join("\u0000");
    if (e.event === "acquired") open.set(key, e);
    else open.delete(key);
  }
  return [...open.values()];
}

/** Ticket text involving a browser — the same words the discipline names
 *  (浏览器/browser/CDP/Chrome). Deliberately narrow: a false positive costs a
 *  needless lease; a false negative leaks an unaccounted browser lane. */
const BROWSER_TASK_PATTERN = /浏览器|browser|CDP|chrome/i;

export function browserInvolved(t: Pick<Ticket, "title" | "body">): boolean {
  return BROWSER_TASK_PATTERN.test(`${t.title}\n${t.body}`);
}

/**
 * Register a lease acquisition (#240). Refuses — zero writes — on a collision:
 * the same tab or the same thread prefix actively held by ANOTHER lane, or the
 * same lane already holding the tab (release first, then re-acquire). This is
 * the enforcement point; audit rule 6 is the net for hand-edited ledgers.
 */
export function lease(
  type: LeaseType,
  spec: BrowserLeaseSpec,
  opts: LeaseOptions = {},
): LeaseEvent {
  const lane = spec.lane.trim();
  const tabName = spec.tabName.trim();
  const threadPrefix = spec.threadPrefix.trim();
  if (lane.length === 0 || tabName.length === 0 || threadPrefix.length === 0) {
    throw new Error(
      "AP.lease: lane, tabName and threadPrefix are all required — an anonymous lease is no lease",
    );
  }
  const path = resolveLeasePath(opts.path);
  const active = activeLeases(readLedger(path));
  const clash = active.find(
    (a) => a.lane !== lane && (a.tabName === tabName || a.threadPrefix === threadPrefix),
  );
  if (clash !== undefined) {
    throw new Error(
      `AP.lease: collision — ${type} tab=${clash.tabName} prefix=${clash.threadPrefix} ` +
        `is held by lane ${clash.lane} (acquired ${clash.acquiredAt}); release it or pick a distinct tab/prefix`,
    );
  }
  // No `a.type === type` guard yet: LeaseType has the single "browser" member,
  // so the comparison is statically vacuous. Re-add it when a second class
  // (staging deploy, reserved thread, …) joins the union.
  const held = active.find((a) => a.lane === lane && a.tabName === tabName);
  if (held !== undefined) {
    throw new Error(
      `AP.lease: lane ${lane} already holds ${type} tab=${held.tabName} ` +
        `(acquired ${held.acquiredAt}) — release before re-acquiring`,
    );
  }
  const record: LeaseEvent = {
    event: "acquired",
    type,
    lane,
    tabName,
    threadPrefix,
    number: spec.number ?? null,
    acquiredAt: (opts.now ?? new Date()).toISOString(),
    releasedAt: null,
  };
  appendLedger(record, path);
  return record;
}

/**
 * Close a lease (#240): sets releasedAt on the active lease matching the ref.
 * No active lease ⇒ throw (a release that closes nothing is drift, never a
 * silent no-op); an ambiguous ref (several active leases for the lane) ⇒
 * throw with a narrowing hint.
 */
export function release(
  type: LeaseType,
  ref: { lane: string; tabName?: string; threadPrefix?: string },
  opts: LeaseOptions = {},
): LeaseEvent {
  const path = resolveLeasePath(opts.path);
  const matches = activeLeases(readLedger(path)).filter(
    (a) =>
      a.lane === ref.lane.trim() &&
      (ref.tabName === undefined || a.tabName === ref.tabName.trim()) &&
      (ref.threadPrefix === undefined || a.threadPrefix === ref.threadPrefix.trim()),
  );
  if (matches.length === 0) {
    throw new Error(
      `AP.release: no active ${type} lease for lane ${ref.lane}` +
        (ref.tabName !== undefined ? ` tab=${ref.tabName}` : "") +
        " — nothing to release",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `AP.release: ${matches.length} active ${type} leases for lane ${ref.lane} — ` +
        "narrow with tabName/threadPrefix",
    );
  }
  const target = matches[0];
  if (target === undefined) {
    throw new Error(
      `AP.release: no active ${type} lease for lane ${ref.lane} — nothing to release`,
    );
  }
  const closed: LeaseEvent = {
    ...target,
    event: "released",
    releasedAt: (opts.now ?? new Date()).toISOString(),
  };
  appendLedger(closed, path);
  return closed;
}

/** Ledger view: every event plus the replayed active set — the audit's
 *  rule-6 input (`leases: AP.ledger().events`). */
export function ledger(opts: LeaseOptions = {}): { events: LeaseEvent[]; active: LeaseEvent[] } {
  const events = readLedger(resolveLeasePath(opts.path));
  return { events, active: activeLeases(events) };
}

/** The lease section appended to a browser lane's spawn context: named tab +
 *  thread prefix + release obligation, verbatim from the #239 discipline. */
function renderLeaseSection(plan: LaneLeasePlan): string {
  return [
    `# Browser lease (CDP/thread discipline, #240 — registered: ${plan.lane})`,
    `- tab: ${plan.tabName}（具名 tab；禁默认 tab、禁他人 tab）`,
    `- thread prefix: ${plan.threadPrefix}（staging thread=抢占资源，一 thread 一在飞 turn；` +
      `交互测试一律新建专属线程，禁用共享线程；只读观察零发送）`,
    `- release: 交付后由 PM \`AP.release("browser", { lane: "${plan.lane}" })\` 关账；` +
      `报告必须回报 tab/thread 使用与关闭状态`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Closeout evidence ledger (#277) — the acceptance-lane gate's written
// record. The #243 assembly: a code-delivering ticket closes ONLY after
// acceptance evidence exists — staging surfaces are box-checked by an
// acceptance lane, pure-code surfaces by CI (pm.md 验收关账 item 3; PM
// spot-checking is the wave-final sampling #246, never a close-out input).
// The store is an append-only jsonl — one CloseoutEvent per line.
// AP.closeout writes on acceptance; audit rule 7 reads (delivered without an
// entry = the gate was skipped at closeout).
// ---------------------------------------------------------------------------

/** Who produced the accepted evidence. An acceptance lane verifies the
 *  staging surface (真机操作+截图), CI verifies a pure-code surface; a PM
 *  spot-check is neither — it is the #246 wave-final sampling. */
export type AcceptanceSource = "acceptance-lane" | "ci";

/** One jsonl line: the acceptance verdict that lets a ticket close. The
 *  trio is mandatory (#239 paradigm): where the verdict lives, when it ran,
 *  which deployment it ran against — 空框 (unchecked box) is not evidence. */
export interface CloseoutEvent {
  event: "accepted";
  number: number;
  source: AcceptanceSource;
  /** Evidence anchor: acceptance comment / PR / CI run / report URL or
   *  file:line — the thing a reviewer opens to re-check the verdict. */
  evidence: string;
  /** ISO 8601 — when the acceptance actually ran. */
  date: string;
  /** Deployment the evidence was taken against: SERVER_VERSION short sha
   *  (`/api/v1/system/version`) for staging surfaces, the run id/ref for
   *  CI surfaces. */
  deploymentVersion: string;
  /** When the gate recorded it (tests inject; default now). */
  recordedAt: string;
}

export interface CloseoutOptions {
  /** Ledger file override (default: `.pm-closeouts.jsonl` at the repo
   *  root, or the `PM_CLOSEOUTS_PATH` env). */
  path?: string;
  /** Reference clock (tests inject; default now). */
  now?: Date;
}

const DEFAULT_CLOSEOUTS_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  ".pm-closeouts.jsonl",
);

function readCloseoutEvents(path: string): CloseoutEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // missing store = nothing accepted yet — the honest empty
  }
  const events: CloseoutEvent[] = [];
  for (const [i, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as CloseoutEvent);
    } catch {
      throw new Error(
        `AP.closeout ledger: corrupt jsonl at ${path}:${i + 1} — repair or delete the file`,
      );
    }
  }
  return events;
}

/** Numbers with a closeout on the ledger — audit rule 7's read view. The
 *  ledger is accepted-only today ("accepted" is the sole event kind; it
 *  names the record kind on disk the way LeaseEvent's does) — re-filter per
 *  kind here when a second kind (revocation, exemption) joins the union. */
export function acceptedNumbers(events: readonly CloseoutEvent[]): Set<number> {
  return new Set(events.map((e) => e.number));
}

/** Code-delivering tickets the gate covers (#277: 实现票交付→验收 lane 出证据
 *  →才可 merge/close). The W4 regression the gate answers (#254/#257/#266)
 *  carried exactly these labels; docs/research/decision tickets ship no
 *  runtime surface and stay outside the gate. */
const CLOSEOUT_GATE_LABELS: Record<string, true> = {
  "type:implementation": true,
  "type:bug": true,
};

export function closeoutGated(labels: readonly string[]): boolean {
  return labels.some((l) => CLOSEOUT_GATE_LABELS[l] === true);
}

/**
 * Record acceptance evidence for a ticket (#277). REFUSES — zero writes —
 * on an incomplete evidence trio: an acceptance without an evidence anchor
 * or a deployment version is the 空框 gate pretending to have passed and
 * cannot be re-checked later. Re-accepting a reopened ticket is legal
 * (append-only; the newest accepted entry carries).
 */
export function closeout(
  number: number,
  source: AcceptanceSource,
  evidence: { evidence: string; date?: string; deploymentVersion: string },
  opts: CloseoutOptions = {},
): CloseoutEvent {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(
      "AP.closeout: a ticket number is required — anonymous acceptance closes nothing",
    );
  }
  const anchor = evidence.evidence.trim();
  if (anchor.length === 0) {
    throw new Error(
      "AP.closeout: evidence anchor is required (acceptance comment / PR / CI run / " +
        "report URL or file:line) — 无证据不关票",
    );
  }
  const version = evidence.deploymentVersion.trim();
  if (version.length === 0) {
    throw new Error(
      "AP.closeout: deploymentVersion is required (SERVER_VERSION sha for staging, " +
        "run id/ref for CI) — evidence without a deployment cannot be re-checked",
    );
  }
  const now = (opts.now ?? new Date()).toISOString();
  const record: CloseoutEvent = {
    event: "accepted",
    number,
    source,
    evidence: anchor,
    date: evidence.date ?? now,
    deploymentVersion: version,
    recordedAt: now,
  };
  appendFileSync(
    opts.path ?? process.env.PM_CLOSEOUTS_PATH ?? DEFAULT_CLOSEOUTS_PATH,
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
  return record;
}

/** Ledger view: every event plus the accepted set — the audit's rule-7
 *  input (`closeouts: AP.closeoutLedger().events`). */
export function closeoutLedger(opts: CloseoutOptions = {}): {
  events: CloseoutEvent[];
  accepted: Set<number>;
} {
  const events = readCloseoutEvents(
    opts.path ?? process.env.PM_CLOSEOUTS_PATH ?? DEFAULT_CLOSEOUTS_PATH,
  );
  return { events, accepted: acceptedNumbers(events) };
}

// ---------------------------------------------------------------------------
// AP.audit (#181) — per-beat drift rules. Pure: reads a snapshot, reports
// board-vs-reality drift as findings + AP.apply-ready mutations, so the PM
// beat reconciles in one guarded apply BEFORE dispatching.
// ---------------------------------------------------------------------------

/** #393 prose-dependency narration: a line naming a dependency keyword makes
 *  every `#n` on that line a declared dependency. Line-scoped on purpose —
 *  a body-wide window drags in every incidental issue mention. */
export const PROSE_DEPENDENCY_PATTERN = /依赖|前置|须先|倒查|blocked/i;

/** Declared-dependency numbers in a body, first-seen order, deduped. */
export function proseDependencies(body: string): number[] {
  const refs: number[] = [];
  for (const line of body.split("\n")) {
    if (!PROSE_DEPENDENCY_PATTERN.test(line)) continue;
    for (const m of line.matchAll(/#(\d+)/g)) {
      const n = Number(m[1]);
      if (!refs.includes(n)) refs.push(n);
    }
  }
  return refs;
}

/** Drift rule ids (#181, #240, #277), disjoint — one finding per (ticket, rule):
 *  1 staleClosedStatus · 2 inProgressOnClosed · 3 laneStatusMismatch ·
 *  4 frontierAging · 6 browserLeaseMissing / browserLeaseCollision /
 *  browserLeaseUnreleased (armed only when `opts.leases` carries the ledger) ·
 *  7 closeoutNoEvidence (armed only when `opts.closeouts` carries the ledger) ·
 *  8 proseDependencyWithoutEdge (#393, always armed — pure over the snapshot). */
export type DriftRule =
  | "staleClosedStatus"
  | "inProgressOnClosed"
  | "laneStatusMismatch"
  | "frontierAging"
  | "browserLeaseMissing"
  | "browserLeaseCollision"
  | "browserLeaseUnreleased"
  | "closeoutNoEvidence"
  | "proseDependencyWithoutEdge";

/** Rule-4 threshold: a dispatchable Todo untouched this many days is aged
 *  (reminder class — the repair is a dispatch, not a board write). */
export const FRONTIER_AGE_DAYS = 7;

const DAY_MS = 86_400_000;

/** One drift finding. `mutation: null` = reminder only — the repair is an
 *  action (dispatch / roster fix), not a board write. */
export interface DriftFinding {
  rule: DriftRule;
  number: number;
  title: string;
  /** Observed vs expected, one line (console.table-ready). */
  detail: string;
  /** AP.apply-direct repair; every non-null entry lands in the report's
   *  flat `mutations` list. */
  mutation: Mutation | null;
}

export interface AuditReport {
  /** Findings in rule order (rules 1-3 in ticket order, then rule 4, then
   *  roster contradictions, then rule 6: missing in ticket order, unreleased
   *  in ledger order, collisions last, then rule 7 in ticket order, then
   *  rule 8 in ticket order). */
  drift: DriftFinding[];
  /** The apply-ready flat list — `AP.apply(rep.mutations, { confirm: true })`
   *  is the one-shot reconcile. */
  mutations: Mutation[];
  clean: boolean;
}

export interface AuditOptions {
  /** Lane numbers the PM believes alive: rule 3 checks their board Status,
   *  rule 4 stops counting them as undispatched, rule 6a scopes the
   *  browser-lease check to live lanes. */
  activeLanes?: readonly number[];
  /** Rule-4 threshold override (default FRONTIER_AGE_DAYS). */
  frontierAgeDays?: number;
  /** Reference clock for rule 4 (tests inject; default now). */
  now?: Date;
  /** Rule-6 input (#240): the lease ledger — pass `AP.ledger().events`.
   *  Omitted → rule 6 is silent: audit stays pure, and a missing ledger must
   *  never fabricate browser-lease findings. */
  leases?: readonly LeaseEvent[];
  /** Rule-7 input (#277): the closeout ledger — pass
   *  `AP.closeoutLedger().events`. Omitted → rule 7 is silent: a missing
   *  ledger must never fabricate closeout findings. */
  closeouts?: readonly CloseoutEvent[];
}

/**
 * Per-beat board drift audit (#181). The PM beat opens with it: audit →
 * `AP.apply(rep.mutations, { confirm: true })` → re-audit clean → dispatch.
 *
 * Rules (disjoint):
 *  1. staleClosedStatus — issue CLOSED but board Status ∉ {Done, Canceled}:
 *     the close event's sync write went missing. Repair = convergence write
 *     to the sync-derived value (wontfix→Canceled, else Done) — the ONE
 *     closed-ticket write AP.apply accepts.
 *  2. inProgressOnClosed — Status=In Progress on a CLOSED issue: a lane died
 *     without closeout. Same convergence repair, distinct signal — check the
 *     lane's worktree for unpushed work before letting it converge.
 *  3. laneStatusMismatch — a ticket in the PM's active-lane set whose Status
 *     ≠ In Progress: the lane(confirm) flip raced or was lost → flip
 *     mutation. Roster entries already converged (or absent from the board)
 *     are reported mutation-free: the roster is stale, the board is right.
 *  4. frontierAging — dispatchable (the SAME predicate the dispatcher
 *     clears), not on any active lane, issue untouched longer than N days:
 *     reminder, `mutation: null` — the repair is AP.lane. updatedAt is an
 *     aging PROXY (any issue event refreshes it); never a guard input.
 *  6. browser lease ledger (#240, armed by `opts.leases`) — all repairs are
 *     AP.lease/AP.release actions, `mutation: null`:
 *     6a browserLeaseMissing — an active lane whose ticket mentions a browser
 *        (浏览器/browser/CDP/Chrome) with no active browser lease for its
 *        number: the lane is touching CDP/thread resources off-ledger.
 *     6b browserLeaseCollision — the same tab or thread prefix actively held
 *        by two lanes (lease() refuses this at acquisition; the audit is the
 *        net for hand-edited ledgers).
 *     6c browserLeaseUnreleased — an active lease whose ticket is delivered
 *        (CLOSED, or Status Done/Canceled): the release obligation was
 *        skipped at closeout.
 *  7. closeoutNoEvidence (#277, armed by `opts.closeouts`) — a delivered
 *     code ticket (type:implementation / type:bug) with no accepted entry on
 *     the closeout ledger: the 实现→验收→关账 gate was skipped — the ticket
 *     merged/closed on self-report alone. Repair is an action, not a board
 *     write: `AP.closeout(...)` backfills the evidence trio (回填, #266 the
 *     first case) or the ticket reopens. Docs/research/decision tickets ship
 *     no runtime surface and are outside the gate.
 *  8. proseDependencyWithoutEdge (#393) — an open ticket whose body narrates
 *     a dependency (a `#n` on a line carrying 依赖/前置/须先/倒查/blocked) at
 *     a ticket on this board with no matching blockedBy edge: written-in-prose
 *     mechanism is not mechanism — the edge must materialize. Advisory
 *     (mutation: null, 观察一波 before any refusal upgrade): the repair is
 *     `AP.apply([{ op: "addBlockedBy", ... }])` or the dispatch arg
 *     `AP.lane(t, {}, { blockedBy: [n] })`. Self-references, off-board
 *     numbers, and already-edged dependencies stay silent.
 */
export function audit(snap: Pick<Snapshot, "tickets">, opts: AuditOptions = {}): AuditReport {
  const drift: DriftFinding[] = [];
  const active = new Set(opts.activeLanes ?? []);
  const nowMs = (opts.now ?? new Date()).getTime();
  const ageDays = opts.frontierAgeDays ?? FRONTIER_AGE_DAYS;

  for (const t of snap.tickets) {
    if (t.state === "CLOSED") {
      // Rules 1+2: closed issue with a stale board Status. Disjoint split —
      // rule 2 owns the In Progress case (lane died without closeout).
      if (t.status !== null && t.status !== "Done" && t.status !== "Canceled") {
        const inProgress = t.status === "In Progress";
        drift.push({
          rule: inProgress ? "inProgressOnClosed" : "staleClosedStatus",
          number: t.number,
          title: t.title,
          detail: inProgress
            ? "issue CLOSED but Status=In Progress — lane died without closeout; converge to the sync-derived value"
            : `issue CLOSED but Status=${t.status} — close-event sync write missing; converge to the sync-derived value`,
          // Sync-derived value (tracker-schema lifecycle): wontfix→Canceled,
          // closed→Done.
          mutation: {
            op: "setStatus",
            number: t.number,
            value: t.labels.includes("wontfix") ? "Canceled" : "Done",
          },
        });
      }
      continue; // closed tickets: rules 1/2 own them; rules 3/4 are open-only
    }
    if (active.has(t.number) && t.status !== "In Progress") {
      // Rule 3: the dispatch pipeline owns the In Progress flip — a live
      // lane whose ticket doesn't read In Progress is a lost flip.
      drift.push({
        rule: "laneStatusMismatch",
        number: t.number,
        title: t.title,
        detail: `active lane but Status=${t.status ?? "null"} — lane(confirm) flip lost; restore In Progress`,
        mutation: { op: "setStatus", number: t.number, value: "In Progress" },
      });
    }
  }

  // Rule 4: the SAME predicate the dispatcher clears (open ∧ Todo ∧ ¬rfh ∧
  // no open blockers), minus active lanes, aged past the threshold.
  for (const t of dispatchable(snap)) {
    if (active.has(t.number)) continue;
    const ageMs = nowMs - Date.parse(t.updatedAt);
    if (ageMs > ageDays * DAY_MS) {
      drift.push({
        rule: "frontierAging",
        number: t.number,
        title: t.title,
        detail: `dispatchable Todo untouched ${Math.floor(ageMs / DAY_MS)}d > ${ageDays}d — dispatch (AP.lane) or schedule`,
        mutation: null,
      });
    }
  }

  // Rule-3 roster contradictions the board itself cannot express.
  for (const n of active) {
    const t = snap.tickets.find((x) => x.number === n);
    if (t === undefined) {
      drift.push({
        rule: "laneStatusMismatch",
        number: n,
        title: "(not on board)",
        detail: "active-lane number missing from the snapshot — file it or correct the roster",
        mutation: null,
      });
    } else if (t.state === "CLOSED" && (t.status === "Done" || t.status === "Canceled")) {
      drift.push({
        rule: "laneStatusMismatch",
        number: n,
        title: t.title,
        detail:
          "active lane on a converged ticket — board already closed it out; stale roster entry",
        mutation: null,
      });
    }
  }

  // Rule 6 (#240): browser lease discipline over the CDP/thread ledger.
  if (opts.leases !== undefined) {
    // "browser" is the only LeaseType today — the ledger is browser-scoped by
    // construction; re-filter per type when the union grows.
    const held = activeLeases(opts.leases);
    // 6a: an active browser lane with nothing on the ledger.
    for (const t of snap.tickets) {
      if (t.state !== "OPEN" || !active.has(t.number) || !browserInvolved(t)) continue;
      if (held.some((a) => a.number === t.number)) continue;
      drift.push({
        rule: "browserLeaseMissing",
        number: t.number,
        title: t.title,
        detail:
          'active browser lane with no lease registered — AP.lease("browser", { lane, tabName, threadPrefix, number }) before browser work',
        mutation: null,
      });
    }
    // 6c: delivered ticket, lease still open — the release obligation was
    // skipped at closeout (the 空框不可关 companion: close the lease first).
    for (const a of held) {
      if (a.number === null) continue;
      const t = snap.tickets.find((x) => x.number === a.number);
      if (t === undefined) continue;
      const delivered = t.state === "CLOSED" || t.status === "Done" || t.status === "Canceled";
      if (!delivered) continue;
      drift.push({
        rule: "browserLeaseUnreleased",
        number: a.number,
        title: t.title,
        detail:
          `ticket delivered (state=${t.state}, Status=${t.status ?? "null"}) but the ` +
          `browser lease tab=${a.tabName} is still open — AP.release("browser", { lane: "${a.lane}" })`,
        mutation: null,
      });
    }
    // 6b: one tab / one thread prefix held by two lanes at once. Grouped by
    // contested key; one finding per late holder against the incumbent.
    const byKey = new Map<string, LeaseEvent[]>();
    for (const a of held) {
      for (const key of [`tab:${a.tabName}`, `prefix:${a.threadPrefix}`]) {
        const holders = byKey.get(key) ?? [];
        if (!holders.some((x) => x.lane === a.lane)) holders.push(a);
        byKey.set(key, holders);
      }
    }
    for (const [key, holders] of byKey) {
      const incumbent = holders[0];
      if (incumbent === undefined || holders.length < 2) continue;
      const late = holders.slice(1);
      for (const l of late) {
        const number = l.number ?? incumbent.number ?? 0;
        drift.push({
          rule: "browserLeaseCollision",
          number,
          title: snap.tickets.find((x) => x.number === number)?.title ?? "(not on board)",
          detail:
            `${key} held concurrently by lanes ${incumbent.lane} (acquired ${incumbent.acquiredAt}) ` +
            `and ${l.lane} (acquired ${l.acquiredAt}) — release or rename one`,
          mutation: null,
        });
      }
    }
  }

  // Rule 7 (#277): a delivered code ticket with nothing on the closeout
  // ledger — the acceptance-lane gate did not run before merge/close.
  if (opts.closeouts !== undefined) {
    const accepted = acceptedNumbers(opts.closeouts);
    for (const t of snap.tickets) {
      const delivered = t.state === "CLOSED" || t.status === "Done" || t.status === "Canceled";
      if (!delivered || !closeoutGated(t.labels) || accepted.has(t.number)) continue;
      drift.push({
        rule: "closeoutNoEvidence",
        number: t.number,
        title: t.title,
        detail:
          "delivered with no acceptance evidence on the closeout ledger — " +
          `backfill via AP.closeout(${t.number}, "acceptance-lane"|"ci", ` +
          "{ evidence, deploymentVersion }) or reopen; close-out stays REFUSED without it",
        mutation: null,
      });
    }
  }

  // Rule 8 (#393): a dependency narrated in prose but never materialized as
  // a blockedBy edge. Always armed (pure over the snapshot); advisory — the
  // PM materializes via apply/lane, the audit never writes. One finding per
  // ticket aggregating every missing edge, keeping the (ticket, rule)
  // disjointness invariant. Closed tickets are history: their dependency
  // ledger no longer gates anything.
  const byNumber = new Map(snap.tickets.map((t) => [t.number, t]));
  for (const t of snap.tickets) {
    if (t.state === "CLOSED") continue;
    const missing = proseDependencies(t.body).filter(
      (dep) => dep !== t.number && byNumber.has(dep) && !t.blockedBy.some((b) => b.number === dep),
    );
    if (missing.length === 0) continue;
    drift.push({
      rule: "proseDependencyWithoutEdge",
      number: t.number,
      title: t.title,
      detail:
        `prose declares dependency on ${missing.map((n) => `#${n}`).join(", ")} ` +
        "with no blockedBy edge — materialize via " +
        `AP.apply([{ op: "addBlockedBy", number: ${t.number}, blocker: ${missing[0]} }], { confirm: true }) ` +
        `or the dispatch arg AP.lane(${t.number}, {}, { blockedBy: [${missing[0]}] })`,
      mutation: null,
    });
  }

  const mutations = drift.flatMap((d) => (d.mutation === null ? [] : [d.mutation]));
  return { drift, mutations, clean: drift.length === 0 };
}

// ---------------------------------------------------------------------------
// Filing (#151): intake → create → closed-vocab labels → fields → edges → status
// ---------------------------------------------------------------------------

/** Confidence floor for auto-applying a classified dimension at filing time
 *  (gateOf's auto-apply threshold, applied per-dimension). */
export const FILE_CONFIDENCE_FLOOR = 0.8;

/** Raw filing request. Everything else derives from intake or resolves live
 *  resolves at runtime. Explicit fields (#151 defect 1) are AUTHORITATIVE:
 *  the judge only fills dimensions the spec leaves undefined — a pinned
 *  value is never re-classified, re-scored, or demoted by intake. */
export interface FileSpec {
  title: string;
  body: string;
  /** Issue numbers the new ticket is blocked by (dependency axis only). */
  blockedBy?: number[];
  /** Explicit label axis. When present, it replaces the derived
   *  block/type/needs_human label set verbatim and the judge is not asked
   *  about those dimensions at all (their board effect IS the labels). */
  labels?: string[];
  /** Explicit milestone TITLE — exact-matched against the live open
   *  milestones (no fuzzy rewrite; "M1.5: …" never becomes "M1"). Null pins
   *  unscheduled; undefined defers to the judge. */
  milestone?: string | null;
  /** Explicit classification pins (same undefined = judge rule). */
  block?: IntakeResult["block"];
  type?: IntakeResult["type"];
  priority?: PriorityName | null;
  /** Explicit ready-for-human pin (question skipped when present). */
  needsHuman?: boolean;
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
  "milestone" | "block" | "type" | "priority" | "needs_probe" | "needs_human";

/** A classified dimension below the confidence floor: PM re-rules it. */
export interface FileReviewItem {
  dimension: FileDimension;
  suggested: string | null;
  confidence: number;
}

export interface FileReport {
  ok: boolean;
  dryRun: boolean;
  /** Dimensions pinned in the spec — authoritative over the judge (#151). */
  explicitDims: string[];
  /** Raw judge verdict the plan was derived from (audit trail). */
  intake: IntakeResult;
  plan: FilePlan;
  /** Dimensions below FILE_CONFIDENCE_FLOOR — suggested, never auto-applied. */
  pmReview: FileReviewItem[];
  errors: string[];
  /** Set only after a confirmed filing passed post-write verification. */
  created?: { number: number; id: string; url: string | null };
  /** Set when a confirmed filing failed AFTER creation: the issue was
   *  rolled back (board item removed + closed as not_planned) — all-or-
   *  nothing (#151 defect 2). `created` stays unset; the caller only ever
   *  sees a clean failure. */
  rolledBack?: { number: number; steps: string[]; failures: string[] };
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
  spec: Pick<
    FileSpec,
    "blockedBy" | "labels" | "milestone" | "block" | "type" | "priority" | "needsHuman"
  >,
  cls: IntakeResult,
): {
  plan: Omit<FilePlan, "milestoneNumber">;
  pmReview: FileReviewItem[];
  /** Dimensions pinned by the spec (authoritative — never judge-ruled). */
  explicitDims: string[];
} {
  const labelsExplicit = spec.labels !== undefined;
  const explicit = {
    milestone: spec.milestone !== undefined,
    block: spec.block !== undefined,
    type: spec.type !== undefined,
    priority: spec.priority !== undefined,
    needsHuman: spec.needsHuman !== undefined,
  };
  /** Was this dimension actually judged? Explicit pins and the label axis
   *  (when `labels` is explicit) are skipped — their confidence 0 would
   *  otherwise fake its way into pmReview. */
  const judged = (d: FileDimension): boolean => {
    switch (d) {
      case "milestone":
        return !explicit.milestone;
      case "block":
      case "type":
        return !labelsExplicit && !explicit[d];
      case "priority":
        return !explicit.priority;
      case "needs_probe":
        return true;
      case "needs_human":
        return !explicit.needsHuman && !labelsExplicit;
    }
  };
  const confident = (d: FileDimension): boolean =>
    judged(d) && cls.confidence[d] >= FILE_CONFIDENCE_FLOOR;

  // Label axis: explicit labels win verbatim; otherwise derive from the
  // applied block/type/needs_human (explicit pin first, judged second).
  const blockApplied =
    spec.block !== undefined ? spec.block : confident("block") ? cls.block : null;
  const typeApplied = spec.type !== undefined ? spec.type : confident("type") ? cls.type : null;
  const needsHuman = explicit.needsHuman
    ? spec.needsHuman === true
    : confident("needs_human")
      ? cls.needs_human
      : false;
  const derivedLabels: string[] = [];
  if (blockApplied !== null && blockApplied !== "none") derivedLabels.push(blockApplied);
  if (typeApplied !== null) derivedLabels.push(typeApplied);
  if (needsHuman) derivedLabels.push("ready-for-human");
  const labels = labelsExplicit ? [...new Set(spec.labels)] : derivedLabels;

  const milestone =
    spec.milestone !== undefined
      ? spec.milestone
      : cls.milestone !== null && cls.milestone !== "none" && confident("milestone")
        ? cls.milestone
        : null;
  const priority =
    spec.priority !== undefined
      ? spec.priority
      : cls.priority !== null && confident("priority")
        ? cls.priority
        : null;
  const status: StatusName = needsHuman ? "Wait for user" : milestone !== null ? "Todo" : "Backlog";
  const suggestedOf = (d: FileDimension): string | null => {
    const v: unknown = cls[d];
    return typeof v === "string" ? v : typeof v === "boolean" ? String(v) : null;
  };
  const pmReview = FILE_DIMENSIONS.filter(
    (d) => judged(d) && cls.confidence[d] < FILE_CONFIDENCE_FLOOR,
  ).map((d) => ({
    dimension: d,
    suggested: suggestedOf(d),
    confidence: cls.confidence[d],
  }));
  const explicitDims = Object.entries(explicit)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (labelsExplicit) explicitDims.push("labels");
  return {
    plan: {
      labels,
      milestone,
      priority,
      status,
      blockedBy: [...new Set(spec.blockedBy ?? [])].sort((a, b) => a - b),
    },
    pmReview,
    explicitDims,
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
    updatedAt: raw.updatedAt,
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

/** #270: exported for the pm_apply tool wrapper — same diff, tool-facing. */
export function renderPreflight(report: PreflightReport): string {
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

/**
 * #151 all-or-nothing rollback for a confirmed filing that failed after
 * creation. GitHub cannot delete issues, so the undo is: remove the board
 * item (when it landed) and close the issue as not_planned. Both steps are
 * best-effort — each failure is reported, never thrown, so the caller gets
 * one complete failure report instead of a half-undone surprise.
 */
async function rollbackFiling(
  issue: { id: string; number: number },
  itemIds: Map<number, string>,
): Promise<{ steps: string[]; failures: string[] }> {
  const steps: string[] = [];
  const failures: string[] = [];
  const itemId = itemIds.get(issue.number);
  if (itemId !== undefined) {
    try {
      await gql(TEMPLATES.deleteProjectItem, { projectId: PROJECT_ID, itemId });
      steps.push(`board item ${itemId} removed`);
    } catch (err) {
      failures.push(
        `board item ${itemId} removal failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    await gql(TEMPLATES.closeIssue, { id: issue.id, stateReason: "NOT_PLANNED" });
    steps.push("issue closed as not_planned");
  } catch (err) {
    failures.push(`close failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { steps, failures };
}

function renderFileReport(spec: FileSpec, report: FileReport): string {
  const pinned = (dim: string): string => (report.explicitDims.includes(dim) ? " (explicit)" : "");
  const lines = [
    `== AP.file ${report.dryRun ? "preview (dry-run)" : "filing report"} ==`,
    `  TITLE     ${spec.title}`,
    `  LABELS    ${report.plan.labels.join(", ") || "(none)"}${pinned("labels")}`,
    `  MILESTONE ${report.plan.milestone ?? "(none)"}${pinned("milestone")}${
      report.plan.milestoneNumber !== null ? ` (#${report.plan.milestoneNumber})` : ""
    }`,
    `  PRIORITY  ${report.plan.priority ?? "(unset)"}${pinned("priority")}`,
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
  if (report.created !== undefined)
    lines.push(`  CREATED   #${report.created.number} (${report.created.url ?? "no url"})`);
  if (report.rolledBack !== undefined) {
    lines.push(
      `  ROLLED BACK #${report.rolledBack.number}: ${report.rolledBack.steps.join("; ") || "(no steps)"}`,
    );
    for (const f of report.rolledBack.failures) lines.push(`  ROLLBACK FAILURE ${f}`);
  }
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
    repo === null
      ? null
      : ((repo as unknown as Record<string, VerifyIssue | null>)[aliases[0] ?? ""] ?? null);
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
 * Explicit spec fields (#151 defect 1) are authoritative: the judge is only
 * asked the dimensions the spec leaves undefined (labels explicit ⇒ the whole
 * label axis is skipped; a pinned milestone is never re-classified), and a
 * pinned value is never demoted by intake confidence. Milestone titles are
 * exact-matched against the live open milestones — "M1.5: …" never rewrites
 * to "M1" (#151 defect 2).
 *
 * Invariant-5 guard: plan labels must exist in the repository vocabulary
 * BEFORE anything is created — the REST create path auto-creates unknown
 * label names, so filing goes GraphQL-only (createIssue carries no labels;
 * addLabels uses pre-resolved ids) and hard-fails (zero writes, even on
 * confirm) on any unregistered name. Dimensions the judge classified below
 * FILE_CONFIDENCE_FLOOR never auto-apply: they are demoted to the pmReview
 * list for PM re-ruling. The milestone title → number map is resolved from
 * the live repository at runtime, never hardcoded.
 *
 * All-or-nothing (#151 defect 2): once the issue exists, ANY failed write or
 * failed post-write verification rolls the filing back (board item removed,
 * issue closed as not_planned) and reports ok:false with `rolledBack` —
 * `created` is only ever set for a fully verified filing.
 */
export async function file(spec: FileSpec, opts: { confirm?: boolean } = {}): Promise<FileReport> {
  // Explicit fields skip their judge questions (#151): labels explicit also
  // skips block/type/needs_human — their only board effect IS the labels.
  const omit: string[] = [];
  if (spec.milestone !== undefined) omit.push("milestone");
  if (spec.labels !== undefined) omit.push("block", "type", "needs_human");
  if (spec.block !== undefined && !omit.includes("block")) omit.push("block");
  if (spec.type !== undefined && !omit.includes("type")) omit.push("type");
  if (spec.priority !== undefined) omit.push("priority");
  if (spec.needsHuman !== undefined && !omit.includes("needs_human")) omit.push("needs_human");
  const cls = await intake(spec.body, { omit });
  const { plan: derived, pmReview, explicitDims } = planFile(spec, cls);
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
      `milestone "${plan.milestone}" not found among open milestones (exact title match ` +
        "required — closed vocabulary; explicit titles are never fuzzy-rewritten, #151)",
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

  const base: FileReport = {
    ok: false,
    dryRun: !opts.confirm,
    explicitDims,
    intake: cls,
    plan,
    pmReview,
    errors,
  };
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
  const payload = createData.createIssue as {
    issue: { id: string; number: number; url: string | null } | null;
  } | null;
  const issue = payload?.issue ?? null;
  if (issue === null) throw new Error("AP.file: createIssue returned no issue");

  const itemIds = new Map<number, string>();
  let writeError: string | null = null;
  try {
    if (plan.labels.length > 0) {
      const ids: string[] = [];
      for (const l of plan.labels) {
        const id = labelIds[l];
        if (id === undefined) throw new Error(`AP.file: label ${l} lost between guard and write`);
        ids.push(id);
      }
      await gql(TEMPLATES.addLabels, { labelableId: issue.id, labelIds: ids });
    }

    const ops: ResolvedOp[] = [
      { kind: "addProjectItem", number: issue.number, issueNodeId: issue.id },
    ];
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
    if (statusWrite === null)
      throw new Error("AP.file: status option lost between guard and write");
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
    for (const batch of batchOps(ops)) {
      for (const op of batch) await execOp(op, itemIds);
    }
  } catch (err) {
    writeError = err instanceof Error ? err.message : String(err);
  }

  const verifyErrors =
    writeError === null ? await verifyFiling(issue.number, plan, vocabulary) : [];
  if (writeError !== null) errors.push(`write failed after creation: ${writeError}`);
  if (verifyErrors.length > 0) errors.push(...verifyErrors);

  if (errors.length > 0) {
    // All-or-nothing (#151 defect 2): a half-filed issue is worse than no
    // issue — undo everything the board can see, then report the failure
    // explicitly (created stays unset; the caller never sees a fake success).
    const rolledBack = await rollbackFiling(issue, itemIds);
    const report: FileReport = {
      ...base,
      ok: false,
      errors,
      rolledBack: { number: issue.number, ...rolledBack },
    };
    console.error(
      `AP.file: filing FAILED after creation — rolled back #${issue.number}: ` +
        (rolledBack.steps.join("; ") || "no rollback steps succeeded"),
    );
    if (rolledBack.failures.length > 0) {
      console.error(
        `AP.file: ROLLBACK INCOMPLETE — manual cleanup required: ${rolledBack.failures.join("; ")}`,
      );
    }
    console.log(renderFileReport(spec, report));
    return report;
  }
  const created = { number: issue.number, id: issue.id, url: issue.url };
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
 *  model call, never auto-writes — the gate decides who reads the result.
 *  `omit` (#151) drops the named questions from the call — explicit spec
 *  fields skip the judge entirely; the reply classifies with confidence 0
 *  (→ needs-human gate) for anything omitted, which callers must treat as
 *  "not asked", never as a bad verdict. */
export async function intake(
  body: string,
  opts: { omit?: readonly string[] } = {},
): Promise<IntakeResult> {
  const state =
    "Classify this cloudflare-agent-project ticket for the tracker " +
    "(docs/agents/tracker-schema.md axes). Judge by what the body ships, " +
    "not by label mentions alone. Ticket body:\n" +
    body;
  const questions =
    opts.omit === undefined || opts.omit.length === 0
      ? INTAKE_QUESTIONS
      : Object.fromEntries(
          Object.entries(INTAKE_QUESTIONS).filter(([k]) => !opts.omit?.includes(k)),
        );
  return classifyIntake(await (injected?.judge ?? defaultJudge)(state, questions));
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export const AP = {
  snapshot,
  dispatchable,
  audit,
  closeout,
  closeoutLedger,
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
  lane,
  registerSpawn,
  lease,
  release,
  ledger,
  dorChecklist,
  /** Pure internals, exposed for tests/inspection. */
  pure: {
    slugify,
    planDiff,
    planCascade,
    budgetOf,
    FILE_CONFIDENCE_FLOOR,
    FRONTIER_AGE_DAYS,
    browserInvolved,
    activeLeases,
    acceptedNumbers,
    closeoutGated,
  },
  /** Judge layer: question oracle + real transport (tests mock via fetch). */
  judge: { INTAKE_QUESTIONS, JEV_URL, JEV_MODEL, defaultJudge },
  /** Config actually in effect. */
  config: { PROJECT_ID, REPO },
} as const;

const globalScope = globalThis as { AP?: typeof AP };
globalScope.AP ??= AP;
