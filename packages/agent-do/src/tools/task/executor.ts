import type { EdgeToolResult } from "../edge.js";
import type { JobRegistration, JobRegistry } from "../job-registry.js";
import type { WaitWake } from "../wait.js";
import { newThreadId } from "@cap/protocol";
import type { AnyAgentEvent } from "../../fsm-events.js";
import {
  agentDefinitionFor,
  canSpawnAtDepth,
  INLINE_SUMMARY_CAP_CHARS,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  planForExecution,
  projectSpawnPlans,
  resolveExecutionMode,
  settlementForSpawn,
  type AgentDefinition,
  type SpawnPlanRecord,
} from "./types.js";
import {
  defaultAgentName,
  inlineSummary,
  nestAgentId,
  takenAgentNames,
  truncateDeliveryOutput,
  uniquifyAgentName,
} from "./plan.js";

/**
 * M1.5 T16 task edge executor (proposal §3 T16): same-host single dispatch,
 * journal-first spawn plan, per-item execution mode, child AgentDO bring-up
 * and result backflow. omp anchors: `T:task/index.ts` (spawn planning,
 * :245-287 validation, :921-925 per-item mode), `P:task.md` (prompt), omp
 * task semantics §0-§3 (omp-task-semantics.md).
 *
 * DO budget per spawn (practice 11, ticket §3 T16 upper-bound table):
 *   - child.createThread            ×1   (bb same-host default: machineId inherited)
 *   - child.runSubagent             ×1   (child input-first-persist + drive)
 *   - parent.completeSubagent       ×1   (child→parent wake source, journal-first)
 * Total O(1) cross-DO RPC per spawn — child transcripts/artifacts are NEVER
 * forwarded through the DO pair; delivery is summary-capped
 * (`taskMaxOutputBytes`/`taskMaxOutputLines` at settlement,
 * `taskInlineSummaryCapChars` inline, 5000) and the full result stays in the
 * child DO (`agent://<id>` face is T17).
 *
 * executionId semantics (T16 acceptance): the spawn plan is idempotent by
 * `executionId` — a recovery re-dispatch re-adopts the same child (never a
 * second spawn); a re-SENT task call gets a fresh executionId and spawns a
 * fresh child (omp zero-dedup semantics, explicitly preserved, matrix §2.4:
 * follow-up should `write agent://<id>`, not re-spawn).
 */

/** Child DO handle — the SubagentHost seam the DO binds (env.AGENT_DO in the
 * composed deployment; injected fakes in tests). Kept structural so the
 * typed-stub mapping stays RPC-serializable. */
export interface SubagentSpawnHost {
  createThread(request: { threadId: string; title: string; machineId: string }): Promise<{
    threadId: string;
    duplicated: boolean;
  }>;
  runSubagent(request: RunSubagentRequest): Promise<{ turnId: string; duplicated: boolean }>;
}

/** Child drive request — the spawn plan's mirror on the child side. */
export interface RunSubagentRequest {
  spawnId: string;
  agentId: string;
  parentThreadId: string;
  depth: number;
  task: string;
  solutionSpace?: string;
  model?: string;
}

/** Validated flat spawn parameters (omp taskSchemaNoIsolation T16 slice). */
export interface ValidatedSpawnParams {
  name?: string;
  agent?: string;
  task: string;
  solutionSpace: string;
  model?: string;
  outputSchema?: unknown;
  schemaMode?: "permissive" | "strict";
}

export interface TaskToolConfig {
  /** omp task.maxRecursionDepth (default 2; <0 disables the cap). */
  maxRecursionDepth: number;
  /** omp async.enabled (default on): non-blocking agents go background. */
  asyncEnabled: boolean;
  maxOutputBytes: number;
  maxOutputLines: number;
  inlineSummaryCapChars: number;
}

export const DEFAULT_TASK_TOOL_CONFIG: TaskToolConfig = {
  maxRecursionDepth: 2,
  asyncEnabled: true,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxOutputLines: MAX_OUTPUT_LINES,
  inlineSummaryCapChars: INLINE_SUMMARY_CAP_CHARS,
};

/**
 * DO-bound context (the wait.ts WaitToolContext precedent): storage/timer
 * policy stays in the DO; this module is decision logic over the journal.
 */
export interface TaskToolContext {
  executionId: string;
  turnId: string;
  threadId: string;
  /** Parent machine binding — bb same-host constructive default inherits it. */
  machineId: string;
  /** The spawning thread's own depth (0 for Main). */
  depth: number;
  /** The spawning thread's own agent id (nested `Parent.Child` prefix); undefined for Main. */
  parentAgentId: string | undefined;
  events(): Promise<AnyAgentEvent[]>;
  /** Journal-first CAS append of the spawn plan (DO dedups nothing here —
   * the executor checks {@link planForExecution} first). */
  recordSpawnPlan(plan: SpawnPlanRecord): Promise<void>;
  /** Terminal settlement append (status + summary-capped output). */
  recordSpawnSettlement(settlement: {
    spawnId: string;
    jobId: string | null;
    agentId: string;
    childThreadId: string;
    status: "ok" | "error";
    output: string;
    outputTruncated?: boolean;
  }): Promise<void>;
  /** T2 frozen JobRegistry mutators — background registration/settlement. */
  registry: Pick<JobRegistry, "register" | "settle">;
  /** Child DO seam; undefined = no AGENT_DO binding (spawn fails loudly). */
  subagentHost: SubagentSpawnHost | undefined;
  /** DO wake channel (edgeWaiters): resolves on settle/message/cap/cancel. */
  wake(): Promise<WaitWake["kind"]>;
  config: TaskToolConfig;
}

