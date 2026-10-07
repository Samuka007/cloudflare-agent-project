import type { EdgeToolResult } from "../edge.js";
import type { IsolationOpOutcome } from "../../daemon.js";
import { z } from "zod";
import type { JobRegistration, JobRegistry } from "../job-registry.js";
import { SpawnSemaphore } from "./semaphore.js";
import type { WaitWake } from "../wait.js";
import { newThreadId } from "@cap/protocol";
import type { AnyAgentEvent } from "../../fsm-events.js";
import type { RelaySelection } from "../../provider-catalog.js";
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
import type { SpawnIsolationInfo } from "./types.js";

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
  createThread(request: {
    threadId: string;
    title: string;
    machineId: string;
    /**
     * #496: the child's inherited execution selection (the spawning turn's
     * pin with the item's model override applied) — the child thread pins it
     * at creation so its first turn dispatches explicitly.
     */
    execution?: RelaySelection;
  }): Promise<{
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
  /** T18 batch shared context — rendered into the child's CONTEXT section. */
  context?: string;
  model?: string;
  /**
   * T17 structured contract — mirrored onto the child identity row so the
   * child enforces the outputSchema verdict replay-pure (no parent contact).
   */
  outputSchema?: unknown;
  schemaMode?: "permissive" | "strict";
  /**
   * #274 J1 delegation attribution — the parent `task` tool call's UX item
   * id, mirrored onto the child identity row so the child journal is
   * self-attributing (bb child-side parentToolCallId semantics).
   */
  parentToolCallId?: string;
}

export interface TaskToolConfig {
  /** omp task.maxRecursionDepth (default 2; <0 disables the cap). */
  maxRecursionDepth: number;
  /** omp async.enabled (default on): non-blocking agents go background. */
  asyncEnabled: boolean;
  maxOutputBytes: number;
  maxOutputLines: number;
  inlineSummaryCapChars: number;
  /** T20 #110: prepare/release RPC deadline (deployment execTimeoutMs). */
  isolationOpTimeoutMs: number;
  /** omp task.maxConcurrency (default 32; 0 = no cap). */
  maxConcurrency: number;
  /** omp task.softRequestBudget (default 200); 1.5× hard-stops. */
  softRequestBudget: number;
  /** omp task.maxRuntimeMs (default 0 = off). */
  maxRuntimeMs: number;
}

export const DEFAULT_TASK_TOOL_CONFIG: TaskToolConfig = {
  maxRecursionDepth: 2,
  asyncEnabled: true,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxOutputLines: MAX_OUTPUT_LINES,
  inlineSummaryCapChars: INLINE_SUMMARY_CAP_CHARS,
  isolationOpTimeoutMs: 600_000,
  maxConcurrency: 32,
  softRequestBudget: 200,
  maxRuntimeMs: 0,
};

// ---------------------------------------------------------------------------
// T18 batch form (omp task/index.ts:245-287 validateSpawnParams +
// :296-328 resolveSpawnItems/spawnParamsFor, task.batch default on): one
// call → N spawns. Validation five rejections + the container-model
// rejection; flat shape stays accepted (lenientArgValidation, :619-629).
//
// CUT (ticket §3 T18 裁决点 4, recorded deviation): speculative pre-launch
// (`task.speculativeLaunch` default on in omp — each closing tasks[] item
// JSON object starts its SpawnRun during the stream, dispatch adopts
// matching runs or discards all) is NOT ported. The M1.5 provider seam
// (provider.ts ModelStreamChunk) delivers tool-call arguments only as a
// terminal chunk — there is no per-item streaming parse point. Per the
// card this is a trailing sub-ticket; the default-off release and the
// upstream-default deviation are recorded on #108.
// ---------------------------------------------------------------------------

export interface SpawnItem {
  name?: string;
  agent?: string;
  task: string;
  solutionSpace: string;
  /** T20 #110: run the child against a daemon-side isolated workspace. */
  isolated?: boolean;
  model?: string;
  outputSchema?: unknown;
  schemaMode?: "permissive" | "strict";
}

/** omp "put it on each tasks[] item" — the batch container takes no model. */
const BATCH_CONTAINER_MODEL_REJECTED =
  "Invalid arguments: `model` on a batch container is rejected — put it on each tasks[] item.";

