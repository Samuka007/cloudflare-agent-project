import { z } from "zod";
import type { EdgeToolResult } from "./edge.js";

/**
 * DO-local `web_search` executor (M1.5 T12 #102) — the edge port of omp
 * packages/coding-agent/src/web/search (anchor d4d49e71, @oh-my-pi 18.6.0).
 *
 * Edge class (classification table §2.2/§6.1): the provider surface is pure
 * outbound `fetch` executed inside this DO — zero daemon touches, zero DO
 * state beyond the tool.result journal row (practice 11). The red line:
 * omp's google/ecosia/mojeek adapters escalate failed plain fetches to a
 * host-shared headless Chromium (`acquireBrowser`); a DO-local engine set
 * that included them would silently make the edge class hybrid. The
 * exclusion therefore lives AT THE CONFIG LAYER (`decodeWebSearchConfig`
 * rejects any chain naming them with a structured policy error — L1:
 * disabled engines are refused, never silently dropped), and this module's
 * transports are plain fetch only: challenge/bot walls surface as
 * `SearchEngineError` failures that advance the chain (omp docs/tools/
 * web_search.md §Side Effects — the no-escalation mode omp itself supports
 * for injected test fetches). The browser upgrade sub-path is M3 daemon
 * browser, not this ticket.
 *
 * Port fidelity:
 * - Schema and description are omp verbatim (registry.ts row).
 * - Transport shapes (URLs, headers, form fields, recency maps, clamps,
 *   error texts, the Public Web deadline race and consensus merge) are
 *   ported from the omp adapters with inline anchors.
 * - Deliberate reduction: the raw query string passes through verbatim.
 *   omp re-formats parsed Google-style directives per engine; the engines
 *   carried here parse the operator set inline (brave/startpage) or accept
 *   the raw query (ddg/searxng) — docs/tools/web_search.md §Inputs ("the
 *   original string remains available to adapters"). `max_tokens` /
 *   `temperature` stay in the schema (omp verbatim) and are ignored — only
 *   model-backed adapters consume them (§Inputs).
 * - Timeout discipline (retry-matrix §2.1 web_search row): per-transport
 *   60s default / 300s cap (NOT a whole-chain deadline); Public Web fans
 *   out with the 5s soft / 30s hard straggler cutoff; provider failures
 *   return `Error: …` text so the chain advances (omp does not throw at
 *   the tool boundary); a cancelled owning call rethrows as `cancelled`.
 */

// ---------------------------------------------------------------------------
// Engine policy — the config-layer exclusion (classification §6.1 red line)
// ---------------------------------------------------------------------------

/** omp scrape engines whose failure path can acquire the host Chromium. */
export const BROWSER_BACKED_ENGINES = ["google", "ecosia", "mojeek"] as const;

export type BrowserBackedEngineId = (typeof BROWSER_BACKED_ENGINES)[number];

const BROWSER_BACKED_ENGINE_TABLE: Record<BrowserBackedEngineId, true> = {
  google: true,
  ecosia: true,
  mojeek: true,
};

/**
 * Engines carried by the DO-local provider surface — pure HTTPS, no
 * browser escalation (omp docs/tools/web_search.md §Side Effects).
 */
export type SearchEngineId = "brave" | "duckduckgo" | "searxng" | "startpage" | "public";

const SEARCH_ENGINE_ID_TABLE: Record<SearchEngineId, true> = {
  brave: true,
  duckduckgo: true,
  searxng: true,
  startpage: true,
  public: true,
};

const SEARCH_ENGINE_IDS: readonly SearchEngineId[] = Object.keys(
  SEARCH_ENGINE_ID_TABLE,
) as SearchEngineId[];

/** Structured policy error: the excluded engine is named with the policy. */
export function browserBackedEnginePolicyError(id: string): Error {
  return new Error(
    `web_search edge policy: engine "${id}" is browser-backed (classification table §2.2/§6.1 — its anti-bot escalation can acquire a host Chromium) and is excluded from the DO-local provider set. Allowed engines: ${SEARCH_ENGINE_IDS.join(", ")}.`,
  );
}

// ---------------------------------------------------------------------------
// Config — settings/env per the config.ts patch-over-defaults pattern
// ---------------------------------------------------------------------------

/** omp web/search/types.ts:12 — per-transport default (seconds). */
export const DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS = 60;

/** omp web/search/types.ts:15 — per-transport configurable cap (seconds). */
export const MAX_WEB_SEARCH_TIMEOUT_SECONDS = 300;

export interface BraveEngineSettings {
  /** Brave Search API subscription key (omp: BRAVE_API_KEY). */
  apiKey?: string;
}

export interface SearxngEngineSettings {
  /** Instance base URL, e.g. `https://searx.example.com` (omp: SEARXNG_ENDPOINT). */
  endpoint?: string;
  /** Bearer token; Basic auth wins when both are set (omp auth precedence). */
  token?: string;
  basicUsername?: string;
  basicPassword?: string;
  categories?: string;
  language?: string;
  /** 0 off / 1 moderate / 2 strict (omp validates this exact set). */
  safesearch?: 0 | 1 | 2;
}

export interface WebSearchEngineSettings {
  brave?: BraveEngineSettings;
  searxng?: SearxngEngineSettings;
}

export interface WebSearchConfig {
  /**
   * Ordered provider chain — the edge replacement for omp's `web` role
   * chain. Default: keyed API first, credential-free aggregate as
   * fallback. Deployment-time input; the model cannot reach it (the wire
   * schema is omp verbatim and has no engine field).
   */
  chain: SearchEngineId[];
  /** Per-transport ceiling in seconds (clamped 1..300 at decode). */
  timeoutSeconds: number;
  engines: WebSearchEngineSettings;
}

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
  chain: ["brave", "public"],
  timeoutSeconds: DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
  engines: {},
};