// omp docs/tools/task.md:108 (PI_BLOCKED_AGENT) + canSpawnAtDepth doc: past
// the depth cap spawning is policy-disabled for this caller.
const DEPTH_CAP_BLOCKED =
  "Agent spawning is currently disabled: this agent is already at task.maxRecursionDepth. Follow up via `write agent://<id>` on an existing subagent instead of spawning a new one.";

const NO_SUBAGENT_HOST =
  "Task spawn failed: no subagent host bound on this deployment (missing AGENT_DO namespace).";

/** Registration output for a background spawn — the omp "ID returns
 * immediately" surface (P:task.md line 1) with the §2.4 follow-up rule. */
function backgroundRegisteredOutput(agentId: string, agent: string): string {
  return [
    `Background: ${agentId} (${agent}).`,
    `Address it as agent://${agentId}. Results auto-deliver as async-result follow-ups; NEVER poll.`,
    "Follow up via `write agent://<id>` — re-sending `task` spawns a NEW subagent.",
  ].join(" ");
}

/** Blocking SingleResult — the sync merge face (omp task semantics §3.4). */
function blockingResultOutput(
  agentId: string,
  agent: string,
  settlement: { status: "ok" | "error"; output: string },
): string {
  const statusText =
    settlement.status === "ok"
      ? `Task ${agentId} (${agent}) completed.`
      : `Task ${agentId} (${agent}) failed.`;
  return `${statusText}\n\n${settlement.output}`;
}

/** Flat validation failures that the registry schema cannot express. */
function validateSpawnShape(params: ValidatedSpawnParams): string | undefined {
  if (params.task.trim() === "")
    return "Invalid arguments: `task` must be a non-empty self-contained assignment.";
  if (params.solutionSpace.trim() === "") {
    return "Invalid arguments: `solutionSpace` must describe how open-ended the child's problem is (omp per-item required field).";
  }
  return undefined;
}

/**
 * Execute one flat `task` call. The registry row has already schema-validated
 * `args`; shape failures beyond the schema (empty required strings, unknown
 * agent kind) render omp-style error outputs.
 */
export async function runTaskTool(
  params: ValidatedSpawnParams,
  ctx: TaskToolContext,
): Promise<EdgeToolResult> {
  // omp canSpawnAtDepth gate: the wire surface already strips `task` past the
  // cap; a direct call is refused with the same policy verdict.
  if (!canSpawnAtDepth(ctx.config.maxRecursionDepth, ctx.depth)) {
    return { status: "error", output: DEPTH_CAP_BLOCKED };
  }
  const shapeError = validateSpawnShape(params);
  if (shapeError !== undefined) return { status: "error", output: shapeError };

  const agentName = params.agent ?? "task";
  const definition: AgentDefinition | undefined = agentDefinitionFor(agentName);
  if (definition === undefined) {
    return {
      status: "error",
      output: `Unknown agent: ${agentName}. M1.5 bundles only the default \`task\` agent.`,
    };
  }
  const mode = resolveExecutionMode(definition, ctx.config.asyncEnabled);

  const events = await ctx.events();
  const existing = planForExecution(events, ctx.executionId);
  if (existing !== undefined) {
    // Recovery re-dispatch: re-adopt the journaled plan — never a second spawn.
    return readoptExistingSpawn(existing, ctx);
  }

  const plans = projectSpawnPlans(events);
  const base = params.name ?? defaultAgentName(plans);
  const allocated = uniquifyAgentName(base, takenAgentNames(plans));
  const agentId = nestAgentId(ctx.parentAgentId, allocated);
  const spawnId = newThreadId();
  // Discriminated shape instead of a nullable id: the background branch
  // narrows naturally (the registration rides the plan row's jobId).
  const background = mode === "background" ? { jobId: crypto.randomUUID() } : null;

  if (ctx.subagentHost === undefined) return { status: "error", output: NO_SUBAGENT_HOST };

  // Journal-first (iron rule 1): the plan row lands before any cross-DO RPC.
  await ctx.recordSpawnPlan({
    seq: 0,
    executionId: ctx.executionId,
    spawnId,
    agentId,
    agent: agentName,
    childThreadId: spawnId,
    parentThreadId: ctx.threadId,
    machineId: ctx.machineId,
    mode,
    jobId: background === null ? null : background.jobId,
    task: params.task,
    solutionSpace: params.solutionSpace,
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
    ...(params.schemaMode === undefined ? {} : { schemaMode: params.schemaMode }),
    depth: ctx.depth + 1,
  });

  try {
    await ctx.subagentHost.createThread({
      threadId: spawnId,
      title: `task: ${agentId}`,
      machineId: ctx.machineId,
    });
    await ctx.subagentHost.runSubagent({
      spawnId,
      agentId,
      parentThreadId: ctx.threadId,
      depth: ctx.depth + 1,
      task: params.task,
      solutionSpace: params.solutionSpace,
      ...(params.model === undefined ? {} : { model: params.model }),
    });
  } catch (error) {
    // Child bring-up failed before any turn ran: settle the spawn as failed so
    // neither the journal (plan without settlement) nor a blocking waiter
    // dangles. omp keeps failed spawn records — so does the plan row above.
    const output = `Task ${agentId} failed to start: ${error instanceof Error ? error.message : String(error)}`;
    await settleSpawn(ctx, {
      spawnId,
      jobId: background === null ? null : background.jobId,
      agentId,
      childThreadId: spawnId,
      status: "error",
      output,
    });
    return { status: "error", output };
  }

  if (background !== null) {
    // T2 frozen registration semantics: owner-scoped, wakes waits on settle.
    const registration: JobRegistration = {
      jobId: background.jobId,
      ownerId: ctx.threadId,
      kind: "job",
      label: agentId,
    };
    await ctx.registry.register(registration);
    return { status: "ok", output: backgroundRegisteredOutput(agentId, agentName) };
  }

  // Blocking inline: park on the DO wake channel until the child's
  // completion callback settles the spawn (or the owning call is cancelled).
  for (;;) {
    const settled = settlementForSpawn(await ctx.events(), spawnId);
    if (settled !== undefined) {
      return {
        status: settled.status === "ok" ? "ok" : "error",
        output: blockingResultOutput(agentId, agentName, settled),
      };
    }
    const wake = await ctx.wake();
    if (wake === "cancelled") {
      // omp: the parent call signal cancels the sync run (task semantics
      // §4.2); the child itself is detached and keeps running — its late
      // completion settles through the async path without waking anyone.
      return { status: "cancelled", output: `Task ${agentId} cancelled before completion.` };
    }
    // "job" → re-check settlement; "message"/"cap"/"window" bounce is a
    // no-op for the blocking task (only the settlement unblocks it).
  }
}

