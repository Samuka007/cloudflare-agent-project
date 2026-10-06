import type { AnyAgentEvent } from "./fsm-events.js";

/**
 * #309 manual compact — the pure planning face (journal checkpoint-style
 * compaction, #116 replay semantics: the boundary is derived from the log,
 * never a deletion). Semantic kernel ported per anchor from pi
 * compaction/compaction.ts via the #314 vendored kernel
 * (test/pi-port/compaction-kernel.ts); our journal is turn-granular, so the
 * pi entry-level walk reduces to a turn-level walk with the same guarantees:
 *
 * - Cut points are turn starts only (`turn.input` rows). pi cuts at
 *   user/custom messages and never between a tool call and its result
 *   (upstream pi #9740 regression, compaction.ts:351-501 via kernel
 *   findProjectedCutPoint); our tool.call/tool.result pairs live strictly
 *   inside their turn, so a turn-boundary cut cannot split a pair — the
 *   assertion test pins this structurally.
 * - keepRecentTokens retains the newest tail (kernel
 *   DEFAULT_COMPACTION_SETTINGS, pi compaction.ts:126-130).
 * - The previous summary chains naturally: prior compact turns are journal
 *   rows like any turn, so the summarizer's (uncut) request always reads
 *   them, and a cut that swallows them folds their text into the new summary
 *   input (kernel previousSummary semantics, pi compaction.ts:772-936).
 */

/** pi compaction/compaction.ts:126-130 via kernel DEFAULT_COMPACTION_SETTINGS. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

// ---------------------------------------------------------------------------
// Overflow trigger + reactive retry (#326) — the pi shouldCompact threshold and
// the context-overflow recovery face
// ---------------------------------------------------------------------------

/**
 * pi CompactionSettings reduced to the trigger face (pi
 * compaction/compaction.ts:126-130, kernel DEFAULT_COMPACTION_SETTINGS):
 * `reserveTokens` is the headroom a request must keep below the window,
 * `keepRecentTokens` the retention budget the cut planner preserves.
 */
export interface CompactionTriggerSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

/** pi compaction/compaction.ts:126-130 defaults (kernel parity). */
export const DEFAULT_COMPACTION_TRIGGER_SETTINGS: CompactionTriggerSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
};

/**
 * pi compaction/compaction.ts:264-270 (kernel shouldCompact): the context
 * needs compaction once it presses against the window minus the reserve.
 * `contextWindow: null` (the deployment cannot name a window) never triggers —
 * consumers must not fabricate a threshold without a denominator (#308
 * honest-absence posture).
 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number | null,
  settings: CompactionTriggerSettings,
): boolean {
  if (!settings.enabled) return false;
  if (contextWindow === null) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

/**
 * The projected context size of the NEXT model call: the last usage receipt
 * anchors the count (the provider's own view of that request, #308), and the
 * journal rows appended after it are estimated with the same bytes/4 walk the
 * cut planner uses (pi estimateContextTokens' usage-first / estimate-forward
 * shape, compaction.ts:196-224). No receipt at all → a whole-journal estimate
 * (rough, but the reactive overflow face is the correctness backstop).
 */
export function projectedContextTokens(events: readonly AnyAgentEvent[]): {
  tokens: number;
  contextWindow: number | null;
} {
  const usage = lastUsageTotal(events);
  // A checkpoint anchor supersedes a stale pre-cut receipt: the receipt
  // priced rows the cut later hid, so once a `thread/compacted` marker is
  // the newest measurement, its own visible-tail estimate is the truth
  // (without this, every post-cut turn re-triggers the gate on the ghost
  // pre-cut size).
  let marker: { seq: number; tokensAfter: number; contextWindow: number | null } | null = null;
  for (const event of events) {
    if (event.type === "thread/compacted") {
      marker = {
        seq: event.seq,
        tokensAfter: event.data.tokensAfter,
        contextWindow: event.data.contextWindow,
      };
    }
  }
  const boundary = marker;
  if (boundary !== null && (usage === null || boundary.seq > usage.seq)) {
    const tail = events.filter((event) => event.seq > boundary.seq);
    return {
      tokens: boundary.tokensAfter + estimateTurnTokens(tail),
      contextWindow: boundary.contextWindow,
    };
  }
  // With a receipt: its total anchors the size and only the rows appended
  // after it are estimated (tool calls/results of the settled call — the
  // delta the next request adds). Without one: the whole journal estimated.
  const tail = usage === null ? events : events.filter((event) => event.seq > usage.seq);
  return {
    tokens: (usage?.usedTokens ?? 0) + estimateTurnTokens(tail),
    contextWindow: usage?.contextWindow ?? null,
  };
}

/**
 * The provider's context-overflow verdict inside a failure message. Anchored
 * to the real upstream shapes only — a generic 400 must keep today's raw
 * failure, not get hijacked into a compaction cycle:
 * - Anthropic `invalid_request_error`: "prompt is too long: N tokens > M maximum"
 * - OpenAI `invalid_request_error` code `context_length_exceeded`, message
 *   "This model's maximum context length is ... tokens"
 */
