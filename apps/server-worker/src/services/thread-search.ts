import type { ThreadListRow } from "../db/control-plane.js";
import type { ThreadSearchHighlightRange, ThreadSearchMatch } from "../contract/api/threads.js";

/**
 * Title-level thread search, the M0 face of bb GET /threads/search (apps/
 * server/src/routes/threads/base.ts:257-275). bb persists searchable segments
 * in an FTS table (packages/db/src/data/threads.ts:201-246, migration
 * 0039_thread_search) covering titles and message bodies; the M0 port scans
 * the threads table in memory and serves the two title segments per thread —
 * `title` and `title_fallback` (the same two segment kinds bb seeds at
 * 0039_thread_search.sql:40-67). Message-body segments stay out until the
 * M2 corpus migration. Tokenization, normalization, ordering keys, group
 * split, and the match/highlight shapes are bb's, cited inline.
 */

/** bb packages/db/src/data/threads.ts:51-56. */
export const THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT = 20;
export const THREAD_SEARCH_LIMIT_PER_GROUP_MAX = 50;
const THREAD_SEARCH_MATCHES_PER_THREAD = 3;
const THREAD_SEARCH_QUERY_TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;
const THREAD_SEARCH_HIGHLIGHT_RANGE_LIMIT = 8;

type SearchSegmentSourceKind = "title" | "title_fallback";

export type ThreadSearchCandidateRow = ThreadListRow;

/** Matched row plus its bb segment matches; the route maps rows to entries. */
interface ThreadSearchGroup {
  total: number;
  results: { thread: ThreadSearchCandidateRow; matches: ThreadSearchMatch[] }[];
}

/** Pre-mapping draft of the bb ThreadSearchResponse wire shape. */
interface ThreadSearchResponseDraft {
  active: ThreadSearchGroup;
  archived: ThreadSearchGroup;
}

/** bb listThreadSearchQueryTokens (data/threads.ts:795-804). */
function listThreadSearchQueryTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const match of query.matchAll(THREAD_SEARCH_QUERY_TOKEN_PATTERN)) {
    const token = match[0].trim();
    if (token.length > 0) {
      tokens.push(token);
    }
  }
  return tokens;
}

/** bb normalizeThreadSearchText (data/threads.ts:875-880). */
function normalizeThreadSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase();
}

/** bb normalizeThreadSearchHighlightText (data/threads.ts:882-916). */
function normalizeThreadSearchHighlightText(text: string): {
  originalEnds: number[];
  originalStarts: number[];
  text: string;
} {
  let normalizedText = "";
  const originalStarts: number[] = [];
  const originalEnds: number[] = [];

  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const value = String.fromCodePoint(codePoint);
    const end = index + value.length;
    const normalizedValue = normalizeThreadSearchText(value);
    for (const normalizedChar of normalizedValue) {
      normalizedText += normalizedChar;
      originalStarts.push(index);
      originalEnds.push(end);
    }
    index = end;
  }

  return {
    originalEnds,
    originalStarts,
    text: normalizedText,
  };
}

/** bb mergeHighlightRanges (data/threads.ts:825-838). */
function mergeHighlightRanges(
  ranges: readonly ThreadSearchHighlightRange[],
): ThreadSearchHighlightRange[] {
  const merged: ThreadSearchHighlightRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged.slice(0, THREAD_SEARCH_HIGHLIGHT_RANGE_LIMIT);
}

/** bb findHighlightRanges (data/threads.ts:840-873). */
function findHighlightRanges(args: {
  text: string;
  tokens: readonly string[];
}): ThreadSearchHighlightRange[] {
  const ranges: ThreadSearchHighlightRange[] = [];
  const normalizedText = normalizeThreadSearchHighlightText(args.text);
  const uniqueTokens = [
    ...new Set(
      args.tokens
        .map((token) => normalizeThreadSearchText(token))
        .filter((token) => token.length > 0),
    ),
  ];

  for (const token of uniqueTokens) {
    let offset = 0;
    while (offset < normalizedText.text.length) {
      const start = normalizedText.text.indexOf(token, offset);
      if (start === -1) {
        break;
      }
      const end = start + token.length;
      ranges.push({
        start: normalizedText.originalStarts[start] ?? 0,
        end: normalizedText.originalEnds[end - 1] ?? args.text.length,
      });
      offset = start + token.length;
    }
  }

  return mergeHighlightRanges(
    ranges.sort((left, right) => left.start - right.start || left.end - right.end),
  );
}

