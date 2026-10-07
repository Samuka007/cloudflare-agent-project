import type {
  PendingInteractionRow,
  PendingInteractionPayload,
  PendingInteractionResolution,
  PendingInteractionUserQuestionQuestion,
  UserQuestionPendingInteractionResolution,
} from "@cap/protocol";
import {
  isUserQuestionPendingInteractionResolution,
  pendingInteractionPayloadSchema,
} from "@cap/protocol";
import type { AnyAgentEvent } from "../fsm-events.js";
import type { TurnFsmStatus } from "../turn-state.js";
import type { EdgeToolResult } from "./edge.js";

/**
 * Edge `ask` (M1.5 T4, omp tools/ask.ts port; ticket #94): the model asks
 * structured questions, the DO registers a pending interaction (bb
 * interactive-request shape), the SPA rules through the WS-pushed journal
 * surface, and the ruling backflow unlocks the turn.
 *
 * Storage/timer policy stays in the DO (journal accessors + wake map +
 * alarm-carried expiry); this module is pure decision logic over journal
 * projections, exactly like tools/wait.ts. omp semantics verbatim (#74):
 * ask.timeout default 0 = no timeout (unbounded pending row suspends the
 * turn watchdog), user cancellation is the interrupt path (omp
 * ToolAbortError ⇒ EdgeToolResult "cancelled"), re-ask after eviction
 * answers from the journal (bb created|existing dedup).
 */

/** omp ask.ts:51-58 — reserved runtime labels, fail closed at the schema. */
export const OTHER_OPTION = "Other (type your own)";
export const CHAT_ABOUT_THIS_OPTION = "Chat about this";
export const NEXT_OPTION = "Next →";
export const RESERVED_OPTION_LABELS: Record<string, true> = {
  [OTHER_OPTION]: true,
  [CHAT_ABOUT_THIS_OPTION]: true,
  [NEXT_OPTION]: true,
};

export type AskWake =
  | { kind: "resolved"; resolution: PendingInteractionResolution }
  | { kind: "cancelled" }
  | { kind: "expiry" };

/** omp AskOption/QuestionResult essentials projected through the bb payload. */
export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multi?: boolean;
  recommended?: number;
}

/** DO-bound context for one ask execution (see module docstring). */
export interface AskToolContext {
  readonly executionId: string;
  readonly threadId: string;
  readonly turnId: string;
  /** Owning turn FSM status — a turn already cancelling must not re-block. */
  owningTurnStatus(): TurnFsmStatus | undefined;
  /** Project this execution's interaction row from the journal (if any). */
  interactionForExecution(): Promise<InteractionProjection | undefined>;
  /** Register one pending interaction (journal append; pushes over /ws). */
  registerInteraction(input: {
    interactionId: string;
    payload: PendingInteractionPayload;
    expiresAt: number | null;
  }): Promise<void>;
  /** Mark the pending row interrupted (journal append) — journal-before-result. */
  interruptInteraction(statusReason: string): Promise<void>;
  /** Resolves on the next wake: ruling backflow, interrupt, or expiry. */
  wake(): Promise<AskWake>;
  /** Deployment-time ask cap in ms; 0 = disabled (omp ask.timeout default). */
  readonly askTimeoutMs: number;
  now(): number;
}

/** Journal-folded interaction row keyed to one ask execution. */
export interface InteractionProjection {
  interactionId: string;
  status: "pending" | "resolved" | "interrupted";
  payload: PendingInteractionPayload;
  resolution?: PendingInteractionResolution;
}

// ---------------------------------------------------------------------------
// omp → bb payload mapping (bb omp-bridge buildOmpUserQuestion, DO-local)
// ---------------------------------------------------------------------------

/** bb ompSelectOptionValue scheme, scoped by the owning execution id. */
export function askOptionValue(executionId: string, index: number): string {
  return `omp-ui:${executionId}:option-${index + 1}`;
}