/**
 * Normalize the wire args into spawn items: batch `{context, tasks[]}` (the
 * omp default form) or flat `{...item}` (runtime lenient accept). Returns
 * the omp-verbatim rejection text on the five batch violations:
 * empty tasks / missing context / item missing task / duplicate names
 * (case-insensitive) / top-level task coexisting with tasks.
 */
export function resolveSpawnItems(args: {
  name?: string;
  agent?: string;
  task?: string;
  solutionSpace?: string;
  context?: string;
  tasks?: unknown;
  model?: string;
  isolated?: unknown;
  outputSchema?: unknown;
  schemaMode?: "permissive" | "strict";
}): { items: SpawnItem[] } | { error: string } {
  if (args.tasks !== undefined) {
    if (args.model !== undefined) {
      return { error: BATCH_CONTAINER_MODEL_REJECTED };
    }
    if (args.task !== undefined) {
      return {
        error:
          "Invalid arguments: top-level `task` and `tasks` are mutually exclusive — one call is either a batch container or a single spawn.",
      };
    }
    if (typeof args.context !== "string" || args.context.trim() === "") {
      return {
        error: "Invalid arguments: batch form requires `context` — it renders into every child's CONTEXT section.",
      };
    }
    if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
      return { error: "Invalid arguments: `tasks` must be a non-empty array of spawn items." };
    }
    const items: SpawnItem[] = [];
    const seen = new Set<string>();
    for (const raw of args.tasks) {
      const item = raw as Record<string, unknown>;
      if (typeof item.task !== "string" || item.task.trim() === "") {
        return { error: "Invalid arguments: every tasks[] item requires a non-empty `task`." };
      }
      if (typeof item.solutionSpace !== "string" || item.solutionSpace.trim() === "") {
        return {
          error:
            "Invalid arguments: every tasks[] item requires `solutionSpace` — the child's auto thinking tier takes no other input.",
        };
      }
      if (item.name !== undefined) {
        if (typeof item.name !== "string" || item.name === "") {
          return { error: "Invalid arguments: tasks[] item `name` must be a non-empty string." };
        }
        const key = item.name.toLowerCase();
        if (seen.has(key)) {
          return {
            error: `Invalid arguments: duplicate tasks[] item name "${item.name}" (case-insensitive).`,
          };
        }
        seen.add(key);
      }
      items.push({
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.agent === "string" ? { agent: item.agent } : {}),
        task: item.task,
        solutionSpace: item.solutionSpace,
        ...(item.isolated === undefined ? {} : { isolated: item.isolated === true }),
        ...(item.model === undefined ? {} : { model: item.model as string }),
        ...(item.outputSchema === undefined ? {} : { outputSchema: item.outputSchema }),
        ...(item.schemaMode === undefined ? {} : { schemaMode: item.schemaMode as "permissive" | "strict" }),
      });
    }
    return { items };
  }
  // Flat single-spawn form (omp lenient accept).
  if (typeof args.task !== "string" || args.task.trim() === "") {
    return {
      error: "Invalid arguments: `task` must be a non-empty self-contained assignment.",
    };
  }
  if (typeof args.solutionSpace !== "string" || args.solutionSpace.trim() === "") {
    return {
      error:
        "Invalid arguments: `solutionSpace` must describe how open-ended the child's problem is (omp per-item required field).",
    };
  }
  return {
    items: [
      {
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.agent === undefined ? {} : { agent: args.agent }),
        task: args.task,
        solutionSpace: args.solutionSpace,
        ...(args.isolated === undefined ? {} : { isolated: args.isolated === true }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.outputSchema === undefined ? {} : { outputSchema: args.outputSchema }),
        ...(args.schemaMode === undefined ? {} : { schemaMode: args.schemaMode }),
      },
    ],
  };
}

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
  /**
   * #496: the spawning turn's pinned execution selection (null = the turn
   * predates the pin discipline — a child spawned from it fails closed at
   * dispatch rather than riding a deployment default).
   */
  turnExecution: RelaySelection | null;
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
    /** #274 J1: attribution from the dispatch (see SpawnPlanRecord). */
    parentToolCallId?: string;
  }): Promise<void>;
  /** T2 frozen JobRegistry mutators — background registration/settlement. */
  registry: Pick<JobRegistry, "register" | "settle">;
  /** Child DO seam; undefined = no AGENT_DO binding (spawn fails loudly). */
  subagentHost: SubagentSpawnHost | undefined;
  /** T20 #110 daemon isolation seam; undefined = DAEMON_SERVICE unbound —
   * isolated spawns fail loudly instead of silently running unisolated. */
  isolationOp:
    | ((request: {
        machineId: string;
        threadId: string;
        op: "prepare" | "release";
        arguments: Record<string, unknown>;
        timeoutMs: number;
      }) => Promise<IsolationOpOutcome>)
    | undefined;
  /** DO wake channel (edgeWaiters): resolves on settle/message/cap/cancel. */
  wake(): Promise<WaitWake["kind"]>;
  /**
   * T18 session-level spawn semaphore — one permit per SpawnRun, unified
   * across all task calls (task semantics §4.1). DO-singleton; acquire-time
   * cap reads make in-place config changes apply to queued spawns.
   */
  semaphore: SpawnSemaphore;
  /**
   * Permit bookkeeping: the executor registers the run's release right after
   * acquire; the DO releases when the settlement row lands (the permit spans
   * dispatch→settlement, so a parked blocking executor never starves its own
   * child — the omp provider-concurrency bracket, adapted to the DO split:
   * the descendant runs under its own DO's semaphore, so the held permit
   * cannot self-lock the tree, upstream issue #3749).
   */
  trackSpawnRelease(spawnId: string, release: () => void): void;
  config: TaskToolConfig;
}

