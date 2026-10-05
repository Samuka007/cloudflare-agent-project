/**
 * #314 — vendored port of pi's compaction **semantic kernel** (pure
 * functions only, no host/TUI/provider dependencies). This is the
 * test-owned runtime for the ported pi scenarios
 * (`compaction-pi-port.test.ts`); #309 promotes or reimplements the
 * semantics it needs — do not import from production code.
 *
 * Source: github.com/earendil-works/pi @ 98d2e1947aa9 (v1.0.3, the
 * docs/research/pi-parity-matrix.md anchor commit). Each function carries
 * its `pi <path>:<lines>` anchor; bodies are shape-reduced ports, not
 * verbatim copies — pi's rich message/block unions collapse to the text +
 * usage + toolCall surface the ported scenarios exercise.
 *
 * Shape mapping (pi → port):
 * - `SessionEntry` stream → linear `PortEntry[]` (pi tests build linear
 *   arrays too; the entry-id tree reduces to array order).
 * - `AgentMessage` roles user/assistant/toolResult/custom/system keep their
 *   pi names; content blocks collapse to `text` (+ image count, + one
 *   toolCall block on assistant — the cut-point/estimate scenarios' needs).
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** pi Usage (pi-ai compat): totalTokens wins over the component sum. */
export interface PortUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export type PortStopReason = "stop" | "aborted" | "error" | "toolUse";

export type PortMessage =
  | { role: "user"; text: string; images?: number }
  | {
      role: "assistant";
      text: string;
      usage?: PortUsage;
      stopReason?: PortStopReason;
      /** The single toolCall block, if any (pi content blocks reduced to one). */
      toolCall?: { name: string; argsJson: string };
    }
  | { role: "toolResult"; text: string; toolCallId: string }
  | { role: "custom"; text: string }
  | { role: "system"; text: string };

export interface MessageEntry {
  type: "message";
  id: string;
  message: PortMessage;
}

export interface CompactionEntry {
  type: "compaction";
  id: string;
  summary: string;
  firstKeptEntryId: string;
}

export type PortEntry = MessageEntry | CompactionEntry;

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

/** pi compaction/compaction.ts:126-130. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

// ---------------------------------------------------------------------------
// Token calculation — pi compaction/compaction.ts:136-175
// ---------------------------------------------------------------------------

/** Native totalTokens field wins; falls back to the component sum. */
export function calculateContextTokens(usage: PortUsage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Aborted/error and all-zero-usage assistant messages carry no valid usage. */
function assistantUsage(message: PortMessage): PortUsage | undefined {
  if (
    message.role === "assistant" &&
    message.stopReason !== "aborted" &&
    message.stopReason !== "error" &&
    message.usage &&
    calculateContextTokens(message.usage) > 0
  ) {
    return message.usage;
  }
  return undefined;
}

/** Last valid assistant usage, scanning the entry stream backwards. */
export function getLastAssistantUsage(entries: readonly PortEntry[]): PortUsage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const usage = assistantUsage(entry.message);
    if (usage) return usage;
  }
  return undefined;
}

/** pi ContextUsageEstimate (compaction.ts:177-182). */
export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}

/**
 * Last non-zero assistant usage anchors the context size; messages after it
 * are estimated with the chars/4 heuristic (compaction.ts:196-224). This is
 * the pi-side judgment blueprint #308 cites (usage-first, estimate fallback).
 */
export function estimateContextTokens(messages: readonly PortMessage[]): ContextUsageEstimate {
  let anchor: { usage: PortUsage; index: number } | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const usage = message === undefined ? undefined : assistantUsage(message);
    if (usage && message !== undefined) {
      anchor = { usage, index: i };
      break;
    }
  }

  if (anchor === undefined) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }

  const usageTokens = calculateContextTokens(anchor.usage);
  let trailingTokens = 0;
  for (let i = anchor.index + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message !== undefined) trailingTokens += estimateTokens(message);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: anchor.index,
  };
}

