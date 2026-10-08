import { z } from "zod";

/**
 * The find judge-wire protocol (#523, user ruling 2026-10-08): the daemon
 * host executes find's cascade phases that need NO model (lexical scan, file
 * selection, reads, windows, sketches, survivor selection) and defers the
 * LLM leg — the verification judgments — to the edge. The host's execution
 * result carries this payload; the edge dials each pre-rendered prompt
 * through the relay provider resolved from the thread's pinned selection
 * (D1 provider_configs 正本链), then renders the judged report.
 *
 * Subpath module (agent-do package export "./find-protocol"): the daemon
 * client imports the TYPES from here without the agent-do barrel (the barrel
 * transitively loads cloudflare:workers — Node poison on the host side; the
 * Node-facing import discipline is subpath modules, never the barrel). Zero
 * runtime dependencies beyond zod.
 *
 * Fidelity anchor: omp 18.6.0 packages/coding-agent/src/tools/jfind/
 * cascade.ts — the survivor selection and batching rules below are that
 * file's degraded-judge path (every judgment "unknown"), verbatim.
 */

/** Passage question key of the k-th passage in a batch (jfind questions.ts:58). */
export function findPassageKey(index: number): string {
  return `p${String(index).padStart(2, "0")}`;
}

/** One judged passage candidate: line coordinates + preview, host-computed. */
export const findPassageCandidateSchema = z.object({
  /** Question id within the batch (findPassageKey order). */
  key: z.string().min(1),
  /** 1-based inclusive line range of the passage. */
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  /** First non-blank passage line, ≤100 chars (omp cascade.ts:328 snippet rule). */
  snippet: z.string(),
  /** UTF-8 bytes of the passage text — the footer's fileBytes accounting. */
  bytes: z.number().int().nonnegative(),
});
export type FindPassageCandidate = z.infer<typeof findPassageCandidateSchema>;

/**
 * One verification batch: the noul judgment prompt the HOST rendered
 * (pi-ai renderJudgmentPrompt over omp's passageBatch request) plus the
 * passage metadata the edge needs to fold answers into heat ranges. The
 * edge dials `system`/`user` verbatim through the relay — it never sees
 * omp internals, and the host never sees the model.
 */
export const findVerifyBatchSchema = z.object({
  /** File the passages belong to (root-relative at the search root). */
  rel: z.string().min(1),
  system: z.string(),
  user: z.string(),
  passages: z.array(findPassageCandidateSchema).min(1),
});
export type FindVerifyBatch = z.infer<typeof findVerifyBatchSchema>;

