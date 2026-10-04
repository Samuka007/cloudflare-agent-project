import type { AnyAgentEvent } from "../../fsm-events.js";
import {
  BACKGROUND_COMPLETE_PREFIX,
  BACKGROUND_FAILED_PREFIX,
  projectSpawnPlans,
  type SpawnPlanRecord,
} from "./types.js";

/**
 * M1.5 T16 spawn planning — pure helpers over the spawn journal: agent-id
 * allocation (omp AgentOutputManager), depth/policy checks, child assignment
 * rendering and delivery caps. Everything here is replay-deterministic: the
 * journal is the only input, so recovery re-derives identical plans.
 */

/**
 * omp AgentOutputManager (#allocateUnique, output-manager.ts:83-87) verbatim
 * rule: the first allocation of a name keeps it; a repeated name gets `-2`,
 * `-3`, … — case-sensitivity follows the manager's literal set (omp keys are
 * exact), while our journal projection lower-cases for the duplicate check
 * because the omp prompt layer advertises "重名（大小写不敏感）" rejection at
 * batch validation (task/index.ts:245-287). Nesting prefixes (`Parent.Child`)
 * ride the caller: allocation works on one scope's base names.
 *
 * `taken` holds the base names already allocated in this scope.
 */
export function uniquifyAgentName(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/**
 * omp AgentOutputManager.reserve / #seedFromDisk (output-manager.ts:44-77):
 * existing ids join the taken-set by their FIRST segment — a dot marks a
 * nested child, so this scope only owns the segment before it. Ids are
 * normalized lower-case to match {@link uniquifyAgentName}.
 */
export function takenAgentNames(plans: readonly SpawnPlanRecord[]): Set<string> {
  const taken = new Set<string>();
  for (const plan of plans) {
    const dot = plan.agentId.indexOf(".");
    const segment = dot === -1 ? plan.agentId : plan.agentId.slice(0, dot);
    if (segment !== "") taken.add(segment.toLowerCase());
  }
  return taken;
}

/**
 * Deterministic default-name allocation for spawns the caller left unnamed
 * (omp generates AdjectiveNoun via the name-generator; M1.5 keeps the
 * journal-count form `Task-<n>` — replay-derivable, uniqueness still runs
 * through {@link uniquifyAgentName}).
 */
export function defaultAgentName(plans: readonly SpawnPlanRecord[]): string {
  return `Task-${plans.length + 1}`;
}

/**
 * omp nesting rule (output-manager.ts:6-11): a subagent's own spawns nest
 * under the parent agent id — `Parent.Child`. `Parent` is the spawning
 * thread's own agent id (its `task.subagent_identity.agentId`), undefined for
 * the Main thread.
 */
export function nestAgentId(parentAgentId: string | undefined, allocated: string): string {
  return parentAgentId === undefined ? allocated : `${parentAgentId}.${allocated}`;
}

/**
 * omp prompts/system/subagent-user-prompt.md verbatim: the child's initial
 * prompt wraps the assignment with the opener line. T18 batch `context`
 * renders as the shared-context section the omp prompt layer mounts under
 * CONTEXT (omp renders it into the child system prompt; M1.5 has no per-agent
 * system-prompt seam, so the section rides the assignment — same content,
 * same position: before the task text, clearly delimited).
 */
export function childAssignment(task: string, context?: string): string {
  if (context === undefined) return `Complete assignment thoroughly:\n\n${task}`;
  return `Complete assignment thoroughly:\n\n# Shared context\n\n${context}\n\n---\n\n${task}`;
}

/**
 * omp task/types.ts:29-32 delivery caps (PI_TASK_MAX_OUTPUT_*): 500 KB /
 * 5000 lines. The executor applies this BEFORE journaling settlement so no
 * oversized payload ever enters the DO log (r2-bypass applies to model
 * deltas; settlements are plain rows).
 */
export function truncateDeliveryOutput(
  output: string,
  caps: { maxOutputBytes: number; maxOutputLines: number },
): { text: string; truncated: boolean } {
  const lines = output.split("\n");
  let text =
    lines.length > caps.maxOutputLines ? lines.slice(0, caps.maxOutputLines).join("\n") : output;
  let truncated = text !== output;
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength > caps.maxOutputBytes) {
    text = new TextDecoder().decode(encoded.subarray(0, caps.maxOutputBytes));
    truncated = true;
  }
  return { text, truncated };
}