// ---------------------------------------------------------------------------
// Token estimation — pi compaction/compaction.ts:276-349
// ---------------------------------------------------------------------------

/** pi ESTIMATED_IMAGE_CHARS (compaction.ts:276). */
export const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * chars/4 heuristic, conservative (overestimates). Images budget as
 * ESTIMATED_IMAGE_CHARS each; assistant tool calls budget name + args JSON.
 */
export function estimateTokens(message: PortMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user":
      chars = message.text.length + (message.images ?? 0) * ESTIMATED_IMAGE_CHARS;
      return Math.ceil(chars / 4);
    case "assistant":
      chars = message.text.length;
      if (message.toolCall)
        chars += message.toolCall.name.length + message.toolCall.argsJson.length;
      return Math.ceil(chars / 4);
    case "toolResult":
    case "custom":
    case "system":
      return Math.ceil(message.text.length / 4);
  }
}

// ---------------------------------------------------------------------------
// Trigger policy — pi compaction/compaction.ts:264-270
// ---------------------------------------------------------------------------

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

// ---------------------------------------------------------------------------
// Cut point detection — pi compaction/compaction.ts:351-501
// ---------------------------------------------------------------------------

/**
 * pi sessionEntryToContextMessages reduced: a message entry yields its
 * message; a compaction entry yields its summary (which the backwards
 * budget walk must still count, compaction.ts:462-464).
 */
function contextMessagesOf(entry: PortEntry): PortMessage[] {
  if (entry.type === "message") return [entry.message];
  return [{ role: "user", text: entry.summary }];
}

/** pi CutPointResult (compaction.ts:421-428). */
export interface CutPointResult {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

/**
 * Walk backwards from newest, accumulating estimated sizes; cut at the
 * closest valid cut point at/after the budget crossing. Compaction rows are
 * budget-bearing boundaries, never cut points (compaction.ts:394-406).
 */
export function findCutPoint(
  entries: readonly PortEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    // pi isCutPointMessage (compaction.ts:351-364): never a tool result —
    // it must follow its tool call — and never a system message.
    if (
      entry?.type === "message" &&
      entry.message.role !== "toolResult" &&
      entry.message.role !== "system"
    ) {
      cutPoints.push(i);
    }
  }

  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0] ?? startIndex;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const messageTokens = contextMessagesOf(entry).reduce(
      (sum, message) => sum + estimateTokens(message),
      0,
    );
    if (messageTokens === 0) continue;
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      cutIndex =
        cutPoints.find((candidate) => candidate >= i) ??
        cutPoints[cutPoints.length - 1] ??
        startIndex;
      break;
    }
  }

  // Include adjacent metadata entries that do not affect context; a
  // compaction row stops the scan — the cut must not orphan the summary
  // (compaction.ts:481-489).
  while (cutIndex > startIndex) {
    const previous = entries[cutIndex - 1];
    if (
      previous === undefined ||
      previous.type === "compaction" ||
      contextMessagesOf(previous).length > 0
    )
      break;
    cutIndex--;
  }

  const cutEntry = entries[cutIndex];
  // pi isTurnStartMessage (compaction.ts:366-379): user/custom rows start a
  // turn; a cut at any other role splits an in-flight turn.
  const startsTurn =
    cutEntry?.type === "message"
      ? cutEntry.message.role === "user" || cutEntry.message.role === "custom"
      : false;
  let turnStartIndex = -1;
  if (!startsTurn) {
    for (let i = cutIndex; i >= startIndex; i--) {
      const entry = entries[i];
      if (
        entry?.type === "message" &&
        (entry.message.role === "user" || entry.message.role === "custom")
      ) {
        turnStartIndex = i;
        break;
      }
    }
  }
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  };
}

// ---------------------------------------------------------------------------
// Context rebuild — pi core/session-manager.ts:468-583
// ---------------------------------------------------------------------------

