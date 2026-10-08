import type { Passage } from "@oh-my-pi/pi-coding-agent/tools/jfind/passages";
import type { FileEntry, SearchRoot } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";

/**
 * find's execution phase (#523, user ruling 2026-10-08): the daemon host
 * runs every cascade phase that needs NO model — lexical scan, file
 * selection, reads, windows, sketches, survivor selection — and defers the
 * LLM leg (passage verification) to the edge. The host never resolves a
 * judge, never reads models.yml, never holds provider credentials: the
 * tool result is a structured candidate payload (agent-do find-protocol)
 * the edge judges through its own relay registry.
 *
 * Fidelity anchor: omp 18.6.0 packages/coding-agent/src/tools/jfind/
 * cascade.ts `run()` — this pipeline is that cascade with the judgment
 * waves removed and the degraded-judge fallbacks (name scores unknown →
 * lexical order; sketch scores unknown → all cards kept, top FULL_LIMIT by
 * passage lexical score) taken deterministically. Line-anchored below.
 *
 * omp imports stay DYNAMIC (tool-runtime.ts runtime discipline): the first
 * omp import in the process freezes the agent-dir resolver, so nothing may
 * load omp before createToolHost has pinned PI_CODING_AGENT_DIR. The
 * top-level `import type`s above are compile-time only and load nothing.
 */

// Cascade budgets (jfind cascade.ts:28-58, verbatim).
/** Lexically ranked files eligible before the read selection (cascade.ts:32). */
const CANDIDATES = 128;
/** Files whose content is read and sketched (cascade.ts:34). */
const FILES = 20;
/** Windows kept per read file (cascade.ts:36). */
const WINDOWS = 24;
/** Bytes per window, tags included (cascade.ts:38). */
const WINDOW_BYTES = 8192;
/** Bytes per sketch card (cascade.ts:40). */
const SKETCH_BYTES = 384;
/** Complete passages verified across all files (cascade.ts:42). */
const FULL_LIMIT = 40;
/** Bytes of a file read for windowing (cascade.ts:48). */
const READ_LIMIT = 4 * 1024 * 1024;
/** Verified-passage probability at or above which a file is a hit (cascade.ts:46). */
export const FIND_THRESHOLD = 0.2;
/** Wall-clock budget for the native lexical scan (cascade.ts:56). */
const SCAN_TIMEOUT_MS = 30_000;
/** Passages per verification batch — floor(VERIFY_STATE_BYTES / WINDOW_BYTES) (cascade.ts:54, :299). */
const PASSAGES_PER_BATCH = 3;

/** One verification batch the edge judges (agent-do find-protocol shape). */
interface VerifyBatch {
  rel: string;
  system: string;
  user: string;
  passages: { key: string; start: number; end: number; snippet: string; bytes: number }[];
}

/** omp tool-result bridge shape (tool-runtime OmpToolResult, structural). */
interface FindExecResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** The host seam the execution phase reads — no ToolHost surface beyond it. */
interface FindExecHost {
  /** Session cwd — hit paths are reported relative to it. */
  workspaceRoot: string;
  /** The host tool session (omp internal-urls context resolves through it). */
  session: Record<string, unknown>;
}

/** The structured host tool the registry wires as `find` (#523). */
export interface FindExecTool {
  name: "find";
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<FindExecResult>;
}

