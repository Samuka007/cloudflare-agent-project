import type { AnyAgentEvent } from "../../fsm-events.js";

/**
 * M1.5 T16 task spawn types (proposal §3 T16): the omp task slice the edge
 * half owns — flat single dispatch, per-item execution mode, agent-id
 * allocation, depth policy, delivery caps. Anchors cite omp
 * `packages/coding-agent/src/task/*` @ `d4d49e7` (omp-task-semantics.md).
 */

// omp task/types.ts:222-224 verbatim — the tool-availability gate; the child
// past the cap is stripped of `task` (wire surface), so this check is the
// PI_BLOCKED_AGENT analog for a direct call that slips through (omp
// docs/tools/task.md:108).
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
  return maxRecursionDepth < 0 || taskDepth < maxRecursionDepth;
}

// omp task/types.ts:29 / :32 (PI_TASK_MAX_OUTPUT_* defaults) and
// result-summary.ts:16 (inline summary threshold).
export const MAX_OUTPUT_BYTES = 500_000;
export const MAX_OUTPUT_LINES = 5000;
export const INLINE_SUMMARY_CAP_CHARS = 5000;

/** omp task.maxRecursionDepth default (task/settings.ts:271-275). */
export const DEFAULT_MAX_RECURSION_DEPTH = 2;

/** omp prompts/system/subagent-user-prompt.md verbatim (assignment opener). */
export const CHILD_PROMPT_OPENER = "Complete assignment thoroughly:";

/** omp executor.ts:1408-1410 — the async delivery status prefixes. */
export const BACKGROUND_COMPLETE_PREFIX = "Background task";
export const BACKGROUND_FAILED_PREFIX = "Background task";

/**
 * omp AgentDefinition essential slice (task/types.ts:227-246): only the field
 * the T16 per-item execution-mode rule consumes (`blocking`, task/index.ts
 * :921-925). M1.5 has no agent discovery: one bundled default, test-only
 * overrides through {@link setAgentDefinitions}.
 */
export interface AgentDefinition {
  name: string;
  /** omp AgentDefinition.blocking — blocking agents run inline. */
  blocking: boolean;
}

/** omp builtins declare no blocking agent (task semantics §1.3). */
export const BUNDLED_AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  { name: "task", blocking: false },
];

let agentDefinitions: readonly AgentDefinition[] = BUNDLED_AGENT_DEFINITIONS;

/** Test seam (injection.ts pattern): overrides the bundled definition table. */
export function setAgentDefinitions(definitions: readonly AgentDefinition[]): void {
  agentDefinitions = definitions;
}

export function agentDefinitionFor(name: string): AgentDefinition | undefined {
  return agentDefinitions.find((definition) => definition.name === name);
}

/**
 * omp per-item execution mode (task/index.ts:921-925, :1059-1060): a
 * `blocking: true` agent runs inline; everything else registers as a
 * background job when async is enabled and runs inline when it is not.
 */
export function resolveExecutionMode(
  definition: AgentDefinition | undefined,
  asyncEnabled: boolean,
): "blocking" | "background" {
  if (definition?.blocking === true) return "blocking";
  return asyncEnabled ? "background" : "blocking";
}

/** Typed view of one `task.spawn_planned` journal row. */
export interface SpawnPlanRecord {
  seq: number;
  executionId: string;
  spawnId: string;
  agentId: string;
  agent: string;
  childThreadId: string;
  parentThreadId: string;
  machineId: string;
  mode: "blocking" | "background";
  jobId: string | null;
  task: string;
  solutionSpace: string;
  /** T18 batch shared context — rendered into the child's CONTEXT section. */
  context?: string;
  model?: string;
  /** Raw caller value in memory; the journal row carries it JSON-encoded. */
  outputSchema?: unknown;
  schemaMode?: "permissive" | "strict";
  /** T20 #110: the spawn requested a daemon-side isolated workspace. */
  isolated?: boolean;
  /** Prepare outcome (JSON-encoded on the journal row) — workspace path,
   * resolved backend, merge mode, apply gate. Present iff isolated. */
  isolation?: SpawnIsolationInfo;
  depth: number;
}

/** The prepare payload the daemon returns (task-isolation.ts JSON shape). */
export interface SpawnIsolationInfo {
  workspaceDir: string;
  backend: string;
  fellBack: boolean;
  fallbackReason: string | null;
  mergeMode: "patch" | "branch";
  applyGate: boolean;
}

