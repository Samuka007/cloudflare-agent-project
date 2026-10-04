import { type } from "arktype";
import { todoSchema } from "./registry.js";

/**
 * DO-side port of the omp `todo` op-dispatch state machine (M1.5 T3, #93) —
 * `T:todo.ts` verbatim (d4d49e71), minus the surfaces a DO-local executor
 * cannot have: the Markdown round-trip + HUD snapshot identity (slash-command
 * / renderer territory) and `getCompletionTransitions`/`nextActionableTask`
 * (details-only HUD payloads; M1.5 result discipline keeps the model-visible
 * surface at `output`). Types mirror omp pi-tui `tools/todo.ts:25-44`;
 * TodoItem's display-only `details`/`notes` members are absent because
 * cloneTask drops them — they never enter tool state (todo.ts:93-97).
 */

/** Lifecycle state of a todo item (omp pi-tui tools/todo.ts:25). */
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** Operation names accepted by the todo tool (omp pi-tui tools/todo.ts:28). */
export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view";

/** A task displayed within a todo phase (omp pi-tui tools/todo.ts:31-38). */
export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** When `status === "blocked"`, an optional note on what the task is waiting for. */
  blocker?: string;
}

/** A named group of todo tasks (omp pi-tui tools/todo.ts:41-44). */
export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

type TodoParams = typeof todoSchema.infer;
/** A single todo op entry (the params object itself). */
type TodoOpEntryValue = TodoParams;

// =============================================================================
// State helpers — omp todo.ts:81-304 verbatim
// =============================================================================

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((t) => t.content === content);
    if (task) return { task, phase };
  }
  return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
  return phases.find((phase) => phase.name === name);
}