/**
 * Map one omp question onto the bb user_question shape: prompt/shortLabel/
 * multiSelect + value-stamped options; allowFreeText mirrors the "Other
 * (type your own)" affordance omp's UI always adds (P:ask.md — "NEVER supply
 * Other"); `recommended` rides additively for the timeout auto-select.
 */
export function askQuestionToPayload(
  executionId: string,
  question: AskQuestion,
): PendingInteractionUserQuestionQuestion {
  const header = question.header?.trim();
  return {
    id: question.id,
    prompt: question.question,
    ...(header !== undefined && header !== "" ? { shortLabel: header } : {}),
    multiSelect: question.multi ?? false,
    ...(question.options.length > 0
      ? {
          options: question.options.map((option, index) => ({
            value: askOptionValue(executionId, index),
            label: option.label,
            ...(option.description?.trim() ? { description: option.description.trim() } : {}),
          })),
        }
      : {}),
    allowFreeText: true,
    ...(question.recommended !== undefined ? { recommended: question.recommended } : {}),
  };
}

export function buildAskPayload(
  executionId: string,
  questions: readonly AskQuestion[],
): PendingInteractionPayload {
  return {
    kind: "user_question",
    questions: questions.map((question) => askQuestionToPayload(executionId, question)),
  };
}

// ---------------------------------------------------------------------------
// Resolution validation (bb schema + omp bridge option-match semantics)
// ---------------------------------------------------------------------------

/**
 * Validate a ruling against the registered questions. Invalid backflow is an
 * RPC-level rejection (the interaction stays pending); valid resolutions are
 * journal-writable so an executor re-ask after eviction renders the same
 * answer from the journal alone.
 */
export function validateAskResolution(
  payload: PendingInteractionPayload,
  resolution: PendingInteractionResolution,
):
  | { ok: true; answers: UserQuestionPendingInteractionResolution["answers"] }
  | { ok: false; reason: string } {
  if (!isUserQuestionPendingInteractionResolution(resolution)) {
    return { ok: false, reason: "Resolution kind must be user_answer" };
  }
  // Single-member payload union today (user_question); grows with the
  // approval kind when a bb approval ticket lands — checks return then.
  const questions = payload.questions;
  const answers = resolution.answers;
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === undefined) {
      return { ok: false, reason: `Missing answer for question '${question.id}'` };
    }
    const optionValues = new Set((question.options ?? []).map((option) => option.value));
    for (const value of answer.selected) {
      if (!optionValues.has(value)) {
        return {
          ok: false,
          reason: `Answer for '${question.id}' does not match an available option`,
        };
      }
    }
    if (!question.multiSelect) {
      const pickedOne = answer.selected.length === 1 && answer.freeText === undefined;
      const freeOnly = answer.selected.length === 0 && answer.freeText !== undefined;
      if (!pickedOne && !freeOnly) {
        return {
          ok: false,
          reason: `Single-select question '${question.id}' needs exactly one selected option or free text`,
        };
      }
    }
    if (!question.allowFreeText && answer.freeText !== undefined) {
      return { ok: false, reason: `Question '${question.id}' does not accept free text` };
    }
  }
  for (const id of Object.keys(answers)) {
    if (!questions.some((question) => question.id === id)) {
      return { ok: false, reason: `Answer for unknown question '${id}'` };
    }
  }
  return { ok: true, answers };
}

// ---------------------------------------------------------------------------
// omp-verbatim result rendering (ask.ts formatQuestionResult /
// formatSingleQuestionResponse; the DO's tool.result surface is `output`)
// ---------------------------------------------------------------------------

interface RenderedAnswer {
  selectedOptions: string[];
  customInput?: string;
  timedOut?: boolean;
  multi: boolean;
}