const engineSettingsPatchSchema = z.object({
  brave: z
    .object({
      apiKey: z.string().min(1).optional(),
    })
    .optional(),
  searxng: z
    .object({
      endpoint: z.url().optional(),
      token: z.string().min(1).optional(),
      basicUsername: z.string().min(1).optional(),
      basicPassword: z.string().min(1).optional(),
      categories: z.string().min(1).optional(),
      language: z.string().min(1).optional(),
      safesearch: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    })
    .optional(),
});

const webSearchConfigPatchSchema = z.object({
  chain: z.array(z.string()).min(1).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  engines: engineSettingsPatchSchema.optional(),
});

/**
 * Decode the `AGENT_DO_WEB_SEARCH` env JSON patch over `base`. Shape
 * violations throw (zod); a chain naming a browser-backed engine throws
 * the structured policy error — rejection, not silent fallback (L1).
 */
export function decodeWebSearchConfig(
  raw: string | undefined,
  base: WebSearchConfig = DEFAULT_WEB_SEARCH_CONFIG,
): WebSearchConfig {
  if (raw === undefined || raw === "") return base;
  const patch = webSearchConfigPatchSchema.parse(JSON.parse(raw));
  for (const id of patch.chain ?? []) {
    if (id in BROWSER_BACKED_ENGINE_TABLE) {
      throw browserBackedEnginePolicyError(id);
    }
    if (!(id in SEARCH_ENGINE_ID_TABLE)) {
      throw new Error(
        `web_search config: unknown engine "${id}". Allowed engines: ${SEARCH_ENGINE_IDS.join(", ")}.`,
      );
    }
  }
  const timeoutSeconds =
    patch.timeoutSeconds === undefined
      ? base.timeoutSeconds
      : Math.min(MAX_WEB_SEARCH_TIMEOUT_SECONDS, Math.max(1, patch.timeoutSeconds));
  return {
    // Every entry was validated against the engine table above; the erased
    // JSON boundary is the only reason the cast is needed.
    chain: (patch.chain ?? base.chain) as SearchEngineId[],
    timeoutSeconds,
    engines: {
      brave: patch.engines?.brave ?? base.engines.brave,
      searxng: patch.engines?.searxng ?? base.engines.searxng,
    },
  };
}

// ---------------------------------------------------------------------------
// Read-only projection (#266, #255 solution C) — facts, never secret values
// ---------------------------------------------------------------------------

/** One chain entry's credential gate. Carries ids and booleans only. */
export interface WebSearchEngineProjection {
  engine: SearchEngineId;
  /** True when the engine needs configured credentials to serve requests. */
  credentialsRequired: boolean;
  /** True when the gate passes (nothing required, or the secret fields are set). */
  credentialsPresent: boolean;
}

/**
 * Secret-free web_search projection for `GET /system/provider-projections`
 * (#266): the chain in order with per-engine credential gates, the transport
 * ceiling, and the browser-backed exclusion list. Mirrors `projectHarness`'s
 * discipline — only key PRESENCE survives, never a key VALUE.
 */
export interface WebSearchProjection {
  chain: WebSearchEngineProjection[];
  timeoutSeconds: number;
  /** Engines excluded from the DO-local provider set at the config layer. */
  browserBackedEngines: BrowserBackedEngineId[];
}

function engineProjection(
  engine: SearchEngineId,
  gate: { required: boolean; present: boolean },
): WebSearchEngineProjection {
  return {
    engine,
    credentialsRequired: gate.required,
    credentialsPresent: gate.present,
  };
}

export function projectWebSearchConfig(config: WebSearchConfig): WebSearchProjection {
  const chain = config.chain.map((engine): WebSearchEngineProjection => {
    if (engine === "brave") {
      const apiKey = config.engines.brave?.apiKey;
      return engineProjection(engine, {
        required: true,
        present: apiKey !== undefined && apiKey !== "",
      });
    }
    if (engine === "searxng") {
      const endpoint = config.engines.searxng?.endpoint;
      return engineProjection(engine, {
        required: true,
        present: endpoint !== undefined && endpoint !== "",
      });
    }
    // duckduckgo / startpage / public are credential-free plain fetch.
    return engineProjection(engine, { required: false, present: true });
  });
  return {
    chain,
    timeoutSeconds: config.timeoutSeconds,
    browserBackedEngines: [...BROWSER_BACKED_ENGINES],
  };
}

// ---------------------------------------------------------------------------
// Shared search plumbing — omp ports with inline anchors
// ---------------------------------------------------------------------------

/** omp web/search/providers/utils.ts:106 (CREDIT_BODY_PATTERN). */
const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

/** Provider-tagged failure (omp web/search/types.ts:21 SearchProviderError). */
export class SearchEngineError extends Error {
  constructor(
    readonly engine: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SearchEngineError";
  }
}

/** omp SEARCH_PROVIDER_LABELS subset — error/no-content texts carry labels. */
const ENGINE_LABELS: Record<SearchEngineId, string> = {
  brave: "Brave",
  duckduckgo: "DuckDuckGo",
  searxng: "SearXNG",
  startpage: "Startpage",
  public: "Public Web",
};

export type FetchImpl = typeof fetch;

/**
 * omp web/search/providers/utils.ts:69 (withHardTimeout) — compose the
 * caller signal with the per-transport ceiling.
 */
function withHardTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** omp web/search/utils.ts:14 (clampNumResults). */
function clampNumResults(value: number | undefined, defaultVal: number, maxVal: number): number {
  if (!value || Number.isNaN(value)) return defaultVal;
  return Math.min(maxVal, Math.max(1, value));
}

/** omp web/search/utils.ts:2 (dateToAgeSeconds). */
function dateToAgeSeconds(dateStr: string | null | undefined): number | undefined {
  if (!dateStr) return undefined;
  try {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return undefined;
    return Math.floor((Date.now() - date.getTime()) / 1000);
  } catch {
    return undefined;
  }
}