function cloneTask(task: TodoItem): TodoItem {
  return task.blocker !== undefined
    ? { content: task.content, status: task.status, blocker: task.blocker }
    : { content: task.content, status: task.status };
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
  return phases.map((phase) => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
  const orderedTasks = phases.flatMap((phase) => phase.tasks);
  if (orderedTasks.length === 0) return;

  const inProgressTasks = orderedTasks.filter((task) => task.status === "in_progress");
  if (inProgressTasks.length > 1) {
    for (const task of inProgressTasks.slice(1)) {
      task.status = "pending";
    }
  }

  if (inProgressTasks.length > 0) return;

  const firstPendingTask = orderedTasks.find((task) => task.status === "pending");
  if (firstPendingTask) firstPendingTask.status = "in_progress";
}

function resolveTaskOrError(
  phases: TodoPhase[],
  content: string | undefined,
  errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
  if (!content) {
    errors.push("Missing task content");
    return undefined;
  }
  const hit = findTaskByContent(phases, content);
  if (!hit) {
    if (/^task-\d+$/.test(content)) {
      errors.push(
        `Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
      );
    } else {
      const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
      const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
      errors.push(`Task "${content}" not found${hint}`);
    }
  }
  return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
  if (!name) {
    errors.push("Missing phase name");
    return undefined;
  }
  const phase = findPhaseByName(phases, name);
  if (!phase) errors.push(`Phase "${name}" not found`);
  return phase;
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors);
    return hit ? [hit.task] : [];
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    return phase ? [...phase.tasks] : [];
  }
  return phases.flatMap((phase) => phase.tasks);
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

function initPhases(entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
  // Models routinely flatten the single-phase init into `{op:"init", items:[...]}`
  // (optionally with a bare `phase`) instead of the canonical
  // `list: [{phase, items}]`. Accept that shape by synthesizing a one-phase list
  // so a common, recoverable mistake isn't a hard error.
  const list =
    entry.list ??
    (entry.items && entry.items.length > 0
      ? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
      : undefined);
  if (!list) {
    errors.push("Missing list for init operation");
    return [];
  }
  // Duplicate phase names / task contents would be permanently unaddressable
  // (every targeting op resolves the first match), so reject them up front.
  const seenPhases = new Set<string>();
  const seenTasks = new Set<string>();
  for (const listEntry of list) {
    if (seenPhases.has(listEntry.phase)) {
      errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
    }
    seenPhases.add(listEntry.phase);
    for (const content of listEntry.items) {
      if (seenTasks.has(content)) {
        errors.push(`Duplicate task "${content}" in init list`);
      }
      seenTasks.add(content);
    }
  }
  return list.map((listEntry) => ({
    name: listEntry.phase,
    tasks: listEntry.items.map<TodoItem>((content) => ({ content, status: "pending" })),
  }));
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
  if (!entry.phase) {
    errors.push("Missing phase name for append operation");
    return phases;
  }
  if (!entry.items || entry.items.length === 0) {
    errors.push("Missing items for append operation");
    return phases;
  }

  // Validate the whole batch before mutating so a failing op reports every
  // duplicate and leaves nothing half-applied.
  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const content of entry.items) {
    if (seen.has(content) || findTaskByContent(phases, content)) {
      errors.push(`Task "${content}" already exists`);
      hasDuplicate = true;
    }
    seen.add(content);
  }
  if (hasDuplicate) return phases;

  let phase = findPhaseByName(phases, entry.phase);
  if (!phase) {
    phase = { name: entry.phase, tasks: [] };
    phases.push(phase);
  }

  for (const content of entry.items) {
    phase.tasks.push({ content, status: "pending" });
  }
  return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors);
    if (!hit) return phases;
    hit.phase.tasks = hit.phase.tasks.filter((candidate) => candidate !== hit.task);
    return phases;
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    if (!phase) return phases;
    phase.tasks = [];
    return phases;
  }
  for (const phase of phases) {
    phase.tasks = [];
  }
  return phases;
}

/** Op dispatch — omp todo.ts:399-470 verbatim (the L1 state machine). */
function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
  switch (entry.op) {
    case "init":
      return initPhases(entry, errors);
    case "start": {
      const hit = resolveTaskOrError(phases, entry.task, errors);
      if (!hit) return phases;
      for (const phase of phases) {
        for (const candidate of phase.tasks) {
          if (candidate.status === "in_progress" && candidate !== hit.task) {
            candidate.status = "pending";
          }
        }
      }
      hit.task.status = "in_progress";
      return phases;
    }
    case "done": {
      for (const task of getTaskTargets(phases, entry, errors)) {
        task.status = "completed";
      }
      return phases;
    }
    case "drop": {
      for (const task of getTaskTargets(phases, entry, errors)) {
        task.status = "abandoned";
      }
      return phases;
    }
    case "block": {
      if (!entry.task && !entry.phase) {
        errors.push("block requires a task or phase target");
        return phases;
      }
      // Collapse whitespace runs (incl. newlines) to single spaces: a blocker
      // note rides on one Markdown checklist line (as a trailing HTML comment)
      // and one HUD/summary line, so an embedded newline from a multi-line
      // external error or user question would corrupt the round-trip parse and
      // the rendered line. Normalizing here keeps every consumer one-line-safe.
      // omp todo.ts:438 semantics (`|| undefined`): an empty note collapses
      // to no note; nullish coalescing would keep "" as the blocker value,
      // so the falsy collapse is spelled out for the coalescing lint.
      const collapsed = entry.reason?.replace(/\s+/g, " ").trim();
      const reason = collapsed === "" ? undefined : collapsed;
      for (const task of getTaskTargets(phases, entry, errors)) {
        // Only actionable open work can be blocked: blocking a phase must not
        // reopen completed/abandoned tasks or erase finished progress. An
        // already-blocked task stays eligible so a later block can refine its
        // blocker note (e.g. first blocked without a reason, then with one).
        if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
        task.status = "blocked";
        task.blocker = reason;
      }
      return phases;
    }
    case "unblock": {
      if (!entry.task && !entry.phase) {
        errors.push("unblock requires a task or phase target");
        return phases;
      }
      for (const task of getTaskTargets(phases, entry, errors)) {
        if (task.status === "blocked") {
          task.status = "pending";
          task.blocker = undefined;
        }
      }
      return phases;
    }
    case "rm":
      return removeTasks(phases, entry, errors);
    case "append":
      return appendItems(phases, entry, errors);
    case "view":
      return phases;
  }
}

/**
 * Infer a missing `op` from the raw argument shape. Only unambiguous shapes
 * are inferred (omp todo.ts:481-488 verbatim):
 * - `list` → `init` (list is init-only)
 * - `items` + `phase` → `append` (lazily creates the phase, so the result
 *   matches a single-phase init when nothing exists yet)
 * - bare `items` with no existing todos → `init` (nothing to overwrite)
 * Targeting args alone (`task`/`phase`) map to several ops and stay an error.
 */
function inferTodoOp(args: Record<string, unknown>, hasExistingPhases: boolean): TodoOperation | undefined {
  if (Array.isArray(args.list) && args.list.length > 0) return "init";
  if (Array.isArray(args.items) && args.items.length > 0) {
    if (typeof args.phase === "string" && args.phase) return "append";
    if (!hasExistingPhases) return "init";
  }
  return undefined;
}

/**
 * Validate execute-time arguments, repairing an omitted `op`. The tool sets
 * `lenientArgValidation`, so the agent loop hands `execute()` the raw
 * arguments when schema validation fails; the only failure repaired here is
 * a missing `op` alongside an unambiguous payload (models routinely send
 * `{list:[...]}` with no op). Anything else returns the schema error text
 * for a normal model retry. (omp todo.ts:498-509 verbatim; the schema is the
 * registry row's — the single schema authority, not a copy.)
 */
export function resolveTodoParams(raw: unknown, hasExistingPhases: boolean): TodoOpEntryValue | string {
  const direct = todoSchema(raw);
  if (!(direct instanceof type.errors)) return direct;
  // omp isRecord(raw) inlined to property checks (repo guard rule): only the
  // `op` key is probed, and the spread below needs plain-object-ness.
  if (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).op === undefined
  ) {
    const rawArgs = raw as Record<string, unknown>;
    const inferred = inferTodoOp(rawArgs, hasExistingPhases);
    if (inferred) {
      const repaired = todoSchema({ ...rawArgs, op: inferred });
      if (!(repaired instanceof type.errors)) return repaired;
    }
  }
  return `Invalid todo arguments: ${direct.summary}`;
}

function applyParams(phases: TodoPhase[], params: TodoOpEntryValue): { phases: TodoPhase[]; errors: string[] } {
  const errors: string[] = [];
  const next = applyEntry(phases, params, errors);
  normalizeInProgressTask(next);
  return { phases: next, errors };
}

// =============================================================================
// Summary rendering — omp todo.ts:634-706 formatSummary verbatim
// =============================================================================

export function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) {
    if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
    return readOnly ? "Todo list is empty." : "Todo list cleared.";
  }

  const remainingByPhase = phases
    .map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
    }))
    .filter((phase) => phase.tasks.length > 0);
  const remainingTasks = remainingByPhase.flatMap((phase) =>
    phase.tasks.map((task) => ({ ...task, phase: phase.name })),
  );

  let currentIdx = phases.findIndex((phase) =>
    phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress"),
  );
  if (currentIdx === -1) currentIdx = phases.length - 1;
  const current = phases[currentIdx];
  // Unreachable: `tasks` is the flatMap of `phases`, so non-empty tasks
  // imply a valid `currentIdx` (repo noUncheckedIndexedAccess narrow).
  if (current === undefined) return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";
  const done = current.tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;

  const lines: string[] = [];
  if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
  if (remainingTasks.length === 0) {
    lines.push("Remaining items: none.");
  } else {
    lines.push(`Remaining items (${remainingTasks.length}):`);
    for (const task of remainingTasks) {
      lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
    }
  }
  // Closed = completed + abandoned, mirroring the per-phase `done` count.
  const closedAll = tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;
  const blockedAll = tasks.filter((task) => task.status === "blocked").length;
  // The active phase is the EARLIEST one still holding open work, so the
  // in-progress pointer can sit in a phase whose successors already have
  // completed tasks. Detect that "worked ahead" case to explain the
  // otherwise-surprising backward pointer instead of letting it read as a
  // completed task reverting to pending.
  const workedAhead = phases.some(
    (phase, idx) =>
      idx > currentIdx && phase.tasks.some((task) => task.status === "completed" || task.status === "abandoned"),
  );
  lines.push(
    `Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`,
  );
  lines.push(
    `Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${
      workedAhead
        ? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
        : "."
    }`,
  );
  for (const phase of phases) {
    lines.push(`  ${phase.name}:`);
    for (const task of phase.tasks) {
      const checkbox = task.status === "completed" ? "[X]" : "[ ]";
      const tag =
        task.status === "in_progress"
          ? " (in progress)"
          : task.status === "abandoned"
            ? " (dropped)"
            : task.status === "blocked"
              ? task.blocker
                ? ` (blocked: ${task.blocker})`
                : " (blocked)"
              : "";
      lines.push(`    - ${checkbox} ${task.content}${tag}`);
    }
  }
  return lines.join("\n");
}

/** Apply one resolved op with post-normalization (omp applyParams). */
export { applyParams, clonePhases };