/** Typed view of one `task.spawn_settled` journal row. */
export interface SpawnSettledRecord {
  seq: number;
  spawnId: string;
  jobId: string | null;
  agentId: string;
  childThreadId: string;
  status: "ok" | "error";
  output: string;
  outputTruncated?: boolean;
}

/** Typed view of the child-journal `task.subagent_identity` row. */
export interface SubagentIdentityRecord {
  /** Journal timestamp — the T18 wall-clock budget origin (maxRuntimeMs). */
  createdAt: number;
  spawnId: string;
  agentId: string;
  parentThreadId: string;
  sourceThreadId: string | null;
  originKind: string | null;
  depth: number;
  /** T17 structured contract mirrored from the spawn plan (optional). */
  outputSchema?: unknown;
  schemaMode?: "permissive" | "strict";
}

// ---------------------------------------------------------------------------
// Journal projections — pure folds, malformed entries skipped
// (latestContextNotes precedent).
// ---------------------------------------------------------------------------

export function projectSpawnPlans(events: readonly AnyAgentEvent[]): SpawnPlanRecord[] {
  const plans: SpawnPlanRecord[] = [];
  for (const event of events) {
    if (event.type !== "task.spawn_planned") continue;
    const data = event.data;
    plans.push({
      seq: event.seq,
      executionId: data.executionId,
      spawnId: data.spawnId,
      agentId: data.agentId,
      agent: data.agent,
      childThreadId: data.childThreadId,
      parentThreadId: data.parentThreadId,
      machineId: data.machineId,
      mode: data.mode,
      jobId: data.jobId,
      task: data.task,
      solutionSpace: data.solutionSpace,
      ...(data.context === undefined ? {} : { context: data.context }),
      ...(data.model === undefined ? {} : { model: data.model }),
      ...(data.outputSchemaJson === undefined
        ? {}
        : { outputSchema: JSON.parse(data.outputSchemaJson) as unknown }),
      ...(data.schemaMode === undefined ? {} : { schemaMode: data.schemaMode }),
      ...(data.isolationJson === undefined
        ? {}
        : { isolated: true, isolation: JSON.parse(data.isolationJson) as SpawnIsolationInfo }),
      depth: data.depth,
    });
  }
  return plans;
}

export function planForExecution(
  events: readonly AnyAgentEvent[],
  executionId: string,
): SpawnPlanRecord | undefined {
  // First-wins: recovery re-dispatch re-adopts the original plan even if a
  // buggy caller ever planned twice under one executionId.
  return projectSpawnPlans(events).find((plan) => plan.executionId === executionId);
}

export function projectSpawnSettlements(events: readonly AnyAgentEvent[]): SpawnSettledRecord[] {
  return events
    .filter(
      (event): event is Extract<AnyAgentEvent, { type: "task.spawn_settled" }> =>
        event.type === "task.spawn_settled",
    )
    .map((event) => ({
      seq: event.seq,
      spawnId: event.data.spawnId,
      jobId: event.data.jobId,
      agentId: event.data.agentId,
      childThreadId: event.data.childThreadId,
      status: event.data.status,
      output: event.data.output,
      ...(event.data.outputTruncated === undefined
        ? {}
        : { outputTruncated: event.data.outputTruncated }),
    }));
}

export function settlementForSpawn(
  events: readonly AnyAgentEvent[],
  spawnId: string,
): SpawnSettledRecord | undefined {
  // First-wins: the parent dedups completion callbacks by spawnId, so a
  // second row would be a bug — never act on it.
  return projectSpawnSettlements(events).find((record) => record.spawnId === spawnId);
}

export function subagentIdentityOf(
  events: readonly AnyAgentEvent[],
): SubagentIdentityRecord | undefined {
  const row = events.find(
    (event): event is Extract<AnyAgentEvent, { type: "task.subagent_identity" }> =>
      event.type === "task.subagent_identity",
  );
  if (row === undefined) return undefined;
  return {
    createdAt: row.createdAt,
    spawnId: row.data.spawnId,
    agentId: row.data.agentId,
    parentThreadId: row.data.parentThreadId,
    sourceThreadId: row.data.sourceThreadId,
    originKind: row.data.originKind,
    depth: row.data.depth,
    ...(row.data.outputSchemaJson === undefined
      ? {}
      : { outputSchema: JSON.parse(row.data.outputSchemaJson) as unknown }),
    ...(row.data.schemaMode === undefined ? {} : { schemaMode: row.data.schemaMode }),
  };
}