/** omp packages/utils/src/format.ts:98 (formatAge). */
function formatAge(ageSeconds: number | null | undefined): string {
  if (!ageSeconds) return "";
  const mins = Math.floor(ageSeconds / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  if (months > 0) return `${months}mo ago`;
  if (weeks > 0) return `${weeks}w ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

/** omp packages/utils/src/format.ts:117 (pluralize). */
function pluralize(label: string, count: number): string {
  if (count === 1) return label;
  if (/(?:ch|sh|s|x|z)$/i.test(label)) return `${label}es`;
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

/** omp packages/utils/src/format.ts:90 (formatCount). */
function formatCount(label: string, count: number): string {
  const safeCount = Number.isFinite(count) ? count : 0;
  return `${safeCount} ${pluralize(label, safeCount)}`;
}

/** omp packages/utils/src/format.ts:81 (truncate). */
function truncate(str: string, maxLen: number, ellipsis = "…"): string {
  if (str.length <= maxLen) return str;
  const sliceLen = Math.max(0, maxLen - ellipsis.length);
  return `${str.slice(0, sliceLen)}${ellipsis}`;
}

/** omp providers/utils.ts:108 (classifyProviderHttpError). */
function classifyEngineHttpError(
  engine: string,
  status: number,
  body: string,
): SearchEngineError | null {
  if (CREDIT_BODY_PATTERN.test(body)) {
    return new SearchEngineError(engine, `${engine}: credits exhausted`, status);
  }
  if (status === 402)
    return new SearchEngineError(engine, `${engine}: 402 credits exhausted`, status);
  if (status === 401) return new SearchEngineError(engine, `${engine}: 401 unauthorized`, status);
  if (status === 403) return new SearchEngineError(engine, `${engine}: 403 forbidden`, status);
  return null;
}

/**
 * omp providers/utils.ts readLimitedText: read the body with a byte cap;
 * an oversize body is itself a provider failure, never a silent truncate.
 */
async function readLimitedText(
  response: Response,
  engine: string,
  maxBytes: number,
): Promise<string> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new SearchEngineError(engine, `${engine} response exceeded ${maxBytes} bytes`, 500);
  }
  return text;
}

/** omp providers/brave.ts:73 (normalizeText) — strip tags, fold space. */
function normalizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/** omp providers/brave.ts:83 (normalizeUrl). */
function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** omp web/search/types.ts SearchResponse/SearchSource edge subset. */
export interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
  ageSeconds?: number;
}

export interface SearchResponse {
  engine: SearchEngineId;
  answer?: string;
  sources: SearchSource[];
  relatedQuestions?: string[];
}

/**
 * omp provider.ts:62 (formatSearchProviderFailure) — the anthropic-404 and
 * zai special cases cannot occur on this engine set and are not ported.
 */
export function formatEngineFailure(error: unknown, engine: string): string {
  if (error instanceof SearchEngineError) {
    if (error.status === 401 || error.status === 403) {
      return `${engine} authorization failed (${error.status}). Check API key or base URL.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return `Unknown error from ${engine}`;
}

/** omp provider.ts:80 (formatSearchProviderFailures). */
export function formatEngineFailures(
  failures: readonly { engine: string; error: unknown }[],
): string {
  return failures.map((f) => `${f.engine}: ${formatEngineFailure(f.error, f.engine)}`).join("; ");
}

// ---------------------------------------------------------------------------
// Engine transports — plain fetch only (no browser escalation)
// ---------------------------------------------------------------------------

interface EngineSearchParams {
  query: string;
  limit?: number;
  recency?: "day" | "week" | "month" | "year";
  numSearchResults?: number;
  signal: AbortSignal;
  timeoutMs: number;
  fetchImpl: FetchImpl;
}

// -- brave (omp providers/brave.ts) -----------------------------------------

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_DEFAULT_NUM_RESULTS = 10;
const BRAVE_MAX_NUM_RESULTS = 20;
const BRAVE_MAX_QUERY_CHARACTERS = 500;
const BRAVE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BRAVE_MAX_ERROR_BYTES = 8 * 1024;

/** omp providers/brave.ts:24 (RECENCY_MAP). */
const BRAVE_RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

async function searchBrave(
  params: EngineSearchParams,
  settings: BraveEngineSettings,
): Promise<SearchResponse> {
  const numResults = clampNumResults(
    params.numSearchResults ?? params.limit,
    BRAVE_DEFAULT_NUM_RESULTS,
    BRAVE_MAX_NUM_RESULTS,
  );
  const query = params.query;
  if (query.length > BRAVE_MAX_QUERY_CHARACTERS) {
    throw new SearchEngineError(
      "brave",
      `Brave search queries cannot exceed ${BRAVE_MAX_QUERY_CHARACTERS} characters`,
      400,
    );
  }
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(numResults));
  url.searchParams.set("extra_snippets", "true");
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("safesearch", "moderate");
  if (params.recency) url.searchParams.set("freshness", BRAVE_RECENCY_MAP[params.recency]);

  const response = await params.fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": settings.apiKey ?? "",
    },
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await readLimitedText(response, "brave", BRAVE_MAX_ERROR_BYTES);
    const classified = classifyEngineHttpError("brave", response.status, errorText);
    if (classified) throw classified;
    throw new SearchEngineError(
      "brave",
      `Brave API error (${response.status}): ${errorText}`,
      response.status,
    );
  }

  const raw = await readLimitedText(response, "brave", BRAVE_MAX_RESPONSE_BYTES);
  let data: { web?: { results?: unknown } };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    throw new SearchEngineError("brave", "Brave API returned invalid JSON", 500);
  }
  const rawResults = data.web?.results;
  const results = Array.isArray(rawResults) ? rawResults : [];

  const sources: SearchSource[] = [];
  for (const result of results) {
    if (typeof result !== "object" || result === null) continue;
    const record = result as Record<string, unknown>;
    const url = normalizeUrl(record.url);
    if (!url) continue;
    const snippets = new Set<string>();
    const description = normalizeText(record.description, 8_000);
    if (description) snippets.add(description);
    if (Array.isArray(record.extra_snippets)) {
      for (const value of record.extra_snippets) {
        const snippet = normalizeText(value, 8_000);
        if (snippet) snippets.add(snippet);
      }
    }
    const combined = [...snippets].join("\n");
    const snippet = combined
      ? combined.length <= 8_000
        ? combined
        : `${combined.slice(0, 7_999)}…`
      : undefined;
    const publishedDate = normalizeText(record.age, 100);
    sources.push({
      title: normalizeText(record.title, 300) ?? url,
      url,
      snippet,
      publishedDate,
      ageSeconds: dateToAgeSeconds(publishedDate),
    });
  }

  return { engine: "brave", sources: sources.slice(0, numResults) };
}

