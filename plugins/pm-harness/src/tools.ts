/**
 * tools.ts — #270 the pm-harness custom-tool family for omp.
 *
 * Five model-callable tools over the AP core (./core.ts), registered through
 * the omp custom-tools pipeline (package.json `omp.tools` → this module's
 * default-export factory → the same tool registry as the built-ins; with
 * `tools.xdev` enabled they additionally mount under `xd://pm_*`, the
 * `xd://github` precedent):
 *
 *   pm_lane    — gate → worktree provision → spawn (transport ladder:
 *                registerSpawn override → eval-kernel globalThis.agent →
 *                #270 detached `omp -p` fallback) → blockedBy edges
 *                materialized with the dispatch (#393) → guarded board flip
 *   pm_apply   — the ONLY write path: preflight diff (dry-run default) →
 *                batched guarded writes with per-batch re-verify (drift →
 *                remaining batches withheld)
 *   pm_audit   — board-vs-reality drift reconcile (walk-due rule 8 always
 *                armed from the repo ledger, incl. #393 rule 9
 *                proseDependencyWithoutEdge); returns pm_apply-ready
 *                mutations (read-only: nothing writes here)
 *   pm_release — browser-lease release (ledger close-out)
 *   pm_ledger  — browser-lease ledger read (events + active set)
 *   pm_walk    — 走查挂账 ledger (#391): register {ticket, due, face},
 *                settle with evidence, or read events + active set
 *
 * Safety posture inherited from the core, unchanged: closed-state Statuses
 * (Done/Canceled) are rejected as write targets, unknown labels/milestones/
 * statuses are preflight errors, and every write is dry-run until
 * `confirm: true`.
 *
 * The detached-omp fallback is installed once at factory time so every lane()
 * call from this process resolves a transport even with no eval kernel:
 * `omp -p <lane context> --cwd <worktree>`, detached, stdout/stderr →
 * `<worktree>/.pm-lane.log`. Escape hatch: PM_LANE_NO_DETACH=1 restores the
 * transport-missing contract. Tests import core directly and never install
 * the fallback, so core.test.ts's transport-missing assertions stay valid.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import type { Mutation } from "./core.js";
import {
  apply,
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  audit,
  lane,
  ledger,
  registerSpawnFallback,
  release,
  renderPreflight,
  snapshot,
  walkDue,
  walkDone,
  walkLedger,
} from "./core.js";
import type {
  ApplyReport,
  AuditReport,
  LaneDispatchReport,
  Snapshot,
  SpawnRequest,
} from "./core.js";
import { walk } from "./walk.js";
import type { WalkReport } from "./walk.js";
import type { CustomTool, CustomToolAPI, CustomToolFactory, ToolResult } from "./host-types.js";

// ---------------------------------------------------------------------------
// Detached-omp spawn fallback (#270)
// ---------------------------------------------------------------------------

/** Receipt for a detached lane: plain JSON by contract (it lands in tool
 *  details). `id` is shaped for the core's agentIdOf unwrapping. */
export interface DetachedLaneHandle {
  id: string;
  pid: number | null;
  log: string;
  cwd: string;
  transport: "detached-omp-print";
}

/** #270 default transport when no kernel/override exists: a detached headless
 *  `omp -p` session rooted IN the provisioned worktree. Fire-and-forget — the
 *  dispatch returns immediately with the child pid and log path; the lane
 *  session persists under ~/.omp/agent/sessions (resumable via
 *  `omp --resume`). Throws when the request carries no worktree cwd: a lane
 *  pointed at the main checkout is exactly what the gate exists to prevent. */