// omp docs/tools/task.md:108 (PI_BLOCKED_AGENT) + canSpawnAtDepth doc: past
// the depth cap spawning is policy-disabled for this caller.
const DEPTH_CAP_BLOCKED =
  "Agent spawning is currently disabled: this agent is already at task.maxRecursionDepth. Follow up via `write agent://<id>` on an existing subagent instead of spawning a new one.";

const NO_SUBAGENT_HOST =
  "Task spawn failed: no subagent host bound on this deployment (missing AGENT_DO namespace).";

const ISOLATION_UNAVAILABLE =
  "Task spawn failed: isolated execution requires a daemon binding (missing DAEMON_SERVICE) on this deployment.";

/** Boundary schema over the daemon's prepare payload (IsolationPrepareInfo JSON). */
const isolationPrepareSchema = z.object({
  workspaceDir: z.string().min(1),
  backend: z.string().min(1),
  fellBack: z.boolean(),
  fallbackReason: z.string().nullable(),
  mergeMode: z.enum(["patch", "branch"]),
  applyGate: z.boolean(),
});

/** Parse the daemon's prepare payload (IsolationPrepareInfo JSON). */
export function parseIsolationPrepare(output: string): SpawnIsolationInfo {
  return isolationPrepareSchema.parse(JSON.parse(output)) satisfies SpawnIsolationInfo;
}

/** The settlement suffix describing an isolation session's fate (keep-alive). */
export function isolationRetainedNote(info: { workspaceDir: string; applyGate: boolean }): string {
  const fate = info.applyGate
    ? "an explicit release captures and merges its changes"
    : "an explicit release captures its delta without applying (apply gate closed)";
  return `[isolated workspace retained at ${info.workspaceDir} — revive via \`write agent://<id>\` to keep working there; ${fate}]`;
}

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

/**
 * Execute one `task` call — flat single spawn (T16) or the T18 batch
 * container. `args` arrives RAW: the edge routes task leniently
 * (omp lenientArgValidation, task/index.ts:619-629), so resolveSpawnItems is
 * the self-check that speaks (batch five rejections + container-model
 * rejection render omp-verbatim; flat empty-string shape failures included).
 * Per omp §3.4 the sync face aggregates: any item error fails the whole call
 * while every item's output still reports; a mid-batch cancellation returns
 * immediately.
 */