// -- duckduckgo (omp providers/duckduckgo.ts) --------------------------------

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
const DDG_DEFAULT_NUM_RESULTS = 10;
const DDG_MAX_NUM_RESULTS = 20;

/** omp providers/duckduckgo.ts:27 (RECENCY_TO_DDG_DF). */
const DDG_RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

/**
 * omp providers/duckduckgo.ts:47 (decodeHtmlText) — strip inline tags, unescape
 * the entity set DDG emits, fold whitespace.
 */
function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * omp providers/duckduckgo.ts:70 (unwrapResultUrl) — resolve the three href
 * shapes DDG mixes in: `uddg=` redirect wrappers, protocol-relative links,
 * and absolute URLs.
 */
function unwrapResultUrl(href: string): string | undefined {
  if (!href) return undefined;
  const decoded = href.replace(/&amp;/gi, "&");
  const wrapMatch = /[?&]uddg=([^&]+)/.exec(decoded);
  if (wrapMatch) {
    try {
      const wrapped = wrapMatch[1];
      if (wrapped !== undefined) return decodeURIComponent(wrapped);
      return undefined;
    } catch {
      return undefined;
    }
  }
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
  return undefined;
}

/**
 * omp providers/duckduckgo.ts:93 (extractPublishedDate) — scan only the
 * `result__extras__url` container so a date-shaped snippet is not
 * attributed as publication metadata.
 */
function extractPublishedDate(block: string): string | undefined {
  const extrasUrl =
    /<div\b[^>]*\bclass="[^"]*\bresult__extras__url\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
      block,
    )?.[1];
  if (!extrasUrl) return undefined;
  for (const match of extrasUrl.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const text = decodeHtmlText(raw);
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/.test(text)) return text;
  }
  return undefined;
}

/**
 * omp providers/duckduckgo.ts:112 (parseHtmlResults) — result blocks in
 * document order; the regex port keeps omp's exact patterns (workerd has
 * no DOM parser; the markup anchors are omp's own).
 */
function parseDdgResults(
  html: string,
): { title: string; url: string; snippet?: string; publishedDate?: string }[] {
  const results: { title: string; url: string; snippet?: string; publishedDate?: string }[] = [];
  const blockRe =
    /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
  const titleRe =
    /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRe =
    /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
  for (const match of html.matchAll(blockRe)) {
    const block = match[1];
    if (block === undefined) continue;
    const title = titleRe.exec(block);
    if (!title) continue;
    const href = title[1];
    if (href === undefined) continue;
    const rawTitle = title[2];
    if (rawTitle === undefined) continue;
    const url = unwrapResultUrl(href);
    if (!url) continue;
    const titleText = decodeHtmlText(rawTitle);
    if (!titleText) continue;
    const snippet = snippetRe.exec(block);
    const snippetText = snippet?.[1] !== undefined ? decodeHtmlText(snippet[1]) : undefined;
    results.push({
      title: titleText,
      url,
      snippet: snippetText === "" ? undefined : snippetText,
      publishedDate: extractPublishedDate(block),
    });
  }
  return results;
}

/**
 * omp providers/duckduckgo.ts:143 (parseContinuationForm) — hidden fields of
 * the next-page form (attribute-order tolerant).
 */
function parseDdgContinuationForm(html: string): URLSearchParams | undefined {
  for (const formMatch of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const formHtml = formMatch[1];
    if (formHtml === undefined) continue;
    const form = new URLSearchParams();
    for (const inputMatch of formHtml.matchAll(/<input\b[^>]*>/gi)) {
      const input = inputMatch[0];
      const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
      const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
      if (name && value !== undefined) form.append(decodeHtmlText(name), decodeHtmlText(value));
    }
    if (form.has("s") && form.has("vqd")) return form;
  }
  return undefined;
}

async function callDuckDuckGoHtml(
  params: EngineSearchParams,
  form: URLSearchParams,
  signal: AbortSignal,
): Promise<string> {
  // Plain fetch only — the omp adapter's browserFetch escalation is the
  // browser-backed red line; a challenge surfaces as a 429 failure and the
  // chain advances (docs/tools/web_search.md §Side Effects).
  const response = await params.fetchImpl(DUCKDUCKGO_HTML_URL, {
    method: "POST",
    body: form.toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://html.duckduckgo.com/",
    },
    signal,
  });
  const body = await response.text();
  if (response.status < 200 || response.status >= 300) {
    const classified = classifyEngineHttpError("duckduckgo", response.status, body);
    if (classified) throw classified;
    throw new SearchEngineError(
      "duckduckgo",
      `DuckDuckGo HTML error (${response.status})`,
      response.status,
    );
  }
  // omp isAnomalyResponse — DDG mixes status codes on challenges; the body
  // markers are the reliable signal.
  if (body.includes("anomaly-modal") || body.includes("anomaly.js")) {
    throw new SearchEngineError(
      "duckduckgo",
      "DuckDuckGo blocked the request with a bot-detection challenge. DuckDuckGo throttles automated HTML searches from datacenter/shared-egress IPs; configure a credentialed provider such as Brave, Tavily, Exa, or Kagi for reliable web search.",
      429,
    );
  }
  return body;
}

async function searchDuckDuckGo(params: EngineSearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(
    params.numSearchResults ?? params.limit,
    DDG_DEFAULT_NUM_RESULTS,
    DDG_MAX_NUM_RESULTS,
  );
  const signal = withHardTimeout(params.signal, params.timeoutMs);
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  let form: URLSearchParams | undefined = new URLSearchParams({
    q: params.query,
    kl: "us-en",
    b: "",
  });
  const df = params.recency ? DDG_RECENCY_MAP[params.recency] : undefined;
  if (df) form.set("df", df);

  while (form && sources.length < numResults) {
    const html = await callDuckDuckGoHtml(params, form, signal);
    const sourceCount = sources.length;
    for (const result of parseDdgResults(html)) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      sources.push({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        publishedDate: result.publishedDate,
        ageSeconds: dateToAgeSeconds(result.publishedDate),
      });
      if (sources.length >= numResults) break;
    }
    if (sources.length === sourceCount) break;
    form = parseDdgContinuationForm(html);
  }

  return { engine: "duckduckgo", sources };
}