/**
 * Re-adoption path (executionId idempotency): answer from the journal. A
 * settled plan replays its terminal result; a still-running blocking plan
 * re-parks on the wake channel; a background plan replays the registration
 * receipt (its result flows through the async path).
 */
async function readoptExistingSpawn(
  plan: SpawnPlanRecord,
  ctx: TaskToolContext,
): Promise<EdgeToolResult> {
  const settled = settlementForSpawn(await ctx.events(), plan.spawnId);
  if (settled !== undefined) {
    return {
      status: settled.status === "ok" ? "ok" : "error",
      output: blockingResultOutput(plan.agentId, plan.agent, settled),
    };
  }
  if (plan.mode === "background") {
    return { status: "ok", output: backgroundRegisteredOutput(plan.agentId, plan.agent) };
  }
  for (;;) {
    const wake = await ctx.wake();
    if (wake === "cancelled") {
      return { status: "cancelled", output: `Task ${plan.agentId} cancelled before completion.` };
    }
    const next = settlementForSpawn(await ctx.events(), plan.spawnId);
    if (next !== undefined) {
      return {
        status: next.status === "ok" ? "ok" : "error",
        output: blockingResultOutput(plan.agentId, plan.agent, next),
      };
    }
  }
}

/**
 * Settlement append shared by the completion callback path (background) and
 * the failed-bring-up path: summary cap first (never journal oversize), then
 * the journal row, then the T2 settle (which wakes waits).
 */
export async function settleSpawn(
  ctx: Pick<TaskToolContext, "recordSpawnSettlement" | "registry" | "config">,
  settlement: {
    spawnId: string;
    jobId: string | null;
    agentId: string;
    childThreadId: string;
    status: "ok" | "error";
    output: string;
  },
): Promise<void> {
  const { text, truncated } = truncateDeliveryOutput(settlement.output, {
    maxOutputBytes: ctx.config.maxOutputBytes,
    maxOutputLines: ctx.config.maxOutputLines,
  });
  const capped = inlineSummary(settlement.agentId, text, ctx.config.inlineSummaryCapChars);
  await ctx.recordSpawnSettlement({
    ...settlement,
    output: capped,
    ...(truncated ? { outputTruncated: true } : {}),
  });
  if (settlement.jobId !== null) {
    // T2 settle appends `job.settled` and broadcasts the wake — waiters
    // re-query their owner-filtered projection, so this job is deliverable.
    await ctx.registry.settle(settlement.jobId, { status: settlement.status, output: capped });
  }
}

/**
 * The child's failure settlement when it exits without any yield — omp
 * docs/tools/task.md:186 SYSTEM WARNING prefix verbatim; the "after 3
 * reminders" clause is T17 (reminder ladder), so it is omitted here.
 */
export const NO_YIELD_WARNING = "SYSTEM WARNING: Subagent exited without calling yield tool.";