/** Per-file accounting the report's `truncated` flag folds from. */
export const findExecFileSchema = z.object({
  rel: z.string().min(1),
  totalLines: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type FindExecFile = z.infer<typeof findExecFileSchema>;

/** Execution-phase accounting (host side; the edge appends its judge leg). */
export const findExecStatsSchema = z.object({
  listed: z.number().int().nonnegative(),
  filesRead: z.number().int().nonnegative(),
  fileBytes: z.number().int().nonnegative(),
  mapCards: z.number().int().nonnegative(),
  windowsPruned: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export type FindExecStats = z.infer<typeof findExecStatsSchema>;

/** The find execution-phase payload — the host's `find` tool result output. */
export const findExecPayloadSchema = z.object({
  v: z.literal(1),
  query: z.string(),
  keywords: z.array(z.string()),
  /** Verified-passage hit threshold (omp cascade THRESHOLD, 0.2). */
  threshold: z.number(),
  files: z.array(findExecFileSchema),
  batches: z.array(findVerifyBatchSchema),
  stats: findExecStatsSchema,
  /** Session cwd — hit paths are reported relative to it. */
  cwd: z.string(),
  /** Display form of the searched scope when narrower than cwd. */
  scopePath: z.string().optional(),
});
export type FindExecPayload = z.infer<typeof findExecPayloadSchema>;

// ---------------------------------------------------------------------------
// Answer parsing — omp judgment/text.ts semantics, ported verbatim (the edge
// never imports pi-ai; these two functions ARE the whole reply contract).
// ---------------------------------------------------------------------------

const WORD = /[\p{L}\p{N}_]/u;

/** Index of the earliest whole-word, case-insensitive occurrence (omp text.ts:146). */
function indexOfWord(text: string, needle: string): number {
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const first = target[0];
  const last = target[target.length - 1];
  if (first === undefined || last === undefined) return -1;
  let from = 0;
  while (from <= lower.length - target.length) {
    const at = lower.indexOf(target, from);
    if (at < 0) return -1;
    const before = at > 0 ? (lower[at - 1] ?? "") : "";
    const after = lower[at + target.length] ?? "";
    const boundedBefore = before === "" || !WORD.test(before) || !WORD.test(first);
    const boundedAfter = after === "" || !WORD.test(after) || !WORD.test(last);
    if (boundedBefore && boundedAfter) return at;
    from = at + 1;
  }
  return -1;
}

/** `true` when a yes-word precedes any no-word, `false` for the reverse (omp text.ts:182). */
export function parseFindNoulReply(text: string): boolean | undefined {
  const yes = [indexOfWord(text, "yes"), indexOfWord(text, "true")].filter((at) => at >= 0);
  const no = [indexOfWord(text, "no"), indexOfWord(text, "false")].filter((at) => at >= 0);
  const yesAt = yes.length > 0 ? Math.min(...yes) : -1;
  const noAt = no.length > 0 ? Math.min(...no) : -1;
  if (yesAt < 0 && noAt < 0) return undefined;
  if (noAt < 0) return true;
  if (yesAt < 0) return false;
  return yesAt < noAt;
}

/**
 * Split a multi-question reply into `id → answer text`: `<id>: <answer>`
 * lines (also `=` / `-` separators and quoted ids); unknown ids ignored so
 * a chatty preamble cannot poison parsing (omp text.ts:210).
 */
export function splitFindAnswerLines(text: string, ids: readonly string[]): Map<string, string> {
  const byId = new Map<string, string>();
  const wanted = new Set(ids);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^[\s\-*•]+/, "").trim();
    const separator = line.search(/\s*[:=]\s*|\s+-\s+/);
    if (separator <= 0) continue;
    const id = line.slice(0, separator).replace(/^[`"']|[`"']$/g, "");
    if (!wanted.has(id) || byId.has(id)) continue;
    byId.set(id, line.slice(separator).replace(/^\s*[:=-]\s*/, ""));
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Heat folding — omp jfind/passages.ts mergeHeat/rankedHeat verbatim (the
// edge folds answers into the report; the host never judges).
// ---------------------------------------------------------------------------

/** A judged line range with its yes-probability and a one-line preview. */
export interface FindHeatRange {
  start: number;
  end: number;
  p: number;
  snippet: string;
}

/**
 * Union the judged-positive spans; never bridge an unjudged gap. A merged
 * span keeps the max probability (omp passages.ts:145).
 */
export function mergeFindHeat(heat: readonly FindHeatRange[], threshold: number): FindHeatRange[] {
  const kept = heat
    .filter((range) => range.p >= threshold && range.p > 0 && range.start <= range.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: FindHeatRange[] = [];
  for (const range of kept) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      if (range.p > last.p) last.p = range.p;
      continue;
    }
    merged.push({ ...range });
  }
  return merged.sort((a, b) => b.p - a.p || a.start - b.start);
}

/** The most relevant ranges, strongest first, then earliest (omp passages.ts:163). */
export function rankedFindHeat(heat: readonly FindHeatRange[], limit: number): FindHeatRange[] {
  return heat
    .filter((range) => range.p > 0)
    .sort((a, b) => b.p - a.p || a.start - b.start)
    .slice(0, limit);
}