// -- startpage (omp providers/startpage.ts) ----------------------------------

const STARTPAGE_HOME_URL = "https://www.startpage.com/";
const STARTPAGE_SEARCH_URL = "https://www.startpage.com/sp/search";
const STARTPAGE_DEFAULT_NUM_RESULTS = 10;
const STARTPAGE_MAX_NUM_RESULTS = 20;

/** omp providers/startpage.ts:31 (RECENCY_TO_STARTPAGE_WITH_DATE). */
const STARTPAGE_RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

/**
 * omp providers/startpage.ts:57 (isChallengeResponse) — rejected requests
 * 302 to the captcha/error SPA; the body markers carry mocked responses
 * that expose no final URL.
 */
function isStartpageChallenge(url: string, html: string): boolean {
  if (/\/(?:errors|captcha)\//.test(url) || url.includes("/sp/captcha")) return true;
  return html.includes("component---src-pages-captcha") || html.includes("/sp/captcha");
}

/**
 * omp providers/startpage.ts:67 (parseSearchFormInputs) — hidden inputs of
 * the homepage `/sp/search` form; regex port of omp's DOM query (workerd
 * has no DOM parser). Requires the `sc` anti-bot token.
 */
function parseStartpageFormInputs(html: string): Record<string, string> | undefined {
  const form = /<form\b[^>]*\baction="\/sp\/search"[^>]*>([\s\S]*?)<\/form>/i.exec(html)?.[1];
  if (form === undefined) return undefined;
  const inputs: Record<string, string> = {};
  for (const match of form.matchAll(/<input\b[^>]*\btype="hidden"[^>]*>/gi)) {
    const input = match[0];
    const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
    if (name === undefined) continue;
    const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
    inputs[name] = value !== undefined ? decodeHtmlText(value) : "";
  }
  return inputs.sc !== undefined ? inputs : undefined;
}

/** omp providers/startpage.ts:80 (sanitizeResultUrl). */
function sanitizeStartpageResultUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  let url: URL;
  try {
    url = new URL(href, STARTPAGE_HOME_URL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "startpage.com" || url.hostname.endsWith(".startpage.com")) return undefined;
  return url.href;
}

/**
 * omp providers/startpage.ts:103 (parseHtmlResults) — `div.result` blocks in
 * document order: `a.result-link` (with `h2`/`h3` heading) and an optional
 * `p.description`; regex port of omp's DOM walk.
 */
function parseStartpageResults(html: string): { title: string; url: string; snippet?: string }[] {
  const results: { title: string; url: string; snippet?: string }[] = [];
  const blockRe =
    /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|$)/g;
  const anchorRe =
    /<a\b[^>]*\bclass="[^"]*\bresult-link\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const headingRe = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i;
  const snippetRe = /<p\b[^>]*\bclass="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
  for (const match of html.matchAll(blockRe)) {
    const block = match[1];
    if (block === undefined) continue;
    const anchor = anchorRe.exec(block);
    if (!anchor) continue;
    const href = anchor[1];
    const rawAnchor = anchor[2];
    if (href === undefined || rawAnchor === undefined) continue;
    const url = sanitizeStartpageResultUrl(href);
    if (!url) continue;
    const titleText = decodeHtmlText(headingRe.exec(rawAnchor)?.[1] ?? rawAnchor);
    if (!titleText) continue;
    const snippetText = snippetRe.exec(block)?.[1];
    results.push({
      title: titleText,
      url,
      snippet: snippetText ? decodeHtmlText(snippetText) || undefined : undefined,
    });
  }
  return results;
}

async function searchStartpage(params: EngineSearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(
    params.numSearchResults ?? params.limit,
    STARTPAGE_DEFAULT_NUM_RESULTS,
    STARTPAGE_MAX_NUM_RESULTS,
  );
  const signal = withHardTimeout(params.signal, params.timeoutMs);
  const withDate = params.recency ? STARTPAGE_RECENCY_MAP[params.recency] : undefined;

  // omp fetchFormInputs — best-effort homepage token; any failure degrades
  // to the tokenless GET fallback (providers/startpage.ts:124).
  let formInputs: Record<string, string> | undefined;
  try {
    const home = await params.fetchImpl(STARTPAGE_HOME_URL, { signal });
    if (home.ok) {
      const homeHtml = await home.text();
      if (!isStartpageChallenge(home.url, homeHtml))
        formInputs = parseStartpageFormInputs(homeHtml);
    }
  } catch (error) {
    if (signal.aborted) throw error;
  }

  let page: Response;
  if (formInputs) {
    const form = new URLSearchParams(formInputs);
    form.set("query", params.query);
    if (withDate) form.set("with_date", withDate);
    page = await params.fetchImpl(STARTPAGE_SEARCH_URL, {
      method: "POST",
      body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: STARTPAGE_HOME_URL },
      signal,
    });
  } else {
    const url = new URL(STARTPAGE_SEARCH_URL);
    url.searchParams.set("query", params.query);
    if (withDate) url.searchParams.set("with_date", withDate);
    page = await params.fetchImpl(url.href, {
      headers: { Referer: STARTPAGE_HOME_URL },
      signal,
    });
  }

  const html = await page.text();
  if (isStartpageChallenge(page.url, html)) {
    throw new SearchEngineError(
      "startpage",
      "Startpage blocked the request with a CAPTCHA challenge. Startpage rate-limits automated searches from datacenter/shared-egress IPs; try another provider such as DuckDuckGo or Mojeek, or retry later.",
      429,
    );
  }
  if (!page.ok) {
    const classified = classifyEngineHttpError("startpage", page.status, html);
    if (classified) throw classified;
    throw new SearchEngineError("startpage", `Startpage HTML error (${page.status})`, page.status);
  }

  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of parseStartpageResults(html)) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({ title: result.title, url: result.url, snippet: result.snippet });
    if (sources.length >= numResults) break;
  }

  return { engine: "startpage", sources };
}