/**
 * bb matches a token with the FTS prefix query `"token"*` (data/threads.ts:
 * 806-808): the token must prefix a word of the segment. The in-memory
 * equivalent tokenizes the segment with the same pattern and compares
 * normalized prefixes.
 */
function segmentMatchesToken(segmentWords: readonly string[], token: string): boolean {
  const normalizedToken = normalizeThreadSearchText(token);
  if (normalizedToken.length === 0) {
    return false;
  }
  return segmentWords.some((word) => word.startsWith(normalizedToken));
}

function segmentWords(text: string): string[] {
  return [...text.matchAll(THREAD_SEARCH_QUERY_TOKEN_PATTERN)].map((match) =>
    normalizeThreadSearchText(match[0]),
  );
}

interface ThreadTitleMatch {
  matches: ThreadSearchMatch[];
  row: ThreadSearchCandidateRow;
}

/**
 * bb hydrateThreadSearchGroup + searchThreadsWithPendingInteractionState
 * (data/threads.ts:1044-1133): every query token must match somewhere in the
 * thread's segments (HAVING COUNT(DISTINCT tokenIndex) = token count,
 * threads.ts:953); up to THREAD_SEARCH_MATCHES_PER_THREAD matched segments
 * are reported per thread; `total` counts all matching threads before the
 * per-group limit.
 */
export function buildTitleSearchResponse(args: {
  rows: readonly ThreadSearchCandidateRow[];
  query: string;
  limitPerGroup: number;
}): ThreadSearchResponseDraft {
  const tokens = [...new Set(listThreadSearchQueryTokens(args.query))];
  if (tokens.length === 0) {
    return {
      active: { total: 0, results: [] },
      archived: { total: 0, results: [] },
    };
  }

  const matched: ThreadTitleMatch[] = [];
  for (const row of args.rows) {
    const segments: { sourceKind: SearchSegmentSourceKind; text: string }[] = [];
    if (row.title !== null && row.title.trim().length > 0) {
      segments.push({ sourceKind: "title", text: row.title });
    }
    if (row.titleFallback !== null && row.titleFallback.trim().length > 0) {
      segments.push({ sourceKind: "title_fallback", text: row.titleFallback });
    }

    // bb counts a thread as matching when every token hits any of its
    // segments (data/threads.ts:938-964); a segment is reported as a match
    // when at least one token hit it (the FTS any-token match row set,
    // threads.ts:1014-1017).
    const remaining = new Set(tokens);
    const matches: ThreadSearchMatch[] = [];
    for (const segment of segments) {
      if (remaining.size === 0) {
        break;
      }
      const words = segmentWords(segment.text);
      const hit = tokens.some((token) => segmentMatchesToken(words, token));
      if (!hit) {
        continue;
      }
      for (const token of tokens) {
        if (remaining.has(token) && segmentMatchesToken(words, token)) {
          remaining.delete(token);
        }
      }
      if (matches.length < THREAD_SEARCH_MATCHES_PER_THREAD) {
        matches.push({
          sourceKind: segment.sourceKind,
          text: segment.text,
          highlightRanges: findHighlightRanges({ text: segment.text, tokens }),
          sourceSeq: null,
        });
      }
    }
    if (remaining.size === 0 && matches.length > 0) {
      matched.push({ matches, row });
    }
  }

  // bb ranks by FTS best rank then updated_at DESC, id DESC (data/threads.ts:
  // 956-962). Without an FTS rank the port keeps the deterministic tail of
  // that ordering.
  matched.sort(
    (left, right) =>
      right.row.updatedAt - left.row.updatedAt || right.row.id.localeCompare(left.row.id),
  );

  const toGroup = (archived: boolean): ThreadSearchGroup => {
    const groupRows = matched.filter(({ row }) => (row.archivedAt !== null) === archived);
    return {
      total: groupRows.length,
      results: groupRows.slice(0, args.limitPerGroup).map(({ row, matches }) => ({
        thread: row,
        matches,
      })),
    };
  };

  return {
    active: toGroup(false),
    archived: toGroup(true),
  };
}

/** bb countNonWhitespaceChars (routes/threads/base.ts:123-125). */
export function countNonWhitespaceChars(value: string): number {
  return value.replaceAll(/\s/gu, "").length;
}