/** Selected values → labels (bb bridge returns selected.label to omp). */
export function answerToRenderedAnswer(
  question: PendingInteractionUserQuestionQuestion,
  answer: { selected: string[]; freeText?: string },
  timedOut = false,
): RenderedAnswer {
  const labelByValue = new Map(
    (question.options ?? []).map((option) => [option.value, option.label]),
  );
  return {
    selectedOptions: answer.selected.map((value) => labelByValue.get(value) ?? value),
    customInput: answer.freeText,
    ...(timedOut ? { timedOut: true } : {}),
    multi: question.multiSelect,
  };
}

export function formatSingleQuestionResponse(result: RenderedAnswer): string {
  const responseParts: string[] = [];
  if (result.selectedOptions.length > 0) {
    const selectedText = result.multi
      ? `User selected: ${result.selectedOptions.join(", ")}`
      : `User selected: ${result.selectedOptions[0]}`;
    responseParts.push(
      result.timedOut === true ? `${selectedText} (auto-selected after timeout)` : selectedText,
    );
  }
  if (result.customInput !== undefined) {
    responseParts.push(
      result.customInput.includes("\n")
        ? `User provided custom input:\n${result.customInput
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n")}`
        : `User provided custom input: ${result.customInput}`,
    );
  }
  if (responseParts.length > 0) return responseParts.join("\n");
  return result.multi ? "User did not select any options" : "User cancelled the selection";
}

export function formatQuestionResult(
  question: PendingInteractionUserQuestionQuestion,
  result: RenderedAnswer,
): string {
  const suffix = result.timedOut === true ? " (auto-selected after timeout)" : "";
  if (result.customInput !== undefined) {
    return `${question.id}: "${result.customInput}"${suffix}`;
  }
  if (result.selectedOptions.length > 0) {
    return result.multi
      ? `${question.id}: [${result.selectedOptions.join(", ")}]${suffix}`
      : `${question.id}: ${result.selectedOptions[0]}${suffix}`;
  }
  return result.multi ? `${question.id}: []` : `${question.id}: (cancelled)`;
}

/** Render one or many questions from validated answers (omp execute tail). */
export function renderAskOutput(
  payload: PendingInteractionPayload,
  answers: UserQuestionPendingInteractionResolution["answers"],
  timedOut = false,
): string {
  const questions = payload.questions;
  if (questions.length === 1) {
    const question = questions[0];
    if (question === undefined) return "User cancelled the selection";
    const answer = answers[question.id] ?? { selected: [] };
    return formatSingleQuestionResponse(answerToRenderedAnswer(question, answer, timedOut));
  }
  const lines = questions.map((question) => {
    const answer = answers[question.id] ?? { selected: [] };
    return formatQuestionResult(question, answerToRenderedAnswer(question, answer, timedOut));
  });
  return `User answers:\n${lines.join("\n")}`;
}

/**
 * omp askSingleQuestion timeout fallback (getAutoSelectionOnTimeout): the
 * valid recommended option, else the first option; free-text-only questions
 * auto-answer nothing and surface the no-selection text.
 */
export function timeoutAutoSelect(question: PendingInteractionUserQuestionQuestion): {
  selected: string[];
  freeText?: string;
} {
  const options = question.options ?? [];
  if (options.length === 0) return { selected: [] };
  const recommended =
    question.recommended !== undefined &&
    question.recommended >= 0 &&
    question.recommended < options.length
      ? question.recommended
      : 0;
  const option = options[recommended];
  return option === undefined ? { selected: [] } : { selected: [option.value] };
}

// ---------------------------------------------------------------------------
// Journal projection + executor
// ---------------------------------------------------------------------------

/**
 * SPA-renderable fold of every interaction row into the protocol
 * `PendingInteractionRow` shape (bb listPendingInteractionsByThread row +
 * lifecycle transitions). One pass over the journal; terminal rows fold onto
 * their registered row at-most-once (same guard the FSM applies).
 */