// -- searxng (omp providers/searxng.ts) --------------------------------------

const SEARXNG_DEFAULT_NUM_RESULTS = 10;
const SEARXNG_MAX_NUM_RESULTS = 20;

/**
 * omp providers/searxng.ts:65 (RECENCY_MAP) — SearXNG supports
 * day/month/year only; week downgrades to month.
 */
const SEARXNG_RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
  day: "day",
  week: "month",
  month: "month",
  year: "year",
};

/**
 * omp providers/searxng.ts:121 (findAuth) — Basic auth precedence over
 * bearer, with the RFC 7617 validations verbatim.
 */
function searxngAuth(
  settings: SearxngEngineSettings,
): { type: "basic" | "bearer"; value: string } | null {
  const basicUsername = settings.basicUsername;
  const basicPassword = settings.basicPassword;
  if (basicUsername !== undefined || basicPassword !== undefined) {
    if (basicUsername === undefined || basicPassword === undefined) {
      throw new Error(
        "SearXNG Basic auth requires both searxng.basicUsername and searxng.basicPassword, or SEARXNG_BASIC_USERNAME and SEARXNG_BASIC_PASSWORD.",
      );
    }
    if (basicUsername.includes(":")) {
      throw new Error(
        "SearXNG Basic auth username cannot contain ':' because RFC 7617 uses it as the separator.",
      );
    }
    if (
      /[\u0000-\u001F\u007F-\u009F]/u.test(basicUsername) ||
      /[\u0000-\u001F\u007F-\u009F]/u.test(basicPassword)
    ) {
      throw new Error(
        "SearXNG Basic auth credentials must not contain RFC 7617 control characters.",
      );
    }
    return {
      type: "basic",
      value: btoa(
        String.fromCharCode(...new TextEncoder().encode(`${basicUsername}:${basicPassword}`)),
      ),
    };
  }
  const token = settings.token;
  return token ? { type: "bearer", value: token } : null;
}

/**
 * omp providers/searxng.ts:303 (formatAnswers) — legacy string answers and
 * modern structured answer plugins with a displayable `text` field.
 */
function searxngAnswers(answers: unknown[] | undefined): string | undefined {
  if (!answers?.length) return undefined;
  const texts: string[] = [];
  for (const answer of answers) {
    if (typeof answer === "string" && answer.trim()) texts.push(answer.trim());
    else if (typeof answer === "object" && answer !== null) {
      const text = (answer as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) texts.push(text.trim());
    }
  }
  return texts.length ? texts.join("\n") : undefined;
}

async function searchSearxng(
  params: EngineSearchParams,
  settings: SearxngEngineSettings,
): Promise<SearchResponse> {
  const numResults = clampNumResults(
    params.numSearchResults ?? params.limit,
    SEARXNG_DEFAULT_NUM_RESULTS,
    SEARXNG_MAX_NUM_RESULTS,
  );
  const endpoint = settings.endpoint;
  if (!endpoint) {
    throw new Error(
      "SearXNG endpoint not configured. Set searxng.endpoint in settings or SEARXNG_ENDPOINT in environment.",
    );
  }
  const auth = searxngAuth(settings);

  const base = endpoint.replace(/\/+$/, "");
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");
  if (params.recency) url.searchParams.set("time_range", SEARXNG_RECENCY_MAP[params.recency]);
  if (settings.categories) url.searchParams.set("categories", settings.categories);
  if (settings.language) url.searchParams.set("language", settings.language);
  if (settings.safesearch !== undefined)
    url.searchParams.set("safesearch", String(settings.safesearch));

  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth?.type === "basic") headers.Authorization = `Basic ${auth.value}`;
  else if (auth?.type === "bearer") headers.Authorization = `Bearer ${auth.value}`;

  const response = await params.fetchImpl(url, {
    headers,
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text();
    const classified = classifyEngineHttpError("searxng", response.status, errorText);
    if (classified) throw classified;
    throw new SearchEngineError(
      "searxng",
      `SearXNG API error (${response.status}): ${errorText}`,
      response.status,
    );
  }

  const data = await response.json<SearxngResponsePayload>();

  const sources: SearchSource[] = [];
  for (const result of data.results ?? []) {
    if (!result.url) continue;
    const publishedDate = result.publishedDate ?? result.published_date;
    const content = (result.content ?? result.snippet)?.trim();
    sources.push({
      title: result.title ?? result.url,
      url: result.url,
      snippet: content === "" ? undefined : content,
      publishedDate: publishedDate ?? undefined,
      ageSeconds: dateToAgeSeconds(publishedDate),
    });
  }
  const limitedSources = sources.slice(0, numResults);
  if (limitedSources.length === 0 && data.unresponsive_engines?.length) {
    const upstreamFailures = data.unresponsive_engines
      .map(([engine, reason]) => `${engine}: ${reason}`)
      .join("; ");
    throw new SearchEngineError(
      "searxng",
      `SearXNG returned no usable results; upstream engines failed: ${upstreamFailures}`,
      503,
    );
  }

  return {
    engine: "searxng",
    answer: searxngAnswers(data.answers),
    sources: limitedSources,
    relatedQuestions: data.suggestions?.length ? data.suggestions : undefined,
  };
}

interface SearxngResponsePayload {
  results?: {
    title?: string;
    url?: string;
    content?: string;
    snippet?: string;
    publishedDate?: string;
    published_date?: string;
  }[];
  suggestions?: string[];
  unresponsive_engines?: [string, string][];
  answers?: unknown[];
}

// -- public (omp providers/public.ts) ----------------------------------------

