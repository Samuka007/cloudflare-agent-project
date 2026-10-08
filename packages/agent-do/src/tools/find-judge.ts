import {
  findExecPayloadSchema,
  mergeFindHeat,
  parseFindNoulReply,
  rankedFindHeat,
  splitFindAnswerLines,
  type FindExecPayload,
  type FindHeatRange,
} from "./find-protocol.js";
import type { RelayModelCost } from "../provider-catalog.js";
import type { TextCompletionRequest, TextCompletionResult } from "../provider.js";

/**
 * find's judge leg (#523, user ruling 2026-10-08): the edge half of the
 * composite `find`. The daemon host runs the judge-less cascade and returns
 * the verification candidates (find-protocol v1); THIS executor dials each
 * pre-rendered noul prompt through the relay provider resolved from the
 * thread's pinned selection (D1 provider_configs 正本链 — the same
 * resolution the turn's own model dispatches ride), folds the answers into
 * heat ranges, and renders the omp find report verbatim. The model still
 * sees ONE find tool: schema, description, and wire row are untouched.
 *
 * Zero host registry, zero host credentials — and zero omp imports here:
 * the reply protocol is the two pure functions the find-protocol module
 * ports (splitAnswerLines + parseNoulReply semantics).
 */

/** Line ranges shown per hit in the report, strongest first (jfind index.ts:35). */
const RANGES_SHOWN = 3;
/** Reply budget per judged batch — one-word-per-question lines (pi-ai
 * LOCAL_REASONING_MAX_TOKENS anchor; reasoning models need headroom). */
const JUDGE_MAX_TOKENS = 1024;
/** Requests in flight per judge wave (jfind cascade.ts:28 PARALLEL). */
const PARALLEL = 16;

export interface FindJudgeContext {
  /** The synchronous host leg: one service-DO findExec RPC, result payload. */
  execHost: () => Promise<{ status: string; output: string }>;
  /** The relay judge call (provider.completeText over the resolved model). */
  judge: (request: TextCompletionRequest) => Promise<TextCompletionResult>;
  /** The resolved row's declared per-token cost; absent = unpriced footer. */
  cost?: RelayModelCost;
}

/** The composite result — the DO folds it into the tool.result row. */
export interface FindJudgedResult {
  status: "ok" | "error" | "cancelled";
  output: string;
}

/** Report footer number formats (pi-utils formatBytes/formatNumber ports —
 * the edge cannot import omp utilities; the shapes match the host renderer). */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const body = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${body} ${units[unit]}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

/** Hit-accounting accumulator per file (omp cascade wave-3 fold shape). */
interface FileEntry {
  score: number;
  heat: FindHeatRange[];
  lines: number;
  bytes: number;
}