export function isContextOverflowFailure(message: string): boolean {
  return (
    /\bprompt is too long\b/i.test(message) ||
    /\bcontext_length_exceeded\b/i.test(message) ||
    /\bmaximum context length\b/i.test(message)
  );
}

/**
 * The reactive retry cut ladder (#326): the estimator said the journal fit
 * `keepRecentTokens`, yet the provider rejected the request — the estimate
 * underestimated (image bytes, provider tokenizer divergence). Halve the
 * retention, then fall to minimal retention (newest turn only). Each rung is
 * the same turn-granular planner, so every rung inherits the tool-pair
 * guarantee. Undefined at every rung = nothing can be summarized (single-turn
 * journal) — the raw failure stands.
 */
export function planRetryCut(
  events: readonly AnyAgentEvent[],
  keepRecentTokens: number = DEFAULT_KEEP_RECENT_TOKENS,
): CompactCutPlan | undefined {
  for (const budget of [keepRecentTokens, Math.floor(keepRecentTokens / 2), 0]) {
    const plan = planCompactCut(events, budget);
    if (plan !== undefined) return plan;
  }
  return undefined;
}

/**
 * The compact turn's user-side material. It doubles as (a) the summarizer's
 * instruction and (b) the visible history row future requests read ("the user
 * asked for a compact; the assistant produced the summary"), so it is written
 * to read sensibly in both positions. Structured sections follow omp
 * compaction-summary.md (compaction-two-source-map §2.3) with the
 * verbatim-preserve list.
 */
export const COMPACT_DIRECTIVE_TEXT = [
  "[context-compact] The conversation above is near the model's context window.",
  "Produce the structured handoff summary that replaces it. Sections:",
  "Goal / Constraints & Preferences / Progress (Done · In Progress · Blocked) /",
  "Key Decisions / Next Steps / Critical Context.",
  "MUST preserve verbatim: any unanswered question awaiting the user, exact file",
  "paths, function names, error messages, decisive tool outputs, repository state",
  "(branch, uncommitted changes). Keep the retained recent turns as-is; do not",
  "summarize them again.",
].join(" ");

/**
 * bytes/4 over the turn's model-visible text material (kernel estimateTokens,
 * pi compaction.ts:276-349 — chars/4 conservative heuristic; our journal rows
 * are text-only, images do not exist on this surface). Turn-granular on
 * purpose: the cut boundary is a turn start, so the unit of retention is the
 * whole turn.
 */
export function estimateTurnTokens(events: readonly AnyAgentEvent[]): number {
  let bytes = 0;
  const encoder = new TextEncoder();
  const count = (text: string): void => {
    bytes += encoder.encode(text).byteLength;
  };
  for (const event of events) {
    switch (event.type) {
      case "turn.input":
      case "turn.steer": {
        // #317 opened the prompt surface to image parts; only text parts
        // carry estimable text (image byte sizes ride their attachment
        // refs, counted where the result detours).
        for (const part of event.data.content) {
          if (part.type === "text") count(part.text);
        }
        break;
      }
      case "model.call_completed": {
        count(event.data.text);
        break;
      }
      case "tool.call": {
        count(JSON.stringify(event.data.arguments));
        break;
      }
      case "tool.result": {
        // Blob-detoured results carry their real byte size in the ref —
        // count that instead of stringifying the stub.
        const { output } = event.data;
        if (typeof output === "string") count(output);
        else bytes += output.__blob__.size;
        break;
      }
      // State rows and non-text families contribute no model-visible bytes.
      case "experimental_context_notes":
      case "interaction.interrupted":
      case "interaction.registered":
      case "interaction.resolved":
      // B1 (#321): the image rides the host-files face, not request text.
      case "imageView":
      case "job.delivered":
      case "job.registered":
      case "job.settled":
      case "model.call_failed":
      case "model.call_retry":
      case "model.call_sealed":
      case "model.call_started":
      case "model.delta":
      case "model.thinking":
      case "model.usage_receipt":
      case "peer.message":
      case "peer.message_consumed":
      case "task.async_result":
      case "task.budget_notice":
      case "task.spawn_planned":
      case "task.spawn_settled":
      case "task.subagent_aborted":
      case "task.subagent_event":
      case "task.subagent_flush":
      case "task.subagent_identity":
      case "task.subagent_parked":
      case "task.subagent_revived":
      case "task.yield_completed":
      case "task.yield_reminder":
      case "task.yield_warning":
      case "thread.created":
      case "thread.rebound":
      case "thread.execution_updated":
      case "thread/compacted":
      case "todo_phases":
      case "tool.dispatch":
      case "tool.exec_started":
      case "tool.output":
      case "turn.cancel_requested":
      case "turn.cancelled":
      case "turn.completed":
      case "turn.failed":
      case "turn.phase":
      default:
        break;
    }
  }
  return Math.ceil(bytes / 4);
}