/**
 * omp providers/public.ts:16 (PUBLIC_ENGINE_IDS) minus the browser-backed
 * three: the credential-free engines that survive the edge exclusion, in
 * omp's order (startpage leads — Google-index quality; duckduckgo breaks
 * ties with its independent crawl).
 */
const PUBLIC_ENGINE_IDS: readonly Exclude<SearchEngineId, "public" | "brave" | "searxng">[] = [
  "startpage",
  "duckduckgo",
];

/** omp providers/public.ts:25 — aggregates get a wider window. */
const PUBLIC_DEFAULT_NUM_RESULTS = 15;
const PUBLIC_MAX_NUM_RESULTS = 30;

/** omp providers/public.ts:34 (SOFT_DEADLINE_MS). */
const PUBLIC_SOFT_DEADLINE_MS = 5_000;

/** omp providers/public.ts:41 (HARD_DEADLINE_MS). */
const PUBLIC_HARD_DEADLINE_MS = 30_000;

/** omp providers/public.ts:44 (PublicWebDeadlines) — test seam. */
export interface PublicWebDeadlines {
  softMs?: number;
  hardMs?: number;
}

/** omp providers/public.ts:65 (dedupKey). */
function publicDedupKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${host}${path}${url.search}`;
  } catch {
    return rawUrl;
  }
}

/** omp providers/public.ts:50 (MergedSource) + :78 (mergeSources). */
function mergePublicSources(
  merged: Map<
    string,
    {
      source: SearchSource;
      engines: number;
      bestRank: number;
      order: number;
    }
  >,
  sources: readonly SearchSource[],
): void {
  for (const [rank, source] of sources.entries()) {
    const key = publicDedupKey(source.url);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { source: { ...source }, engines: 1, bestRank: rank, order: merged.size });
      continue;
    }
    existing.engines += 1;
    if (rank < existing.bestRank) {
      existing.bestRank = rank;
      existing.source.title = source.title;
      existing.source.url = source.url;
    }
    if (source.snippet && source.snippet.length > (existing.source.snippet?.length ?? 0)) {
      existing.source.snippet = source.snippet;
    }
    existing.source.publishedDate ??= source.publishedDate;
    existing.source.ageSeconds ??= source.ageSeconds;
  }
}

async function searchPublicWeb(
  params: EngineSearchParams,
  ctx: WebSearchToolContext,
): Promise<SearchResponse> {
  // omp races Bun.sleep(...); workerd has no Bun — the deadline promise is
  // the same construct (a never-rejecting timer participant).
  const deadline = (ms: number): Promise<true> => {
    const { promise, resolve } = Promise.withResolvers<true>();
    setTimeout(() => {
      resolve(true);
    }, ms);
    return promise;
  };
  const softMs = ctx.publicDeadlines?.softMs ?? PUBLIC_SOFT_DEADLINE_MS;
  const hardMs = ctx.publicDeadlines?.hardMs ?? PUBLIC_HARD_DEADLINE_MS;
  const numResults = clampNumResults(
    params.numSearchResults ?? params.limit,
    PUBLIC_DEFAULT_NUM_RESULTS,
    PUBLIC_MAX_NUM_RESULTS,
  );

  // omp providers/public.ts:131 — the straggler controller lets the
  // aggregate cancel still-running engines once it decides to return.
  const straggler = new AbortController();
  const signal = AbortSignal.any([
    withHardTimeout(params.signal, params.timeoutMs),
    straggler.signal,
  ]);

  const responses: (SearchResponse | undefined)[] = PUBLIC_ENGINE_IDS.map(
    (): SearchResponse | undefined => undefined,
  );
  const failures: { engine: string; error: unknown }[] = [];
  const firstSuccess = Promise.withResolvers<true>();
  const all = Promise.all(
    PUBLIC_ENGINE_IDS.map(async (id, index) => {
      try {
        responses[index] = await runEngineSearch(id, params, { ...ctx, signal });
        firstSuccess.resolve(true);
      } catch (error) {
        failures.push({ engine: id, error });
      }
    }),
  );

  await Promise.race([all, deadline(softMs)]);
  if (
    !responses.some((response) => response !== undefined) &&
    failures.length < PUBLIC_ENGINE_IDS.length
  ) {
    await Promise.race([all, firstSuccess.promise, deadline(Math.max(0, hardMs - softMs))]);
  }
  straggler.abort();

  // Merge in engine-priority order so ranking tiebreaks stay deterministic.
  const merged = new Map<
    string,
    { source: SearchSource; engines: number; bestRank: number; order: number }
  >();
  for (const response of responses) {
    if (response) mergePublicSources(merged, response.sources);
  }

  if (merged.size === 0 && failures.length === PUBLIC_ENGINE_IDS.length) {
    throw new SearchEngineError(
      "public",
      `All public engines failed: ${formatEngineFailures(failures)}`,
      503,
    );
  }

  const sources = [...merged.values()]
    .sort((a, b) => b.engines - a.engines || a.bestRank - b.bestRank || a.order - b.order)
    .slice(0, numResults)
    .map((entry) => entry.source);

  return { engine: "public", sources };
}

/**
 * omp web/search/index.ts:112 (hasRenderableSearchContent) — an engine that
 * answers with nothing renderable is a 204-class failure and the chain
 * advances, never an empty ok result.
 */
function hasRenderableSearchContent(response: SearchResponse): boolean {
  if (response.answer?.trim()) return true;
  if (response.sources.length > 0) return true;
  if (response.relatedQuestions?.some((question) => question.trim())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Chain walk — omp executeSearch structure over the config-layer chain
// ---------------------------------------------------------------------------

/** LLM-formatted output — omp web/search/index.ts:59 (formatForLLM) verbatim. */
function formatForLLM(response: SearchResponse, notes: readonly string[] = []): string {
  const parts: string[] = [];
  for (const note of notes) {
    parts.push(`Note: ${note}`);
  }

  if (response.answer) {
    parts.push(response.answer);
    if (response.sources.length > 0) {
      parts.push("\n## Sources");
      parts.push(formatCount("source", response.sources.length));
    }
  }

  for (const [i, src] of response.sources.entries()) {
    const age = formatAge(src.ageSeconds) || src.publishedDate;
    const agePart = age ? ` (${age})` : "";
    parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
    if (src.snippet) {
      parts.push(`    ${truncate(src.snippet, 240)}`);
    }
  }

  if (response.relatedQuestions && response.relatedQuestions.length > 0) {
    parts.push("\n## Related");
    parts.push(formatCount("question", response.relatedQuestions.length));
    for (const [i, question] of response.relatedQuestions.entries()) {
      parts.push(`[${i + 1}] ${question}`);
    }
  }

  return parts.join("\n");
}

/**
 * omp provider availability (isAvailable): an engine without credentials is
 * skipped silently by the automatic chain (docs/tools/web_search.md §Flow 3
 * — "An unavailable non-explicit candidate is skipped silently"). The edge
 * chain is config-layer (every entry is explicit by construction), but the
 * credential gates keep omp's semantics: brave needs a key, searxng needs
 * an endpoint; scrapers and the aggregate are always available.
 */
function engineAvailable(engine: SearchEngineId, settings: WebSearchEngineSettings): boolean {
  switch (engine) {
    case "brave":
      return (settings.brave?.apiKey ?? "").length > 0;
    case "searxng":
      return (settings.searxng?.endpoint ?? "").length > 0;
    case "duckduckgo":
    case "startpage":
    case "public":
      return true;
  }
}

async function runEngineSearch(
  engine: SearchEngineId,
  params: EngineSearchParams,
  ctx: WebSearchToolContext,
): Promise<SearchResponse> {
  switch (engine) {
    case "brave":
      return searchBrave(params, ctx.config.engines.brave ?? {});
    case "duckduckgo":
      return searchDuckDuckGo(params);
    case "searxng":
      return searchSearxng(params, ctx.config.engines.searxng ?? {});
    case "startpage":
      return searchStartpage(params);
    case "public":
      return searchPublicWeb(params, ctx);
  }
}

export interface WebSearchParams {
  query: string;
  recency?: "day" | "week" | "month" | "year";
  limit?: number;
  max_tokens?: number;
  temperature?: number;
  num_search_results?: number;
}

/**
 * DO-bound context: the AgentDO binds config (decoded once from
 * `AGENT_DO_WEB_SEARCH`), the owning call's cancel signal, and the global
 * fetch (MSW-intercepted under the vitest workers pool).
 */
export interface WebSearchToolContext {
  readonly config: WebSearchConfig;
  /** Owning-call cancel surface — abort rethrows (cancelled), never text. */
  readonly signal: AbortSignal;
  /** Outbound fetch seam — the DO binds global fetch; tests may inject. */
  readonly fetchImpl: FetchImpl;
  /** Public Web deadline overrides (omp PublicWebDeadlines test seam). */
  readonly publicDeadlines?: PublicWebDeadlines;
}

/**
 * Execute one web_search call: walk the configured engine chain, first
 * success wins. omp execution semantics verbatim (docs/tools/web_search.md
 * §Errors/§Timeout, retry-matrix §2.1 web_search row):
 * - per-transport ceiling 60s default / 300s cap, never a whole-chain
 *   deadline; each candidate gets a fresh window;
 * - provider failures return `Error: …` text (single failure = the
 *   normalized error; multiple = the semicolon-separated summary) so the
 *   chain advances — the tool does not throw them at the boundary;
 * - the owning call's signal aborting rethrows as a cancelled tool result
 *   (omp throwIfAborted during fallback);
 * - a chain with no available engine and no failures returns omp's
 *   "Error: No web search model configured." verbatim (the config chain
 *   replaces omp's `web` role chain; the model-visible text is unchanged).
 */
export async function runWebSearchTool(
  params: WebSearchParams,
  ctx: WebSearchToolContext,
): Promise<EdgeToolResult> {
  const timeoutMs =
    Math.min(MAX_WEB_SEARCH_TIMEOUT_SECONDS, Math.max(1, ctx.config.timeoutSeconds)) * 1_000;
  const failures: { engine: string; error: unknown }[] = [];
  let availableCount = 0;
  let lastEngine: string | undefined;

  for (const engine of ctx.config.chain) {
    // omp throwIfAborted before each candidate — the owning call aborting
    // rethrows out of executeSearch; the EdgeToolResult vocabulary renders
    // that rethrow as the cancelled tool result (never an Error text).
    if (ctx.signal.aborted) return { status: "cancelled", output: "" };
    if (!engineAvailable(engine, ctx.config.engines)) continue;
    availableCount += 1;
    lastEngine = engine;
    // Per-transport ceiling (omp SEARCH_HARD_TIMEOUT_MS): a fresh window per
    // candidate, composed with the owning call's cancel signal.
    const transport = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await runEngineSearch(
        engine,
        { ...params, signal: transport, timeoutMs, fetchImpl: ctx.fetchImpl },
        ctx,
      );
      if (!hasRenderableSearchContent(response)) {
        throw new SearchEngineError(
          engine,
          `${ENGINE_LABELS[engine]} returned no renderable search content.`,
          204,
        );
      }
      return { status: "ok", output: formatForLLM(response) };
    } catch (error) {
      // omp throwIfAborted — an abort of the owning call rethrows the
      // signal's reason (fetch rejects with it); a transport timeout rejects
      // with the ceiling signal's own TimeoutError instead, so only the
      // owning call's reason cancels — everything else is a provider failure
      // and the chain advances.
      if (error === ctx.signal.reason) {
        return { status: "cancelled", output: "" };
      }
      failures.push({ engine, error });
    }
  }

  if (availableCount === 0 && failures.length === 0) {
    return { status: "ok", output: "Error: No web search model configured." };
  }
  const firstFailure = failures[0];
  const baseMessage =
    failures.length > 1
      ? `All web search providers failed: ${formatEngineFailures(failures)}`
      : firstFailure !== undefined
        ? formatEngineFailure(firstFailure.error, firstFailure.engine)
        : `Unknown error from ${lastEngine ?? "web search provider"}`;
  return { status: "ok", output: `Error: ${baseMessage}` };
}