/**
 * omp result-summary.ts:16/:60-61: the inline summary forces a pointer to the
 * `agent://<id>` artifacts past the 5000-character threshold. T16 renders the
 * pointer text; the artifact sidecar family itself is T17 — the child DO's
 * journal remains retrievable via its threadId meanwhile.
 */
export function inlineSummary(agentId: string, full: string, capChars: number): string {
  if (full.length <= capChars) return full;
  const head = full.slice(0, capChars);
  return `${head}\n\n[truncated ${full.length - capChars} chars — full result at agent://${agentId} (T17 artifact face)]`;
}

/**
 * omp executor.ts:1408-1410 delivery prefixes verbatim — the async-result
 * text the parent session sees ("Background task <agentId> complete/failed").
 */
export function renderAsyncResultText(
  agentId: string,
  status: "ok" | "error",
  output: string,
): string {
  const statusText =
    status === "ok"
      ? `${BACKGROUND_COMPLETE_PREFIX} ${agentId} complete.`
      : `${BACKGROUND_FAILED_PREFIX} ${agentId} failed.`;
  return `${statusText}\n\n${output}`;
}

/**
 * Boundary attribution for async-result follow-ups (translate projection):
 * an async result rides the boundary of the FIRST model call that starts
 * AFTER it — it must never re-enter the call that spawned the job, and it
 * then stays in that boundary call's slice forever (translate's prior-call
 * fold). `model.call_started` seqs are the boundary ledger. -1 = no call has
 * started after the row yet: the result is pending until the next run.
 */
export function boundaryOwnerSeqs(callStartSeqs: readonly number[], seq: number): number {
  for (const start of callStartSeqs) {
    if (start > seq) return start;
  }
  return -1;
}

/** First-segment-scoped duplicate check for one spawn journal (test helper). */
export function hasAgentScopeCollision(events: readonly AnyAgentEvent[], agentId: string): boolean {
  const dot = agentId.indexOf(".");
  const segment = dot === -1 ? agentId : agentId.slice(0, dot);
  return takenAgentNames(projectSpawnPlans(events)).has(segment.toLowerCase());
}

/**
 * omp agent:// surface grammar (docs/tools/task.md:92): `agent://<id>` names
 * the artifact family; a `/`-suffix is the JSON extraction path walked into
 * the `<id>.json` sidecar (`agent://<id>/<key>/<index>`); nested subagents
 * are dot-joined ids (`agent://<id>.<child>`), so the id itself is everything
 * up to the first `/`. `agent://all` rides the same grammar (write-only).
 */
export function parseAgentUri(uri: string): { agentId: string; path?: string[] } | null {
  const match = /^agent:\/\/([^/?#]+)(?:\/(.*))?$/.exec(uri);
  if (match === null) return null;
  const agentId = match[1];
  if (agentId === undefined || agentId === "") return null;
  const rawPath = match[2];
  if (rawPath === undefined || rawPath === "") return { agentId };
  const path = rawPath.split("/").filter((segment) => segment !== "");
  return path.length === 0 ? { agentId } : { agentId, path };
}

/**
 * Walk `agent://<id>/<key>/<index>` extraction segments into a parsed JSON
 * value: object keys by name, array elements by numeric segment. Result-
 * shaped instead of throwing — the caller renders the omp-style error.
 */
export function walkJsonPath(
  value: unknown,
  segments: readonly string[],
): { ok: true; value: unknown } | { ok: false; failedAt: string } {
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { ok: false, failedAt: segment };
      }
      current = current[index];
      continue;
    }
    if (typeof current === "object" && current !== null && segment in current) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return { ok: false, failedAt: segment };
  }
  return { ok: true, value: current };
}