export async function runFindJudged(
  args: { query?: unknown; grep_keywords?: unknown; path?: unknown },
  ctx: FindJudgeContext,
): Promise<FindJudgedResult> {
  const rawQuery = typeof args.query === "string" ? args.query : "";
  const query = rawQuery.trim();
  if (query.length === 0) {
    return { status: "error", output: "`query` must be a non-empty description" };
  }

  // -- Execution leg: the host's judge-less cascade --------------------------
  let payload: FindExecPayload;
  try {
    const leg = await ctx.execHost();
    if (leg.status !== "ok") {
      if (leg.status === "cancelled") return { status: "cancelled", output: leg.output };
      // Structured error: the execution phase never ran to a payload — the
      // not-executed contract (host_offline / timeout / host refusal).
      return { status: "error", output: leg.output };
    }
    const parsed = findExecPayloadSchema.safeParse(JSON.parse(leg.output));
    if (!parsed.success) {
      return {
        status: "error",
        output: `find execution leg returned an unreadable candidate payload: ${parsed.error.issues[0]?.message ?? "shape mismatch"}`,
      };
    }
    payload = parsed.data;
  } catch (error) {
    return {
      status: "error",
      output: `find execution leg failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // -- Judgment leg: verify every batch through the relay --------------------
  // Hit display paths: the host reports search-root-relative rels; with a
  // scope narrower than cwd the scope prefix (trailing slash for
  // directories) rebuilds the cwd-relative display path omp renders.
  const displayPath = (rel: string): string => {
    const scope = payload.scopePath;
    if (scope === undefined) return rel;
    return scope.endsWith("/") ? `${scope}${rel}` : rel;
  };

  const started = Date.now();
  const judged = new Map<string, Map<string, number | undefined>>();
  const failures: string[] = [];
  let requests = 0;
  let errors = 0;
  let judgedPassages = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  /** Receipted (non-estimated) usage count — the footer prices only real
   * receipts; a single estimated batch prices the whole report $0.0000. */
  let receiptedBatches = 0;

  const judgeBatch = async (
    batchIndex: number,
    batch: FindExecPayload["batches"][number],
  ): Promise<void> => {
    requests += 1;
    try {
      const result = await ctx.judge({
        system: batch.system,
        user: batch.user,
        maxTokens: JUDGE_MAX_TOKENS,
      });
      if (result.usage !== null && !result.usage.estimated) receiptedBatches += 1;
      if (result.usage !== null) {
        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
        cacheReadTokens += result.usage.cacheReadInputTokens;
        cacheWriteTokens += result.usage.cacheCreationInputTokens;
      }
      const answers = splitFindAnswerLines(
        result.text,
        batch.passages.map((passage) => passage.key),
      );
      const perBatch = new Map<string, number | undefined>();
      for (const passage of batch.passages) {
        const reply = answers.get(passage.key);
        const verdict = reply === undefined ? undefined : parseFindNoulReply(reply);
        if (verdict === undefined) {
          errors += 1;
          perBatch.set(passage.key, undefined);
          continue;
        }
        judgedPassages += 1;
        perBatch.set(passage.key, verdict ? 1 : 0);
      }
      judged.set(`#${batchIndex}`, perBatch);
    } catch (error) {
      errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (failures.length < 5 && !failures.includes(`verification: ${message}`)) {
        failures.push(`verification: ${message}`);
      }
    }
  };

  // Waves of PARALLEL; the whole leg rides the execution's deadline signal.
  for (let start = 0; start < payload.batches.length; start += PARALLEL) {
    await Promise.all(
      payload.batches
        .slice(start, start + PARALLEL)
        .map((batch, offset) => judgeBatch(start + offset, batch)),
    );
  }
  const apiMs = Date.now() - started;

  // -- Fold: answers → hits (omp cascade.ts:305-354) -------------------------
  const filesByRel = new Map(payload.files.map((file) => [file.rel, file]));
  const perFile = new Map<string, FileEntry>();
  for (const [batchIndex, batch] of payload.batches.entries()) {
    const answers = judged.get(`#${batchIndex}`);
    if (answers === undefined) continue;
    let entry = perFile.get(batch.rel);
    if (entry === undefined) {
      entry = { score: 0, heat: [], lines: 0, bytes: 0 };
      perFile.set(batch.rel, entry);
    }
    for (const passage of batch.passages) {
      const p = answers.get(passage.key);
      if (p === undefined) continue;
      entry.score = Math.max(entry.score, p);
      entry.heat.push({ start: passage.start, end: passage.end, p, snippet: passage.snippet });
      entry.lines += passage.end - passage.start + 1;
      entry.bytes += passage.bytes;
    }
  }

  const threshold = payload.threshold;
  const hits: {
    rel: string;
    contentScore: number;
    ranges: FindHeatRange[];
    linesSeen: number;
    truncated: boolean;
  }[] = [];
  let verifiedBytes = 0;
  for (const [rel, entry] of perFile) {
    verifiedBytes += entry.bytes;
    if (entry.score < threshold) continue;
    const file = filesByRel.get(rel);
    hits.push({
      rel: displayPath(rel),
      contentScore: entry.score,
      ranges: mergeFindHeat(entry.heat, threshold),
      linesSeen: entry.lines,
      truncated: (file?.truncated ?? false) || entry.lines < (file?.totalLines ?? 0),
    });
  }
  hits.sort((a, b) => b.contentScore - a.contentScore);

  // -- Render: the omp find report, verbatim shape ---------------------------
  const totalBytes = payload.stats.fileBytes + verifiedBytes;
  const costValue =
    receiptedBatches === 0
      ? 0
      : (inputTokens / 1e6) * (ctx.cost?.input ?? 0) +
        (outputTokens / 1e6) * (ctx.cost?.output ?? 0) +
        (cacheReadTokens / 1e6) * (ctx.cost?.cacheRead ?? 0) +
        (cacheWriteTokens / 1e6) * (ctx.cost?.cacheWrite ?? 0);
  const elapsedMs = payload.stats.elapsedMs + apiMs;
  const where = payload.scopePath === undefined ? "" : ` in ${payload.scopePath}`;
  const out: string[] = [];
  if (hits.length === 0) {
    out.push(`no hits for "${query}"${where} (τ ${threshold.toFixed(2)})`);
  } else {
    out.push(
      `${hits.length} hit(s) for "${query}"${where} (τ ${threshold.toFixed(2)}), strongest first`,
      "",
    );
    for (const hit of hits) {
      const coverage = hit.truncated
        ? `${hit.linesSeen} lines judged, partial`
        : `${hit.linesSeen} lines judged`;
      out.push(`${hit.rel}  ${hit.contentScore.toFixed(2)}  ${coverage}`);
      for (const range of rankedFindHeat(hit.ranges, RANGES_SHOWN)) {
        const span =
          range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
        out.push(`  ${hit.rel}:${span}  ${range.p.toFixed(2)}  ${range.snippet}`);
      }
    }
  }
  out.push(
    "",
    `listed ${payload.stats.listed} · judged ${judgedPassages} · read ${payload.stats.filesRead} files (${formatBytes(totalBytes)}) · ${requests} requests · ${formatNumber(inputTokens + outputTokens)} tokens · $${costValue.toFixed(4)} · ${formatDuration(elapsedMs)} wall / ${formatDuration(apiMs)} api`,
  );
  if (failures.length > 0) {
    out.push(`${errors} of ${requests} requests failed:`, ...failures.map((f) => `  ${f}`));
  }
  const allFailed = requests > 0 && errors === requests;
  return {
    status: allFailed ? "error" : "ok",
    output: out.join("\n"),
  };
}