export function projectInteractionRows(
  events: readonly AnyAgentEvent[],
): PendingInteractionRow[] {
  const byId = new Map<string, PendingInteractionRow>();
  for (const event of events) {
    if (event.type === "interaction.registered") {
      const {
        interactionId,
        turnId,
        executionId,
        providerId,
        providerThreadId,
        providerRequestId,
        expiresAt,
        payload,
      } = event.data;
      byId.set(interactionId, {
        id: interactionId,
        threadId: event.threadId,
        status: "pending",
        statusReason: null,
        createdAt: event.createdAt,
        expiresAt,
        resolvedAt: null,
        executionId,
        turnId,
        origin: { kind: "provider", providerId, providerThreadId, providerRequestId },
        payload,
        resolution: null,
      });
    } else if (event.type === "interaction.resolved") {
      const row = byId.get(event.data.interactionId);
      if (row?.status === "pending") {
        row.status = "resolved";
        row.resolution = event.data.resolution;
        row.resolvedAt = event.createdAt;
      }
    } else if (event.type === "interaction.interrupted") {
      const row = byId.get(event.data.interactionId);
      if (row?.status === "pending") {
        row.status = "interrupted";
        row.statusReason = event.data.statusReason;
        row.resolvedAt = event.createdAt;
      }
    }
  }
  return [...byId.values()];
}

/** Latest interaction row for this execution (replay-derivable state). */
export function interactionForExecution(
  events: readonly AnyAgentEvent[],
  executionId: string,
): InteractionProjection | undefined {
  const row = projectInteractionRows(events).find(
    (candidate) => candidate.executionId === executionId,
  );
  if (row === undefined) return undefined;
  // The fold only ever produces pending|resolved|interrupted (never the bb
  // resolving in-flight state — the DO settles synchronously).
  const status: InteractionProjection["status"] =
    row.status === "interrupted" ? "interrupted" : row.status === "resolved" ? "resolved" : "pending";
  return {
    interactionId: row.id,
    status,
    payload: row.payload,
    ...(row.resolution !== null ? { resolution: row.resolution } : {}),
  };
}

/**
 * omp AskTool.execute, DO-local: register → block on the DO wake channel →
 * render the ruling (or cancelled/expiry). The duplicated-dispatch guard and
 * the terminal re-ask answer both come from the journal projection, so a
 * re-asked executionId never registers a second interaction (bb
 * created|existing) and a ruling that landed while the executor was evicted
 * is still the tool's answer (replay consistency, §1).
 */