/** A rebuilt model context: summary-first when a compaction exists. */
export interface SessionContext {
  /** pi models compaction summaries as a dedicated role; ported as user-side text. */
  messages: PortMessage[];
}

/**
 * Latest compaction wins; everything before its firstKeptEntryId is omitted;
 * kept entries start at firstKeptEntryId; the tail after the compaction
 * follows (session-manager.ts:476-512). The compaction itself contributes
 * only its summary message — older compaction rows inside the kept range
 * contribute nothing (session-manager.ts:558-565).
 */
export function buildSessionContext(entries: readonly PortEntry[]): SessionContext {
  let compactionIndex = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]?.type === "compaction") compactionIndex = i;
  }

  const messages: PortMessage[] = [];
  if (compactionIndex < 0) {
    for (const entry of entries) {
      if (entry.type === "message" && entry.message.role !== "system") messages.push(entry.message);
    }
    return { messages };
  }

  const compaction = entries[compactionIndex];
  if (compaction?.type !== "compaction") throw new Error("no compaction at resolved index");
  messages.push({ role: "user", text: compaction.summary });
  let foundFirstKept = false;
  for (let i = 0; i < compactionIndex; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept && entry.type === "message" && entry.message.role !== "system") {
      messages.push(entry.message);
    }
  }
  for (let i = compactionIndex + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message.role !== "system") messages.push(entry.message);
  }
  return { messages };
}

// ---------------------------------------------------------------------------
// Compaction preparation — pi compaction/compaction.ts:772-936
// (fileOps extraction and context_edit invalidation are NOT ported: fileOps
// depends on pi's host tool-name semantics (需改写), the invalidation walk on
// pi's context_edit entry type which our journal has no analogue for yet.)
// ---------------------------------------------------------------------------

export interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: PortMessage[];
  turnPrefixMessages: PortMessage[];
  isSplitTurn: boolean;
  previousSummary?: string;
}

/** One projected row: the source entry plus its context message, if visible. */
interface ProjectedEntry {
  source: PortEntry;
  message?: PortMessage;
}

/**
 * pi buildSessionProjection reduced to one linear walk: summary entry first,
 * kept-range messages, tail; system rows and out-of-range rows project to
 * nothing (session-manager.ts:543-573).
 */
function projectEntries(entries: readonly PortEntry[]): ProjectedEntry[] {
  let compactionIndex = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]?.type === "compaction") compactionIndex = i;
  }

  const projected: ProjectedEntry[] = [];
  if (compactionIndex < 0) {
    for (const entry of entries) {
      projected.push({
        source: entry,
        message:
          entry.type === "message" && entry.message.role !== "system" ? entry.message : undefined,
      });
    }
    return projected;
  }

  const compaction = entries[compactionIndex];
  if (compaction?.type !== "compaction") throw new Error("no compaction at resolved index");
  projected.push({ source: compaction, message: { role: "user", text: compaction.summary } });
  let foundFirstKept = false;
  for (let i = 0; i < compactionIndex; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    projected.push({
      source: entry,
      message:
        foundFirstKept && entry.type === "message" && entry.message.role !== "system"
          ? entry.message
          : undefined,
    });
  }
  for (let i = compactionIndex + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    projected.push({
      source: entry,
      message:
        entry.type === "message" && entry.message.role !== "system" ? entry.message : undefined,
    });
  }
  return projected;
}