export interface CompactTurnSlice {
  /** The turn's `turn.input` row — the cut point candidate. */
  inputSeq: number;
  events: AnyAgentEvent[];
  estimatedTokens: number;
}

/**
 * Group the journal into turn slices (omp session-entry stream reduced to our
 * turn grouping): everything from a `turn.input` row up to (exclusive) the
 * next `turn.input` row. Rows before the first `turn.input` (thread.created,
 * rebinds) attach to no slice — they are context-invisible state rows.
 */
export function turnSlices(events: readonly AnyAgentEvent[]): CompactTurnSlice[] {
  const slices: CompactTurnSlice[] = [];
  let current: CompactTurnSlice | null = null;
  for (const event of events) {
    if (event.type === "turn.input") {
      current = { inputSeq: event.seq, events: [event], estimatedTokens: 0 };
      slices.push(current);
      continue;
    }
    if (current !== null) current.events.push(event);
  }
  for (const slice of slices) slice.estimatedTokens = estimateTurnTokens(slice.events);
  return slices;
}

export interface CompactCutPlan {
  /** First turn that stays visible (pi firstKeptEntryIndex, seq-keyed). */
  firstKeptTurnInputSeq: number;
  /** Journal rows ≤ this leave the active context (firstKeptTurn.inputSeq − 1). */
  hideThroughSeq: number;
  /** Estimated tokens of the visible tail the cut retains. */
  keptTurns: CompactTurnSlice[];
}

/**
 * Plan the cut (pi compaction.ts:351-501 findProjectedCutPoint +
 * :772-936 prepareCompaction, turn-granular): walk turns newest → oldest
 * accumulating estimates; the turn where the accumulation crosses
 * `keepRecentTokens` is the first kept turn (pi cuts at the closest valid cut
 * point at/after the crossing). Undefined when the whole journal fits the
 * retention budget — nothing to summarize (pi prepareCompaction → undefined).
 */
export function planCompactCut(
  events: readonly AnyAgentEvent[],
  keepRecentTokens: number = DEFAULT_KEEP_RECENT_TOKENS,
): CompactCutPlan | undefined {
  const slices = turnSlices(events);
  if (slices.length === 0) return undefined;
  let accumulated = 0;
  let firstKeptIndex = slices.length;
  for (let index = slices.length - 1; index >= 0; index--) {
    const slice = slices[index];
    if (slice === undefined) continue;
    accumulated += slice.estimatedTokens;
    if (accumulated >= keepRecentTokens) {
      firstKeptIndex = index;
      break;
    }
  }
  if (firstKeptIndex === slices.length) return undefined;
  // Crossing at the oldest turn = even the full journal barely clears the
  // budget: the post-cut kept tail would be the whole conversation, so there
  // is no span worth summarizing (pi prepareCompaction's kept-still-fits
  // → undefined, compaction.ts:872-936).
  if (firstKeptIndex === 0) return undefined;
  const kept = slices.slice(firstKeptIndex);
  const firstKept = kept[0];
  if (firstKept === undefined) return undefined;
  return {
    firstKeptTurnInputSeq: firstKept.inputSeq,
    hideThroughSeq: firstKept.inputSeq - 1,
    keptTurns: kept,
  };
}

/**
 * bytes/4 over the post-cut visible tail (the estimated `tokensAfter` the
 * checkpoint row records): kept tail turns plus the compact turn's directive
 * + summary. Shares the estimator with the planner so the indicator's drop is
 * measured in the same units the cut was planned in.
 */
export function estimateVisibleTailTokens(options: {
  keptTurns: readonly CompactTurnSlice[];
  directiveText: string;
  summaryText: string;
}): number {
  const kept = options.keptTurns.reduce((sum, slice) => sum + slice.estimatedTokens, 0);
  const encoder = new TextEncoder();
  const compactTurn =
    encoder.encode(options.directiveText).byteLength +
    encoder.encode(options.summaryText).byteLength;
  return Math.ceil((kept + compactTurn) / 4);
}

/** The latest usage-receipt total (usedTokens fold, ux-projection semantics). */
export function lastUsageTotal(events: readonly AnyAgentEvent[]): {
  /** The receipt's own seq — the anchor for tail estimates (#326). */
  seq: number;
  usedTokens: number;
  contextWindow: number | null;
} | null {
  let latest: { seq: number; usedTokens: number; contextWindow: number | null } | null = null;
  for (const event of events) {
    if (event.type !== "model.usage_receipt") continue;
    const { usage } = event.data;
    const usedTokens =
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens;
    if (latest === null || event.seq > latest.seq) {
      latest = { seq: event.seq, usedTokens, contextWindow: usage.contextWindow };
    }
  }
  if (latest === null) return null;
  return { seq: latest.seq, usedTokens: latest.usedTokens, contextWindow: latest.contextWindow };
}