export async function runTaskTool(
  args: Record<string, unknown>,
  ctx: TaskToolContext,
): Promise<EdgeToolResult> {
  // omp canSpawnAtDepth gate: the wire surface already strips `task` past the
  // cap; a direct call is refused with the same policy verdict.
  if (!canSpawnAtDepth(ctx.config.maxRecursionDepth, ctx.depth)) {
    return { status: "error", output: DEPTH_CAP_BLOCKED };
  }
  const resolved = resolveSpawnItems(args);
  if ("error" in resolved) return { status: "error", output: resolved.error };
  const context = typeof args.context === "string" ? args.context : undefined;
  if (ctx.subagentHost === undefined) return { status: "error", output: NO_SUBAGENT_HOST };

  const outputs: string[] = [];
  let anyError = false;
  for (const [index, item] of resolved.items.entries()) {
    // Batch items plan under per-item executionIds (`<call>#<i>`) so a
    // recovery re-dispatch re-adopts each child individually; the flat form
    // keeps the bare executionId (T16 journal compatibility).
    const executionId = resolved.items.length === 1 ? ctx.executionId : `${ctx.executionId}#${index}`;
    const result = await spawnOne({ item, executionId, context, ctx });
    if (result.status === "cancelled") return result;
    if (result.status === "error") anyError = true;
    outputs.push(result.output);
  }
  return { status: anyError ? "error" : "ok", output: outputs.join("\n\n") };
}