export function detachedLaneSpawn(p: SpawnRequest): DetachedLaneHandle {
  if (typeof p.cwd !== "string" || p.cwd.length === 0) {
    throw new Error(
      "detached-omp fallback: spawn request carries no worktree cwd — refusing to spawn a lane outside a provisioned worktree",
    );
  }
  const logPath = join(p.cwd, ".pm-lane.log");
  let out = -1;
  try {
    out = openSync(logPath, "a");
    const child = spawn("omp", ["-p", p.prompt, "--cwd", p.cwd], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    return {
      id: `pid-${child.pid ?? "unknown"}`,
      pid: child.pid ?? null,
      log: logPath,
      cwd: p.cwd,
      transport: "detached-omp-print",
    };
  } finally {
    if (out !== -1) closeSync(out);
  }
}

// ---------------------------------------------------------------------------
// Tool args — declared beside each schema (schema is the wire contract; omp
// validates params against it before execute)
// ---------------------------------------------------------------------------

export interface LaneArgs {
  ticket: number | number[];
  agent?: string;
  model?: string;
  /** #393: dependency edges materialized with the dispatch (same addBlockedBy
   *  primitive + preflight as pm_apply). */
  blockedBy?: number[];
  /** false/omitted → dry-run plan (DoR table + spawn plan, zero writes). */
  confirm?: boolean;
  base?: string;
  leasesPath?: string;
}

export type MutationArgs = Mutation;

export interface ApplyArgs {
  mutations: MutationArgs[];
  /** false/omitted → preflight diff only, zero writes. */
  confirm?: boolean;
}

export interface AuditArgs {
  /** Lane numbers the PM believes alive (audit rules 3/4/6a scoping). */
  activeLanes?: number[];
  /** Arm rule 6 (browser-lease drift) from the repo ledger. Default false —
   *  audit stays pure unless the caller opts in. */
  withLeases?: boolean;
  leasesPath?: string;
  /** Walk-due ledger path override (rule 8 is always armed from the repo
   *  ledger — an overdue deferral must surface on every audit, #391). */
  walksPath?: string;
}

export interface ReleaseArgs {
  type: "browser";
  lane: string;
  tabName?: string;
  threadPrefix?: string;
  leasesPath?: string;
}

export interface LedgerArgs {
  leasesPath?: string;
}

export interface WalkArgs {
  url: string;
  checks?: { selector: string; atLeast?: number; text?: string }[];
  tabName?: string;
  cdpHttp?: string;
  settleMs?: number;
  outDir?: string;
  allowFetchFallback?: boolean;
}

export interface WalkLedgerArgs {
  action: "register" | "done" | "list";
  /** Ticket number (register/done). */
  number?: number;
  /** ISO-8601 due date (register). */
  due?: string;
  /** 走查面 — what exactly is walked, one line (register). */
  face?: string;
  /** Evidence anchor: walk report / comment / PR (done). */
  evidence?: string;
  walksPath?: string;
}

// ---------------------------------------------------------------------------
// Details pickers — JSON-safe, schema-shaped (renderer/state reconstruction
// contract); opaque handles (kernel agent handles, ChildProcess) never enter
// tool details, only their extracted ids.
// ---------------------------------------------------------------------------

function laneDetails(r: LaneDispatchReport): Record<string, unknown> {
  return {
    ok: r.ok,
    dryRun: r.dryRun,
    number: r.number,
    title: r.title,
    dispatchable: r.dispatchable,
    dor: r.dor,
    refused: r.refused,
    refusalReasons: r.refusalReasons,
    worktree: r.worktree,
    worktreeCreated: r.worktreeCreated,
    lease: r.lease,
    blockedBy: r.blockedBy,
    spawned: r.spawned,
    transport: r.transport,
    agentId: r.agentId,
    spawnError: r.spawnError,
    statusFlipped: r.statusFlipped,
    statusError: r.statusError,
    errors: r.errors,
  };
}

function applyDetails(r: ApplyReport): Record<string, unknown> {
  return {
    ok: r.ok,
    dryRun: r.dryRun,
    preflight: r.preflight,
    appliedBatches: r.appliedBatches,
    verified: r.verified,
    verifyFailure: r.verifyFailure ?? null,
    errors: r.errors,
  };
}

function auditDetails(rep: AuditReport, snap: Snapshot): Record<string, unknown> {
  return {
    clean: rep.clean,
    drift: rep.drift,
    mutations: rep.mutations,
    boardTicketCount: snap.tickets.length,
    boardTruncated: snap.truncated,
  };
}

// ---------------------------------------------------------------------------
// Text renderers — one compact block per tool (the model-facing summary; the
// structured truth rides in details)
// ---------------------------------------------------------------------------

function renderLane(reports: LaneDispatchReport[]): string {
  return reports
    .map((r) => {
      const head = `== pm_lane ${
        r.refused ? "REFUSED" : r.dryRun ? "plan (dry-run)" : r.ok ? "dispatched" : "incomplete"
      } #${r.number} ==`;
      const lines = [
        head,
        `  ${r.title}`,
        `  worktree: ${r.worktree.branch} @ ${r.worktree.path}` +
          (r.dryRun ? "" : r.worktreeCreated ? " (created)" : " (create FAILED)"),
      ];
      if (r.refusalReasons.length > 0) {
        lines.push(`  refusal: ${r.refusalReasons.join("; ")}`);
      }
      if (r.lease !== null) {
        lines.push(
          `  lease: ${r.lease.lane} tab=${r.lease.tabName} prefix=${r.lease.threadPrefix}` +
            (r.lease.registered ? " (registered)" : ""),
        );
      }
      if (r.blockedBy !== null) {
        const e = r.blockedBy;
        const refs = (bs: readonly number[]): string => bs.map((b) => `#${b}`).join(", ");
        if (e.applied.length > 0) {
          lines.push(`  edges: materialized ${refs(e.applied)}`);
        } else {
          lines.push(
            `  edges: ${refs(e.requested)}` +
              (r.dryRun ? " (plan — materialize on confirm)" : " (NOT applied)"),
          );
        }
        if (e.already.length > 0) lines.push(`  edges: already ${refs(e.already)} (no-op)`);
        for (const err of e.errors) lines.push(`  ERROR ${err}`);
      }
      if (!r.dryRun) {
        lines.push(
          `  spawn: ${r.spawned ? `ok via ${r.transport}` : `FAILED — ${r.spawnError ?? "unknown"}`}` +
            (r.agentId !== null ? ` (${r.agentId})` : ""),
        );
        lines.push(
          `  board flip: ${r.statusFlipped ? "In Progress ✓" : `FAILED — ${r.statusError ?? "unknown"}`}`,
        );
      }
      const handle = r.dryRun ? [] : ["  log: <worktree>/.pm-lane.log (detached lane)"];
      return [...lines, ...handle, ...r.errors.map((e) => `  ERROR ${e}`)].join("\n");
    })
    .join("\n\n");
}

function renderApply(r: ApplyReport): string {
  const head = r.dryRun
    ? "== pm_apply preflight (dry-run — pass confirm:true to write) =="
    : r.ok
      ? "== pm_apply applied + verified =="
      : "== pm_apply FAILED ==";
  const lines = [head, renderPreflight(r.preflight)];
  if (r.appliedBatches.length > 0) {
    lines.push(`  batches applied: ${JSON.stringify(r.appliedBatches)}`);
  }
  if (r.verifyFailure !== undefined) {
    lines.push(`  VERIFY DRIFT — remaining batches withheld: ${r.verifyFailure.detail}`);
  }
  return lines.join("\n");
}

function renderAudit(rep: AuditReport): string {
  if (rep.clean) return "== pm_audit: board clean ==";
  const lines = [`== pm_audit: ${rep.drift.length} finding(s) ==`];
  for (const d of rep.drift) {
    lines.push(`  [${d.rule}] #${d.number} ${d.title} — ${d.detail}`);
    if (d.mutation !== null) lines.push(`    repair: ${JSON.stringify(d.mutation)}`);
  }
  lines.push("  feed the mutations list to pm_apply (dry-run first, then confirm).");
  return lines.join("\n");
}

function renderWalk(rep: WalkReport): string {
  const lines = [
    `== pm_walk: ${rep.ok ? "PASS" : "FAIL"} ${rep.url}`,
    `  transport=${rep.transport}${rep.cdpHttp === "" ? "" : ` (${rep.cdpHttp})`} tab=${rep.tabName}` +
      ` console=${rep.consoleCapture}`,
    `  title=${JSON.stringify(rep.title)} finalUrl=${rep.finalUrl}`,
    `  checks=${String(rep.checks.filter((c) => c.passed).length)}/${String(rep.checks.length)}` +
      ` passed consoleErrors=${String(rep.consoleErrors.length)}` +
      ` failedRequests=${String(rep.failedRequests.length)}`,
  ];
  for (const check of rep.checks) {
    lines.push(
      `  ${check.passed ? "PASS" : "FAIL"} ${check.selector} count=${String(check.count)}` +
        ` ≥${String(check.atLeast)}${check.why !== undefined ? ` — ${check.why}` : ""}`,
    );
  }
  for (const error of rep.consoleErrors.slice(0, 5)) {
    lines.push(`  [${error.kind}] ${error.text.slice(0, 160)}`);
  }
  if (rep.consoleErrors.length > 5)
    lines.push(`  … ${String(rep.consoleErrors.length - 5)} more console errors`);
  for (const failed of rep.failedRequests.slice(0, 5)) {
    lines.push(
      `  [net] ${failed.url.slice(0, 140)}${failed.status !== undefined ? ` → ${String(failed.status)}` : ""}`,
    );
  }
  if (rep.failedRequests.length > 5)
    lines.push(`  … ${String(rep.failedRequests.length - 5)} more failed requests`);
  lines.push(`  evidence=${rep.evidence.anchor === "" ? "(not written)" : rep.evidence.anchor}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/** Installs the #270 detached-omp fallback once per process. Idempotent: the
 *  factory is rebound per session, but the fallback slot is module-global in
 *  the core and re-registering the same function is a no-op. */
export const createPmHarnessTools = (pi: CustomToolAPI): CustomTool[] => {
  registerSpawnFallback(detachedLaneSpawn);
  const z = pi.zod;

  const mutationSchema = z.union([
    z.object({
      op: z.enum(["setStatus"]),
      number: z.number().describe("Issue number"),
      value: z
        .enum(STATUS_OPTIONS)
        .describe("Target Status (closed states only for CLOSED issues)"),
    }),
    z.object({
      op: z.enum(["setPriority"]),
      number: z.number().describe("Issue number"),
      value: z.enum(PRIORITY_OPTIONS).describe("Target Priority"),
    }),
    z.object({
      op: z.enum(["setMilestone"]),
      number: z.number().describe("Issue number"),
      value: z.union([z.string(), z.null()]).describe("Milestone title; explicit null clears"),
    }),
    z.object({
      op: z.enum(["addBlockedBy"]),
      number: z.number().describe("Issue that becomes blocked"),
      blocker: z.number().describe("Blocking issue number"),
    }),
    z.object({
      op: z.enum(["addLabels"]),
      number: z.number().describe("Issue number"),
      labels: z
        .array(z.string())
        .describe("Registered label names (unknown labels are preflight errors)"),
    }),
  ]);

  const confirmNode = z
    .boolean()
    .optional()
    .describe("Omitted/false = dry-run (plan/diff only, zero writes). true = real effect.");

  const laneTool: CustomTool<LaneArgs> = {
    name: "pm_lane",
    label: "PM Lane Dispatch",
    description:
      "Dispatch a board ticket to an isolated lane: gate check (open ∧ Todo ∧ no open blockers) → " +
      "herdr worktree provision → subagent spawn → guarded board flip to In Progress. " +
      "Accepts one ticket number or an array. Dry-run (default) returns the DoR table + spawn plan.",
    parameters: z.object({
      ticket: z.union([z.number(), z.array(z.number())]).describe("Ticket number(s) to dispatch"),
      agent: z.string().optional().describe("omp agent type (default 'task')"),
      model: z.string().optional().describe("Model selector override for the lane"),
      blockedBy: z
        .array(z.number())
        .optional()
        .describe(
          "Dependency edges materialized with the dispatch (#393): each number becomes a " +
            "blockedBy edge of the dispatched ticket — same addBlockedBy primitive + " +
            "preflight as pm_apply; written after a successful spawn, before the board flip",
        ),
      confirm: confirmNode,
      base: z.string().optional().describe("Worktree base ref (default origin/main)"),
      leasesPath: z.string().optional().describe("Browser-lease ledger path override"),
    }),
    async execute(_toolCallId, params): Promise<ToolResult> {
      const spec = {
        agent: params.agent ?? "task",
        ...(params.model !== undefined ? { model: params.model } : {}),
      };
      const opts = {
        confirm: params.confirm === true,
        ...(params.base !== undefined ? { base: params.base } : {}),
        ...(params.leasesPath !== undefined ? { leasesPath: params.leasesPath } : {}),
        ...(params.blockedBy !== undefined ? { blockedBy: params.blockedBy } : {}),
      };
      // Overload narrowing: single number | Ticket vs the batch array form.
      const list = Array.isArray(params.ticket)
        ? await lane(params.ticket, spec, opts)
        : [await lane(params.ticket, spec, opts)];
      return {
        content: [{ type: "text", text: renderLane(list) }],
        details: { reports: list.map(laneDetails) },
      };
    },
  };

  const applyTool: CustomTool<ApplyArgs> = {
    name: "pm_apply",
    label: "PM Board Apply",
    description:
      "The ONLY board write path: guarded, batched, per-batch re-verified. " +
      "Dry-run (default) prints the preflight diff and writes nothing; drift (a batch re-verifying " +
      "against changed board state) withholds all remaining batches. Closed-state Statuses " +
      "(Done/Canceled) on open tickets are rejected as preflight errors.",
    parameters: z.object({
      mutations: z.array(mutationSchema).describe("Board mutations to apply"),
      confirm: confirmNode,
    }),
    async execute(_toolCallId, params): Promise<ToolResult> {
      const report = await apply(params.mutations, { confirm: params.confirm === true });
      return {
        content: [{ type: "text", text: renderApply(report) }],
        details: applyDetails(report),
      };
    },
  };

  const auditTool: CustomTool<AuditArgs> = {
    name: "pm_audit",
    label: "PM Drift Audit",
    description:
      "Reconcile the project board against reality (read-only): closed-status convergence, dead-lane " +
      "In Progress, active-lane status mismatch, frontier aging, overdue walk deferrals (rule 8, " +
      "always armed: 到期翻红 → Wait for user), prose dependencies without a blockedBy edge " +
      "(#393, rule 9, advisory), and (with withLeases) browser-lease ledger drift. " +
      "Returns pm_apply-ready repair mutations — one-shot reconcile is " +
      "pm_audit → pm_apply(mutations, confirm).",
    parameters: z.object({
      activeLanes: z.array(z.number()).optional().describe("Ticket numbers with live lanes"),
      withLeases: z
        .boolean()
        .optional()
        .describe("Arm rule 6 (browser-lease drift) from the repo lease ledger"),
      leasesPath: z.string().optional().describe("Browser-lease ledger path override"),
      walksPath: z.string().optional().describe("Walk-due ledger path override"),
    }),
    async execute(_toolCallId, params): Promise<ToolResult> {
      const snap = await snapshot();
      const rep = audit(snap, {
        ...(params.activeLanes !== undefined ? { activeLanes: params.activeLanes } : {}),
        ...(params.withLeases === true
          ? {
              leases: ledger(params.leasesPath !== undefined ? { path: params.leasesPath } : {})
                .events,
            }
          : {}),
        walks: walkLedger(params.walksPath !== undefined ? { path: params.walksPath } : {}).events,
      });
      return {
        content: [{ type: "text", text: renderAudit(rep) }],
        details: auditDetails(rep, snap),
      };
    },
  };

  const releaseTool: CustomTool<ReleaseArgs> = {
    name: "pm_release",
    label: "PM Lease Release",
    description:
      "Release a shared-resource lease (browser tab/thread discipline): sets releasedAt in the " +
      "append-only ledger. Refuses when no active lease matches — a release without a lease is a " +
      "ledger bug, not a no-op. Run at lane delivery/closeout.",
    parameters: z.object({
      type: z.enum(["browser"]).describe("Lease type"),
      lane: z.string().describe("Roster lane id (e.g. lane-239-x)"),
      tabName: z.string().optional().describe("Named tab (disambiguates multi-lease lanes)"),
      threadPrefix: z.string().optional().describe("Staging thread prefix"),
      leasesPath: z.string().optional().describe("Ledger path override"),
    }),
    execute(_toolCallId, params): ToolResult {
      const record = release(
        params.type,
        {
          lane: params.lane,
          ...(params.tabName !== undefined ? { tabName: params.tabName } : {}),
          ...(params.threadPrefix !== undefined ? { threadPrefix: params.threadPrefix } : {}),
        },
        params.leasesPath !== undefined ? { path: params.leasesPath } : {},
      );
      return {
        content: [
          {
            type: "text",
            text: `== pm_release: ${record.lane} released (${record.type}) ==\n  tab=${record.tabName} prefix=${record.threadPrefix}`,
          },
        ],
        details: { ...record },
      };
    },
  };

  const ledgerTool: CustomTool<LedgerArgs> = {
    name: "pm_ledger",
    label: "PM Lease Ledger",
    description:
      "Read the shared-resource lease ledger: the full append-only event log plus the replayed " +
      "active set (leases without a release). Feed `events` to pm_audit's withLeases input.",
    parameters: z.object({
      leasesPath: z.string().optional().describe("Ledger path override"),
    }),
    execute(_toolCallId, params): ToolResult {
      const view = ledger(params.leasesPath !== undefined ? { path: params.leasesPath } : {});
      const lines = [
        `== pm_ledger: ${view.events.length} event(s), ${view.active.length} active ==`,
        ...view.active.map(
          (e) =>
            `  ACTIVE ${e.type} ${e.lane} tab=${e.tabName} prefix=${e.threadPrefix}` +
            ` acquired=${e.acquiredAt}`,
        ),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { events: view.events, active: view.active },
      };
    },
  };

  const walkLedgerTool: CustomTool<WalkLedgerArgs> = {
    name: "pm_walk_ledger",
    label: "PM Walk Ledger",
    description:
      "走查挂账 ledger (#391 — the 终检批 ban): register a deferred walk as {ticket, due, face} " +
      "(register), settle it with the evidence anchor (done), or read events + the active set " +
      "(list). Overdue active walks are pm_audit rule 8 — the board flips red " +
      "(Wait for user) at the next audit.",
    parameters: z.object({
      action: z.enum(["register", "done", "list"]).describe("register / done / list"),
      number: z.number().int().positive().optional().describe("Ticket number (register/done)"),
      due: z.string().optional().describe("ISO-8601 due date (register)"),
      face: z.string().optional().describe("走查面 — what exactly is walked, one line (register)"),
      evidence: z.string().optional().describe("Evidence anchor: walk report / comment / PR (done)"),
      walksPath: z.string().optional().describe("Ledger path override"),
    }),
    execute(_toolCallId, params): ToolResult {
      const opts = params.walksPath !== undefined ? { path: params.walksPath } : {};
      if (params.action === "register") {
        if (params.number === undefined || params.due === undefined || params.face === undefined) {
          throw new Error("pm_walk register requires number, due and face — 无票无期限的挂账=终检批");
        }
        const rec = walkDue(params.number, params.due, params.face, opts);
        return {
          content: [
            {
              type: "text",
              text: `== pm_walk: #${rec.number} registered (due ${rec.due}) ==\n  face: ${rec.face}`,
            },
          ],
          details: { ...rec },
        };
      }
      if (params.action === "done") {
        if (params.number === undefined || params.evidence === undefined) {
          throw new Error("pm_walk done requires number and evidence — 空框不可销账");
        }
        const rec = walkDone(params.number, params.evidence, opts);
        return {
          content: [
            {
              type: "text",
              text: `== pm_walk: #${rec.number} settled ==\n  evidence: ${rec.evidence}`,
            },
          ],
          details: { ...rec },
        };
      }
      const view = walkLedger(opts);
      const lines = [
        `== pm_walk: ${view.events.length} event(s), ${view.active.length} active ==`,
        ...view.active.map((w) => `  DUE #${w.number} ${w.due} — ${w.face} (registered ${w.recordedAt})`),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { events: view.events, active: view.active },
      };
    },
  };

  const walkProbeTool: CustomTool<WalkArgs> = {
    name: "pm_walk",
    label: "PM Acceptance Walk",
    description:
      "Walk a real page surface and leave ledger-able acceptance evidence (#392): navigates a " +
      "lane-owned tab, captures console errors / page errors / failed requests, runs selector " +
      "assertions, screenshots, and writes .pm-walk/<stamp>-<slug>/report.json with a sha256 " +
      "anchor for AP.closeout's evidence field (source:walk, gate #390). Default surface: the " +
      "kernel browser facade (managed headless Chromium). cdpHttp opts INTO the raw-CDP Windows " +
      "Chrome bridge for Access-gated faces. allowFetchFallback downgrades to fetch+raw-HTML " +
      "(console capture impossible — the report says so).",
    parameters: z.object({
      url: z.string().describe("http(s) URL to walk"),
      checks: z
        .array(
          z.object({
            selector: z.string().describe("CSS selector"),
            atLeast: z
              .number()
              .optional()
              .describe("Minimum matches, positive integer (default 1)"),
            text: z.string().optional().describe("Substring the first match's text must contain"),
          }),
        )
        .optional()
        .describe("Selector assertions (default none — observation-only walk)"),
      tabName: z
        .string()
        .optional()
        .describe("Lane-owned tab name (lease discipline #240; default 'pm-walk')"),
      cdpHttp: z
        .string()
        .optional()
        .describe(
          "Raw-CDP endpoint override (Windows Chrome bridge for Access faces, e.g. " +
            "http://172.27.0.1:9222); omit for the kernel facade",
        ),
      settleMs: z.number().optional().describe("Post-load settle time in ms (default 3000)"),
      outDir: z.string().optional().describe("Evidence root (default .pm-walk)"),
      allowFetchFallback: z
        .boolean()
        .optional()
        .describe("Allow the fetch+raw-HTML downgrade when no browser answers (default false)"),
    }),
    async execute(_toolCallId, params): Promise<ToolResult> {
      const report = await walk(params.url, params.checks ?? [], {
        ...(params.tabName !== undefined ? { tabName: params.tabName } : {}),
        ...(params.cdpHttp !== undefined ? { cdpHttp: params.cdpHttp } : {}),
        ...(params.settleMs !== undefined ? { settleMs: params.settleMs } : {}),
        ...(params.outDir !== undefined ? { outDir: params.outDir } : {}),
        ...(params.allowFetchFallback !== undefined
          ? { allowFetchFallback: params.allowFetchFallback }
          : {}),
      });
      return {
        content: [{ type: "text", text: renderWalk(report) }],
        details: { report },
      };
    },
  };

  return [laneTool, applyTool, auditTool, releaseTool, ledgerTool, walkLedgerTool, walkProbeTool];
};

const factory: CustomToolFactory = createPmHarnessTools;
export default factory;