function findProjectedCutPoint(
  entries: readonly ProjectedEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    if (
      entry?.source.type !== "compaction" &&
      entry?.message &&
      entry.message.role !== "toolResult" &&
      entry.message.role !== "system"
    ) {
      cutPoints.push(i);
    }
  }
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0] ?? startIndex;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const message = entries[i]?.message;
    if (message === undefined) continue;
    const messageTokens = estimateTokens(message);
    if (messageTokens === 0) continue;
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      cutIndex =
        cutPoints.find((candidate) => candidate >= i) ??
        cutPoints[cutPoints.length - 1] ??
        startIndex;
      break;
    }
  }

  while (cutIndex > startIndex) {
    const previous = entries[cutIndex - 1];
    if (
      previous === undefined ||
      previous.source.type === "compaction" ||
      previous.message !== undefined
    )
      break;
    cutIndex--;
  }

  const cutEntry = entries[cutIndex];
  const startsTurn =
    cutEntry !== undefined &&
    cutEntry.source.type !== "compaction" &&
    cutEntry.message !== undefined &&
    (cutEntry.message.role === "user" || cutEntry.message.role === "custom");
  let turnStartIndex = -1;
  if (!startsTurn) {
    for (let i = cutIndex; i >= startIndex; i--) {
      const entry = entries[i];
      if (
        entry !== undefined &&
        entry.source.type !== "compaction" &&
        entry.message !== undefined &&
        (entry.message.role === "user" || entry.message.role === "custom")
      ) {
        turnStartIndex = i;
        break;
      }
    }
  }
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  };
}

/**
 * Plan one compaction pass: undefined when there is nothing to summarize
 * (kept messages still fit) or the journal already ends on a compaction
 * (compaction.ts:872-936).
 */
export function prepareCompaction(
  pathEntries: readonly PortEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  const lastEntry = pathEntries[pathEntries.length - 1];
  if (lastEntry?.type === "compaction") {
    return undefined;
  }

  const projected = projectEntries(pathEntries);
  const prevCompactionIndex = projected.findIndex(
    (entry) => entry.source.type === "compaction" && entry.message !== undefined,
  );

  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (prevCompactionIndex >= 0) {
    const source = projected[prevCompactionIndex]?.source;
    if (source?.type !== "compaction") throw new Error("no compaction at resolved index");
    previousSummary = source.summary;
    boundaryStart = prevCompactionIndex + 1;
  }
  const cutPoint = findProjectedCutPoint(
    projected,
    boundaryStart,
    projected.length,
    settings.keepRecentTokens,
  );

  const firstKept = projected[cutPoint.firstKeptEntryIndex]?.source;
  if (firstKept === undefined) return undefined;
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

  const collectSummarized = projected
    .slice(boundaryStart, historyEnd)
    .flatMap((entry) => (entry.message === undefined ? [] : [entry.message]));
  const turnPrefixMessages = cutPoint.isSplitTurn
    ? projected
        .slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
        .flatMap((entry) => (entry.message === undefined ? [] : [entry.message]))
    : [];

  if (collectSummarized.length === 0 && turnPrefixMessages.length === 0) return undefined;

  return {
    firstKeptEntryId: firstKept.id,
    messagesToSummarize: collectSummarized,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    previousSummary,
  };
}

// ---------------------------------------------------------------------------
// Conversation serialization — pi compaction/utils.ts:89-155
// ---------------------------------------------------------------------------

/** pi TOOL_RESULT_MAX_CHARS (utils.ts:94). */
export const TOOL_RESULT_MAX_CHARS = 2000;

/** Keep the beginning; append an explicit truncation marker (utils.ts:100-104). */
export function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Summarization-side serialization: only tool results truncate; user and
 * assistant text ride whole (utils.ts:114-155).
 */
export function serializeConversation(messages: readonly PortMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      parts.push(`[User]: ${message.text}`);
    } else if (message.role === "assistant") {
      if (message.text) parts.push(`[Assistant]: ${message.text}`);
      if (message.toolCall) {
        parts.push(
          `[Assistant tool calls]: ${message.toolCall.name}(${message.toolCall.argsJson})`,
        );
      }
    } else if (message.role === "toolResult") {
      if (message.text)
        parts.push(`[Tool result]: ${truncateForSummary(message.text, TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  return parts.join("\n\n");
}