export function createFindExecTool(host: FindExecHost): FindExecTool {
  return {
    name: "find",
    async execute(_toolCallId, params, signal): Promise<FindExecResult> {
      if (typeof params !== "object" || params === null) {
        return {
          content: [{ type: "text", text: "`query` must be a non-empty description" }],
          isError: true,
        };
      }
      const rawQuery = "query" in params && typeof params.query === "string" ? params.query : "";
      const query = rawQuery.trim();
      if (query.length === 0) {
        return {
          content: [{ type: "text", text: "`query` must be a non-empty description" }],
          isError: true,
        };
      }
      const grepKeywords =
        "grep_keywords" in params && Array.isArray(params.grep_keywords)
          ? params.grep_keywords.filter((keyword): keyword is string => typeof keyword === "string")
          : [];
      const rawScopeInput = "path" in params && typeof params.path === "string" ? params.path : "";

      // omp imports — dynamic, after the agent-dir pin (module doc).
      const [
        { sessionResolveContext },
        { throwIfAborted },
        { InternalUrlFilesystem },
        { resolveSearchRoot, listFiles },
        { fileScore, grepIndex, idf },
        { keywords: deriveKeywords },
        { plainContent, selectWindows, sketch, windows },
        { lines, readText, ReadTextError, takeChars },
        { passageBatch, passageKey },
        { renderJudgmentPrompt },
      ] = await Promise.all([
        import("@oh-my-pi/pi-coding-agent/internal-urls/context"),
        import("@oh-my-pi/pi-coding-agent/tools/tool-errors"),
        import("@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem"),
        import("@oh-my-pi/pi-coding-agent/tools/jfind/tree"),
        import("@oh-my-pi/pi-coding-agent/tools/jfind/lexical"),
        import("@oh-my-pi/pi-coding-agent/tools/jfind/keywords"),
        import("@oh-my-pi/pi-coding-agent/tools/jfind/passages"),
        import("@oh-my-pi/pi-coding-agent/tools/jfind/text"),
        import("@oh-my-pi/pi-coding-agent/tools/jfind/questions"),
        import("@oh-my-pi/pi-ai"),
      ]);

      const started = Date.now();
      // Phase-boundary abort discipline (cascade.ts:165 throwIfAborted): a
      // cancelled caller surfaces as a thrown abort — never a "successful"
      // payload built after the cancel landed.
      throwIfAborted(signal);
      // The vendored bridge (tool-runtime.ts buildTools): the session object
      // IS the omp ToolSession view — omp's own tools receive the same value.
      const ompSession = host.session as never;
      const filesystem = new InternalUrlFilesystem({
        context: sessionResolveContext(ompSession, { signal }),
        tier: "read",
      });
      const root = await resolveSearchRoot(filesystem, rawScopeInput, host.workspaceRoot);
      throwIfAborted(signal);

      // Lexical prior (cascade.ts:174-192): one native walk + grep pass.
      const keywords = deriveKeywords(query, grepKeywords);
      const native = filesystem.shellFilesystem();
      const [entries, index] = await Promise.all([
        listFiles(root, { includeHidden: false, filesystem: native, signal }),
        grepIndex(root.path, keywords, {
          includeHidden: false,
          filesystem: native,
          signal,
          timeoutMs: SCAN_TIMEOUT_MS,
        }),
      ]);
      const weights = idf(index);
      const noCounts = Array.from({ length: keywords.length }, () => 0);
      const compareRel = (a: FileEntry, b: FileEntry): number =>
        a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
      const ranked = entries
        .map((entry, node) => ({
          node,
          lex: fileScore(index.perFileKw.get(entry.rel) ?? noCounts, weights, entry.rel, keywords),
        }))
        .sort((a, b) => {
          const aEntry = entries[a.node];
          const bEntry = entries[b.node];
          if (aEntry === undefined || bEntry === undefined) return 0;
          return b.lex - a.lex || compareRel(aEntry, bEntry);
        })
        .slice(0, CANDIDATES);

      // Read selection (cascade.ts:225-232) with every name score unknown:
      // the two strongest lexical candidates regardless, then lexical fill.
      const selected = ranked.slice(0, Math.min(FILES, 2)).map((candidate) => candidate.node);
      for (const candidate of ranked) {
        if (selected.length >= FILES) break;
        if (!selected.includes(candidate.node)) selected.push(candidate.node);
      }

      // Reads + windows (cascade.ts:233-249). Binary/blank files are
      // expected misses, not failures worth reporting (cascade.ts:244).
      const plans: {
        node: number;
        entry: FileEntry;
        total: number;
        truncated: boolean;
        passages: Passage[];
      }[] = [];
      throwIfAborted(signal);
      await Promise.all(
        selected.map(async (node) => {
          const entry = entries[node];
          if (entry === undefined) return;
          try {
            const read = await readText(filesystem, entry.path, READ_LIMIT);
            const passages = selectWindows(
              windows(read.text, WINDOW_BYTES, keywords, weights),
              WINDOWS,
            );
            if (passages.length === 0) return;
            plans.push({
              node,
              entry,
              total: lines(read.text).length,
              truncated: read.truncated,
              passages,
            });
          } catch (error) {
            if (!(error instanceof ReadTextError) || error.kind === "io") {
              // cascade.ts #fail("read <rel>") — an io miss stays silent in
              // the payload; the edge report's coverage reflects reads made.
            }
          }
        }),
      );
      plans.sort((a, b) => a.node - b.node);

      // Sketch cards (cascade.ts:252-266): one card per kept window. The
      // sketch routing judgment is deferred, so every card survives pruning
      // (cascade.ts:275 — an unknown score is never negative evidence).
      let sketchSentBytes = 0;
      const cards: { f: number; p: number }[] = [];
      plans.forEach((plan, f) => {
        plan.passages.forEach((passage, p) => {
          sketchSentBytes += Buffer.byteLength(sketch(passage, keywords, weights, SKETCH_BYTES));
          cards.push({ f, p });
        });
      });

      // Survivor selection (cascade.ts:278-285): with every routing score
      // equal, the ordering falls to the passage lexical score, then the
      // file's root-relative path, then the window's start offset.
      const survivors = cards
        .slice()
        .sort((a, b) => {
          const aPlan = plans[a.f];
          const bPlan = plans[b.f];
          const aPassage = aPlan?.passages[a.p];
          const bPassage = bPlan?.passages[b.p];
          if (aPlan === undefined || bPlan === undefined) return 0;
          if (aPassage === undefined || bPassage === undefined) return 0;
          return (
            bPassage.score - aPassage.score ||
            compareRel(aPlan.entry, bPlan.entry) ||
            aPassage.start - bPassage.start
          );
        })
        .slice(0, FULL_LIMIT);

      // Verification batches (cascade.ts:294-303): grouped per file, at
      // most PASSAGES_PER_BATCH passages per request, passages in file
      // order. Each request is rendered to its noul judgment prompt HERE —
      // the edge dials it verbatim and the two halves never share a model.
      const chosen = new Map<number, number[]>();
      for (const { f, p } of survivors) {
        const list = chosen.get(f);
        if (list === undefined) chosen.set(f, [p]);
        else list.push(p);
      }
      const batches: VerifyBatch[] = [];
      for (const f of [...chosen.keys()].sort((a, b) => a - b)) {
        const plan = plans[f];
        if (plan === undefined) continue;
        const indexes = (chosen.get(f) ?? []).slice().sort((a, b) => a - b);
        for (let start = 0; start < indexes.length; start += PASSAGES_PER_BATCH) {
          const group = indexes
            .slice(start, start + PASSAGES_PER_BATCH)
            .map((p) => plan.passages[p])
            .filter((passage): passage is Passage => passage !== undefined);
          if (group.length === 0) continue;
          const rendered = renderJudgmentPrompt(passageBatch(query, plan.entry.rel, group));
          batches.push({
            rel: plan.entry.rel,
            system: rendered.system,
            user: rendered.user,
            passages: group.map((passage, k) => {
              const text = plainContent(passage);
              return {
                key: passageKey(k),
                start: passage.start,
                end: passage.end,
                snippet: takeChars(lines(text).find((line) => line.trim().length > 0) ?? "", 100),
                bytes: Buffer.byteLength(text),
              };
            }),
          });
        }
      }

      const elapsedMs = Date.now() - started;
      const payload = buildPayload({
        root,
        query,
        keywords,
        entries,
        plans,
        batches,
        cardCount: cards.length,
        survivorCount: survivors.length,
        sketchSentBytes,
        elapsedMs,
        workspaceRoot: host.workspaceRoot,
      });
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  };
}

/** Assembles the wire payload (agent-do find-protocol v1). */
function buildPayload(inputs: {
  root: SearchRoot;
  query: string;
  keywords: string[];
  entries: FileEntry[];
  plans: { entry: FileEntry; total: number; truncated: boolean; passages: Passage[] }[];
  batches: VerifyBatch[];
  cardCount: number;
  survivorCount: number;
  sketchSentBytes: number;
  elapsedMs: number;
  workspaceRoot: string;
}): Record<string, unknown> {
  const { root, workspaceRoot } = inputs;
  const scopePath =
    root.path === workspaceRoot
      ? undefined
      : root.path.startsWith(workspaceRoot + "/")
        ? root.path.slice(workspaceRoot.length + 1) + (root.type === "directory" ? "/" : "")
        : root.path;
  return {
    v: 1,
    query: inputs.query,
    keywords: inputs.keywords,
    threshold: FIND_THRESHOLD,
    files: inputs.plans.map((plan) => ({
      rel: plan.entry.rel,
      totalLines: plan.total,
      truncated: plan.truncated,
    })),
    batches: inputs.batches,
    stats: {
      listed: inputs.entries.length,
      filesRead: inputs.plans.length,
      fileBytes: inputs.sketchSentBytes,
      mapCards: inputs.cardCount,
      windowsPruned: Math.max(0, inputs.cardCount - inputs.survivorCount),
      elapsedMs: inputs.elapsedMs,
    },
    cwd: workspaceRoot,
    ...(scopePath !== undefined ? { scopePath } : {}),
  };
}