export async function runAskTool(
  args: Record<string, unknown>,
  ctx: AskToolContext,
): Promise<EdgeToolResult> {
  // Boundary cast: the registry row's schema validated `questions` before
  // dispatch (row = single schema authority, tools/edge.ts runEdgeTool);
  // registry-row erasure collapsed the inference to `Type`.
  const questions = args.questions as AskQuestion[];
  // omp ask.ts:663-676 — reserved runtime labels fail closed (the schema
  // narrow cannot ride the wire serializer; this is omp's equivalent
  // post-validation gate, first before anything registers).
  const reserved = questions
    .flatMap((question) => question.options)
    .find((option) => RESERVED_OPTION_LABELS[option.label] === true);
  if (reserved !== undefined) {
    return {
      status: "error",
      output: `Error: option labels must not collide with reserved runtime labels: ${reserved.label}`,
    };
  }
  // omp ask.ts:703-732 — duplicate ids/labels fail closed.
  const seenIds = new Set<string>();
  for (const question of questions) {
    if (seenIds.has(question.id)) {
      return { status: "error", output: `Error: question ids must be unique: ${question.id}` };
    }
    seenIds.add(question.id);
    const seenLabels = new Set<string>();
    for (const option of question.options) {
      if (seenLabels.has(option.label)) {
        return {
          status: "error",
          output: `Error: option labels must be unique within a question: ${option.label}`,
        };
      }
      seenLabels.add(option.label);
    }
  }
  // #478 fail-closed: the omp-verbatim arktype row (registry.ts) validates a
  // superset of the DO payload schema (protocol pending-interactions.ts —
  // non-blank id/prompt/label, `recommended: int ≥ 0`), so a divergent model
  // shape would otherwise reach the `interaction.registered` append and the
  // event-log zod parse would throw OUT of this executor — the turn driver
  // fiber dies mid-wave and the alarm re-ask loop re-throws forever (a stuck
  // turn, never an honest failure; #436 doctrine). Validate the projected
  // payload against the SAME schema the journal append enforces and surface
  // the divergence as an explicit tool error before anything registers.
  const payload = buildAskPayload(ctx.executionId, questions);
  const divergent = pendingInteractionPayloadSchema.safeParse(payload);
  if (!divergent.success) {
    const detail = divergent.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "(payload)"}: ${issue.message}`)
      .join("; ");
    return {
      status: "error",
      output: `Error: ask payload diverged from the pending-interaction schema: ${detail}`,
    };
  }

  const existing = await ctx.interactionForExecution();
  if (existing !== undefined) {
    if (existing.status === "interrupted") {
      return { status: "cancelled", output: "Ask input was cancelled" };
    }
    if (existing.status === "pending" && ctx.owningTurnStatus() === "cancelling") {
      // Kill raced the executor away (eviction + recovery): the re-dispatched
      // run finishes the interrupt instead of re-blocking a dying turn.
      await ctx.interruptInteraction("turn cancelled while ask was pending");
      return { status: "cancelled", output: "Ask tool was cancelled by the user" };
    }
    if (existing.status === "resolved" && existing.resolution !== undefined) {
      const validated = validateAskResolution(existing.payload, existing.resolution);
      if (!validated.ok) {
        return { status: "error", output: `Error: ${validated.reason}` };
      }
      return { status: "ok", output: renderAskOutput(existing.payload, validated.answers) };
    }
    // Pending (outcome "existing"): fall through and re-block on the same row.
  } else {
    if (ctx.owningTurnStatus() === "cancelling") {
      // The turn died between dispatch and registration; nothing to present.
      return { status: "cancelled", output: "Ask input was cancelled" };
    }
    const askTimeoutMs = ctx.askTimeoutMs;
    await ctx.registerInteraction({
      interactionId: `pi_${crypto.randomUUID()}`,
      payload,
      expiresAt: askTimeoutMs > 0 ? ctx.now() + askTimeoutMs : null,
    });
  }

  const wake = await ctx.wake();
  if (wake.kind === "cancelled") {
    // bb interrupt: mark the blocked row interrupted before the cancelled
    // tool.result lands (journal-before-result ordering).
    const pending = await ctx.interactionForExecution();
    if (pending?.status === "pending") {
      await ctx.interruptInteraction("turn cancelled while ask was pending");
    }
    return { status: "cancelled", output: "Ask tool was cancelled by the user" };
  }
  if (wake.kind === "expiry") {
    // omp timeout arm: auto-select the recommended option, mark timedOut,
    // return ok — never a failed turn (docs/tools/ask.md §Flow step 8).
    const pending = await ctx.interactionForExecution();
    if (pending === undefined) {
      return { status: "error", output: "Error: timed-out ask lost its registered questions" };
    }
    const answers: UserQuestionPendingInteractionResolution["answers"] = {};
    for (const question of pending.payload.questions) {
      answers[question.id] = timeoutAutoSelect(question);
    }
    return { status: "ok", output: renderAskOutput(pending.payload, answers, true) };
  }
  const settled = await ctx.interactionForExecution();
  if (settled === undefined) {
    return { status: "error", output: "Error: resolved ask lost its registered questions" };
  }
  const validated = validateAskResolution(settled.payload, wake.resolution);
  if (!validated.ok) {
    return { status: "error", output: `Error: ${validated.reason}` };
  }
  return { status: "ok", output: renderAskOutput(settled.payload, validated.answers) };
}