/** One spawn item of a (possibly single-item) call. */
async function spawnOne(request: {
  item: SpawnItem;
  executionId: string;
  context: string | undefined;
  ctx: TaskToolContext;
}): Promise<EdgeToolResult> {
  const { item, executionId, context, ctx } = request;
  const agentName = item.agent ?? "task";
  const definition: AgentDefinition | undefined = agentDefinitionFor(agentName);
  if (definition === undefined) {
    return {
      status: "error",
      output: `Unknown agent: ${agentName}. M1.5 bundles only the default \`task\` agent.`,
    };
  }
  const mode = resolveExecutionMode(definition, ctx.config.asyncEnabled);

  const events = await ctx.events();
  const existing = planForExecution(events, executionId);
  if (existing !== undefined) {
    // Recovery re-dispatch: re-adopt the journaled plan — never a second spawn.
    // (No new permit: the original dispatch already holds this run's slot.)
    return readoptExistingSpawn(existing, ctx);
  }
  const plans = projectSpawnPlans(events);
  const base = item.name ?? defaultAgentName(plans);
  const allocated = uniquifyAgentName(base, takenAgentNames(plans));
  const agentId = nestAgentId(ctx.parentAgentId, allocated);
  const spawnId = newThreadId();
  // Narrowed once: the runTaskTool loop pre-checks the binding, but awaits
  // between here and the RPCs would un-narrow the property read.
  const host = ctx.subagentHost;
  if (host === undefined) return { status: "error", output: NO_SUBAGENT_HOST };
  // Discriminated shape instead of a nullable id: the background branch
  // narrows naturally (the registration rides the plan row's jobId).
  const background = mode === "background" ? { jobId: crypto.randomUUID() } : null;

  // T20 #110: isolation prepare runs BEFORE the plan row and the child —
  // a failure here (no daemon binding, backend chain exhausted, baseline
  // over the snapshot budget) settles the spawn failed with the child never
  // driven (fail-before-spawn). Crash-safety: a crash between prepare and
  // the plan row leaves an orphan workspace that the recovery re-dispatch's
  // prepare destroys deterministically (omp ensureIsolation wipes the
  // (repoRoot, agentId) slot) — the plan row stays the spawn-dedup
  // authority for createThread/runSubagent below.
  let isolation: {
    workspaceDir: string;
    backend: string;
    fellBack: boolean;
    fallbackReason: string | null;
    mergeMode: "patch" | "branch";
    applyGate: boolean;
  } | null = null;
  if (item.isolated === true) {
    if (ctx.isolationOp === undefined) {
      return {
        status: "error",
        output: `Task ${agentId} failed to start: ${ISOLATION_UNAVAILABLE}`,
      };
    }
    const outcome = await ctx.isolationOp({
      machineId: ctx.machineId,
      threadId: ctx.threadId,
      op: "prepare",
      arguments: { threadId: spawnId, agentId, description: item.task },
      timeoutMs: ctx.config.isolationOpTimeoutMs,
    });
    if (outcome.kind !== "ok") {
      const detail =
        outcome.kind === "error" ? outcome.error : "daemon host offline (no live client session)";
      return {
        status: "error",
        output: `Task ${agentId} failed to start: isolation prepare failed — ${detail}`,
      };
    }
    isolation = parseIsolationPrepare(outcome.result.output);
  }

  // The permit spans dispatch→settlement: acquired only when a NEW run is
  // actually starting (after isolation prepare — a failed prepare takes no
  // slot), released by the DO when the settlement row lands.
  const release = await ctx.semaphore.acquire();
  ctx.trackSpawnRelease(spawnId, release);

  // Journal-first (iron rule 1): the plan row (with the prepare outcome
  // JSON-encoded, same rule as outputSchemaJson) lands before the child DO
  // RPCs — the spawn-dedup authority for everything below.
  await ctx.recordSpawnPlan({
    seq: 0,
    executionId,
    spawnId,
    agentId,
    agent: agentName,
    childThreadId: spawnId,
    parentThreadId: ctx.threadId,
    machineId: ctx.machineId,
    mode,
    jobId: background === null ? null : background.jobId,
    task: item.task,
    solutionSpace: item.solutionSpace,
    ...(context === undefined ? {} : { context }),
    ...(item.model === undefined ? {} : { model: item.model }),
    ...(item.outputSchema === undefined ? {} : { outputSchema: item.outputSchema }),
    ...(item.schemaMode === undefined ? {} : { schemaMode: item.schemaMode }),
    ...(isolation === null ? {} : { isolation }),
    // #274 J1: the delegation anchor is the BARE call executionId — the ux
    // toolCall item id; per-item batch dedup keys keep their `#index` suffix.
    parentToolCallId: ctx.executionId,
    depth: ctx.depth + 1,
  });

  try {
    // #496: the child pins the spawning turn's selection (the item's model
    // override rides on top) — no deployment-default dispatch for children.
    const childExecution: RelaySelection | null =
      ctx.turnExecution === null
        ? null
        : {
            ...ctx.turnExecution,
            ...(item.model !== undefined ? { model: item.model } : {}),
          };
    await host.createThread({
      threadId: spawnId,
      title: `task: ${agentId}`,
      machineId: ctx.machineId,
      ...(childExecution !== null ? { execution: childExecution } : {}),
    });
    await host.runSubagent({
      spawnId,
      agentId,
      parentThreadId: ctx.threadId,
      depth: ctx.depth + 1,
      task: item.task,
      solutionSpace: item.solutionSpace,
      ...(context === undefined ? {} : { context }),
      ...(item.model === undefined ? {} : { model: item.model }),
      ...(item.outputSchema === undefined ? {} : { outputSchema: item.outputSchema }),
      ...(item.schemaMode === undefined ? {} : { schemaMode: item.schemaMode }),
      parentToolCallId: ctx.executionId,
    });
  } catch (error) {
    // Child bring-up failed before any turn ran: settle the spawn as failed so
    // neither the journal (plan without settlement) nor a blocking waiter
    // dangles. omp keeps failed spawn records — so does the plan row above.
    // The just-prepared workspace is released (omp failed-startup cleanup);
    // best-effort — the failure text stays the bring-up error.
    if (isolation !== null && ctx.isolationOp !== undefined) {
      await ctx
        .isolationOp({
          machineId: ctx.machineId,
          threadId: ctx.threadId,
          op: "release",
          arguments: { threadId: spawnId },
          timeoutMs: ctx.config.isolationOpTimeoutMs,
        })
        .catch(() => undefined);
    }
    const output = `Task ${agentId} failed to start: ${error instanceof Error ? error.message : String(error)}`;
    await settleSpawn(ctx, {
      spawnId,
      jobId: background === null ? null : background.jobId,
      agentId,
      childThreadId: spawnId,
      status: "error",
      output,
      parentToolCallId: ctx.executionId,
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
    /** #274 J1: attribution from the dispatch/plan (see SpawnPlanRecord). */
    parentToolCallId?: string;
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
