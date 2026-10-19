import { z } from "zod";

/**
 * web_search configuration vocabulary (#449). This module is config-only:
 * the D1 `web_search` row is the sole 正本 and the panel write face plus the
 * stored-row loader share this shape gate. Execution lives on the pi-durable
 * host tool surface, never on a legacy edge executor.
 */

/** omp scrape engines whose failure path can acquire the host Chromium. */
export const BROWSER_BACKED_ENGINES = ["google", "ecosia", "mojeek"] as const;

export type BrowserBackedEngineId = (typeof BROWSER_BACKED_ENGINES)[number];

const BROWSER_BACKED_ENGINE_TABLE: Record<BrowserBackedEngineId, true> = {
  google: true,
  ecosia: true,
  mojeek: true,
};

/**
 * Engines carried by the configurable surface — pure HTTPS, no browser
 * escalation (omp docs/tools/web_search.md §Side Effects).
 */
export type SearchEngineId = "brave" | "exa" | "duckduckgo" | "searxng" | "startpage" | "public";

const SEARCH_ENGINE_ID_TABLE: Record<SearchEngineId, true> = {
  brave: true,
  exa: true,
  duckduckgo: true,
  searxng: true,
  startpage: true,
  public: true,
};

export const SEARCH_ENGINE_IDS: readonly SearchEngineId[] = Object.keys(
  SEARCH_ENGINE_ID_TABLE,
) as SearchEngineId[];

/** Structured policy error: the excluded engine is named with the policy. */
export function browserBackedEnginePolicyError(id: string): Error {
  return new Error(
    `web_search policy: engine "${id}" is browser-backed (classification table §2.2/§6.1 — its anti-bot escalation can acquire a host Chromium) and is excluded from the configurable provider set. Allowed engines: ${SEARCH_ENGINE_IDS.join(", ")}.`,
  );
}

// ---------------------------------------------------------------------------
// Config — panel/D1-resolved settings (#449), patch over defaults
// ---------------------------------------------------------------------------

/** omp web/search/types.ts:12 — per-transport default (seconds). */
export const DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS = 60;

/** omp web/search/types.ts:15 — per-transport configurable cap (seconds). */
export const MAX_WEB_SEARCH_TIMEOUT_SECONDS = 300;

export interface BraveEngineSettings {
  /** Brave Search API subscription key (omp: BRAVE_API_KEY). */
  apiKey?: string;
}

export interface ExaEngineSettings {
  /** Exa API key (omp: EXA_API_KEY / authStorage "exa"). */
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
  exa?: ExaEngineSettings;
  searxng?: SearxngEngineSettings;
}

export interface WebSearchConfig {
  /**
   * Ordered provider chain. The D1 `web_search` row is the sole 正本
   * (#449); the model cannot reach it (the wire schema is omp verbatim and
   * has no engine field).
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

export const engineSettingsPatchSchema = z.object({
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
  exa: z
    .object({
      apiKey: z.string().min(1).optional(),
    })
    .optional(),
});

export const webSearchConfigPatchSchema = z.object({
  chain: z.array(z.string()).min(1).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  engines: engineSettingsPatchSchema.optional(),
});
export type WebSearchConfigPatch = z.infer<typeof webSearchConfigPatchSchema>;

/**
 * Resolve a config patch over `base` — the single validation path shared by
 * the panel write face and the stored-row loader (#449). Shape violations
 * throw (zod); a chain naming a browser-backed engine throws the structured
 * policy error. There is deliberately no env input: the D1 `web_search` row
 * is the only 正本 (#450 zero-env ruling).
 */
export function resolveWebSearchConfig(
  base: WebSearchConfig,
  patch: WebSearchConfigPatch,
): WebSearchConfig {
  const validated = webSearchConfigPatchSchema.parse(patch);
  for (const id of validated.chain ?? []) {
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
    validated.timeoutSeconds === undefined
      ? base.timeoutSeconds
      : Math.min(MAX_WEB_SEARCH_TIMEOUT_SECONDS, Math.max(1, validated.timeoutSeconds));
  return {
    chain: (validated.chain ?? base.chain) as SearchEngineId[],
    timeoutSeconds,
    engines: {
      brave: validated.engines?.brave ?? base.engines.brave,
      exa: validated.engines?.exa ?? base.engines.exa,
      searxng: validated.engines?.searxng ?? base.engines.searxng,
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
 * ceiling, and the browser-backed exclusion list. Only key PRESENCE survives,
 * never a key VALUE.
 */
export interface WebSearchProjection {
  chain: WebSearchEngineProjection[];
  timeoutSeconds: number;
  /** Engines excluded from the configurable provider set. */
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
    if (engine === "exa") {
      const apiKey = config.engines.exa?.apiKey;
      return engineProjection(engine, {
        required: true,
        present: apiKey !== undefined && apiKey !== "",
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
