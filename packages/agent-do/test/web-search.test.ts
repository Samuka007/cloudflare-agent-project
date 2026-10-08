import { afterEach, beforeAll, afterAll, describe, expect, test } from "vitest";
import { http, HttpResponse } from "msw";
import { setupNetwork } from "@msw/cloudflare";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { createRig, resetRuntime } from "./helpers.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import { webSearchFetchImpl } from "../src/agent-do.js";
import { M0_RENDER_FLAGS, toolRegistryRow, wireToolSet } from "../src/tools/registry.js";
import {
  BROWSER_BACKED_ENGINES,
  DEFAULT_WEB_SEARCH_CONFIG,
  MAX_WEB_SEARCH_TIMEOUT_SECONDS,
  resolveWebSearchConfig,
  runWebSearchTool,
  type WebSearchToolContext,
  type WebSearchConfigPatch,
} from "../src/tools/web-search.js";

/**
 * M1.5/T12 L1 (issue #102): the exclusion-set config is effective (disabled
 * engines are REFUSED, never silently dropped), the per-transport ceiling
 * and the Public Web 5s/30s cutoff close, abort rethrows as `cancelled`,
 * provider failures advance the chain as `Error: …` text, and the MSW mock
 * provider observes exactly one outbound fan per execution — re-asking a
 * terminal executionId answers from the journal with zero second fetches.
 *
 * Timer note: the timeout/abort/deadline tests deliberately exercise real
 * platform timer behavior (AbortSignal.timeout ceilings, the Public Web
 * deadline race against workerd's event loop) — fake timers cannot control
 * AbortSignal.timeout, so these keep genuine (small) delays and assert
 * awaited signals, never guessed durations.
 */

const network = setupNetwork();

beforeAll(() => {
  network.enable();
});

afterEach(() => {
  resetRuntime();
  network.resetHandlers();
});

afterAll(() => {
  network.disable();
});

// ---------------------------------------------------------------------------
// Fixtures — provider responses shaped like the real engines (omp anchors).
// Every engine URL each test touches is handled; unhandled requests would
// pass through to the live internet (MSW default), breaking determinism.
// ---------------------------------------------------------------------------

const BRAVE_BODY = {
  web: {
    results: [
      {
        title: "Cloudflare Durable Objects — docs",
        url: "https://developers.cloudflare.com/durable-objects/",
        description: "Durable Objects provide low-latency coordination and consistent storage.",
        age: "2 weeks ago",
        extra_snippets: ["A DO is a single-threaded coordinator."],
      },
      { title: "<b>Styled</b> title", url: "https://example.com/styled" },
    ],
  },
};

const STARTPAGE_HTML = `<!doctype html><html><body>
<form action="/sp/search"><input type="hidden" name="sc" value="tok-abc"><input type="hidden" name="cat" value="web"></form>
<div class="result">
  <a class="result-link" href="https://example.org/alpha"><h2>Alpha result</h2></a>
  <p class="description">The alpha page.</p>
</div>
<div class="result">
  <a class="result-link" href="https://www.example.org:443/beta/">Beta result</a>
</div>
<div class="result">
  <a class="result-link" href="https://startpage.com/self">Self link</a>
</div>
</body></html>`;

const DDG_HTML = `<!doctype html><html><body>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=xyz">One &amp; only</a>
  <a class="result__snippet">First snippet</a>
  <div class="result__extras__url"><span>&nbsp; &nbsp; 2026-09-30T10:00</span></div>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/two">Two</a>
  <div class="result__snippet">Second <b>snippet</b></div>
</div>
</body></html>`;

/** The private searxng the staging VPC service fronts (#535). */
const SEARXNG_VPC_ENDPOINT = "http://10.120.16.22:8888";

const SEARXNG_BODY = {
  results: [
    { title: "SearXNG hit", url: "https://searx.example.com/hit", content: "content snippet" },
    { title: "No-url hit" },
  ],
  suggestions: ["related one"],
  answers: ["42"],
  unresponsive_engines: [],
};

/** Two call sites + one in the shared fixtures: lockstep brave stub. */
function braveHandler(responder: () => Response | Promise<Response>) {
  return http.get("https://api.search.brave.com/res/v1/web/search", responder);
}

const startpageHomeHandler = http.get("https://www.startpage.com/", () =>
  HttpResponse.html(STARTPAGE_HTML),
);
const startpageSearchHandler = http.post("https://www.startpage.com/sp/search", () =>
  HttpResponse.html(STARTPAGE_HTML),
);
const ddgHandler = http.post("https://html.duckduckgo.com/html/", () =>
  HttpResponse.html(DDG_HTML),
);

/**
 * Fetcher-shaped stand-in for the SEARXNG_VPC binding: records every dial
 * and serves the searxng JSON body. Structural — cast at the injection
 * point; the runtime Fetcher surface (RPC etc.) is never exercised here.
 */
class RecordingVpcBinding {
  readonly calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.calls.push({ input, init });
    return Promise.resolve(
      new Response(JSON.stringify(SEARXNG_BODY), {
        headers: { "content-type": "application/json" },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Pure layer — registry row + config policy (L1: exclusion is effective)
// ---------------------------------------------------------------------------

const INTENT_FIELD = { type: "string", description: "concise intent" } as const;

const WEB_SEARCH_DESCRIPTION = `Known URLs/programmatic data → \`read\`. Query: site: or -site:, after: or before: YYYY-MM-DD, inurl:, intitle:, filetype:, "phrase", -term, OR. Prefer primary sources; MUST link citations.`;

describe("M1.5/T12 — registry row is omp verbatim", () => {
  test("schema and description are omp web-search verbatim; class edge with do-local routing", () => {
    const tools = wireToolSet(M0_RENDER_FLAGS);
    const webSearch = tools.find((tool) => tool.name === "web_search");
    expect(webSearch?.description).toBe(WEB_SEARCH_DESCRIPTION);
    expect(webSearch?.input_schema).toEqual({
      type: "object",
      properties: {
        i: INTENT_FIELD,
        query: { type: "string" },
        // arktype emits the union's members alphabetically in the JSON enum.
        recency: { enum: ["day", "month", "week", "year"] },
        limit: { type: "number" },
        max_tokens: { type: "number" },
        temperature: { type: "number" },
        num_search_results: { type: "number" },
      },
      required: ["query", "i"],
    });
    const row = toolRegistryRow("web_search");
    expect(row?.class).toBe("edge");
    expect(row?.backend).toEqual({ kind: "do-local" });
    // No `intent` member in omp WebSearchTool → resolveIntentMode default.
    expect(row?.intent).toBe("require");
  });
});

describe("M1.5/T12 — config-layer engine exclusion (classification §2.2/§6.1 red line)", () => {
  test("each browser-backed engine is refused with the structured policy error", () => {
    for (const engine of BROWSER_BACKED_ENGINES) {
      expect(() => resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, { chain: [engine] })).toThrow(
        `web_search edge policy: engine "${engine}" is browser-backed (classification table §2.2/§6.1 — its anti-bot escalation can acquire a host Chromium) and is excluded from the DO-local provider set. Allowed engines: brave, duckduckgo, searxng, startpage, public.`,
      );
    }
  });

  test("an unknown engine is refused; a valid patch merges over the defaults", () => {
    expect(() => resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, { chain: ["askjeeves"] })).toThrow(
      'web_search config: unknown engine "askjeeves". Allowed engines: brave, duckduckgo, searxng, startpage, public.',
    );
    const decoded = resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, {
        chain: ["searxng"],
        timeoutSeconds: 90,
        engines: { searxng: { endpoint: "https://searx.example.com" } },
    });
    expect(decoded.chain).toEqual(["searxng"]);
    expect(decoded.timeoutSeconds).toBe(90);
    expect(decoded.engines.searxng?.endpoint).toBe("https://searx.example.com");
    // Untouched defaults ride through.
    expect(decoded.engines.brave).toBeUndefined();
  });

  test("the per-transport ceiling: omp dispatcher cap at 300s, non-positive rejected", () => {
    expect(resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, { timeoutSeconds: 999 }).timeoutSeconds).toBe(
      MAX_WEB_SEARCH_TIMEOUT_SECONDS,
    );
    // omp: "Set a positive number of seconds" — non-positive is a config error.
    expect(() => resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, { timeoutSeconds: 0 })).toThrow();
    expect(DEFAULT_WEB_SEARCH_CONFIG.timeoutSeconds).toBe(60);
  });

  // The DO's only web_search input is the D1 row applied through
  // applyWebSearchConfig (#449) — the rejections above are the write-face
  // validation behavior (the loader runs the same resolveWebSearchConfig).
});

// ---------------------------------------------------------------------------
// Pure layer — engine allow/deny matrix over the MSW mock provider
// ---------------------------------------------------------------------------

/** The DI fixture for the pure executor — bound to the real MSW fetch. */
function testCtx(overrides: Partial<WebSearchToolContext> = {}): WebSearchToolContext {
  return {
    config: DEFAULT_WEB_SEARCH_CONFIG,
    signal: new AbortController().signal,
    fetchImpl: (input, init) => fetch(input, init),
    publicDeadlines: { softMs: 2_000, hardMs: 8_000 },
    ...overrides,
  };
}

function ctxWithConfig(
  patch: WebSearchConfigPatch,
  overrides: Partial<WebSearchToolContext> = {},
): WebSearchToolContext {
  return testCtx({ config: resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, patch), ...overrides });
}

describe("M1.5/T12 — engine allow/deny matrix (first success wins, failures advance)", () => {
  test("a keyed brave engine answers; the output is the omp formatForLLM shape", async () => {
    let requests = 0;
    network.use(
      braveHandler(() => {
        requests += 1;
        return HttpResponse.json(BRAVE_BODY);
      }),
    );
    const ctx = ctxWithConfig({ chain: ["brave"], engines: { brave: { apiKey: "brv-key" } } });
    const result = await runWebSearchTool({ query: "durable objects" }, ctx);
    expect(result.status).toBe("ok");
    expect(requests).toBe(1);
    // formatForLLM verbatim: [n] title (age), url line, snippet ≤240.
    expect(result.output).toBe(
      [
        "[1] Cloudflare Durable Objects — docs (2 weeks ago)",
        "    https://developers.cloudflare.com/durable-objects/",
        "    Durable Objects provide low-latency coordination and consistent storage.",
        // omp buildSnippet joins description+extras with \n into ONE snippet;
        // formatForLLM prefixes only the first line.
        "A DO is a single-threaded coordinator.",
        "[2] Styled title",
        "    https://example.com/styled",
      ].join("\n"),
    );
  });

  test("an unkeyed engine is skipped silently — the chain advances without an Error text", async () => {
    let braveHits = 0;
    network.use(
      braveHandler(() => {
        braveHits += 1;
        return HttpResponse.json(BRAVE_BODY);
      }),
      startpageHomeHandler,
      startpageSearchHandler,
      ddgHandler,
    );
    // No brave key: brave is unavailable → skipped, public answers.
    const result = await runWebSearchTool(
      { query: "test" },
      ctxWithConfig({ chain: ["brave", "public"] }),
    );
    expect(result.status).toBe("ok");
    expect(braveHits).toBe(0);
    expect(result.output).not.toContain("Error:");
    expect(result.output).toContain("[1] Alpha result");
  });

  test("no available engine and no failures returns omp's no-provider text", async () => {
    const result = await runWebSearchTool(
      { query: "test" },
      ctxWithConfig({ chain: ["brave", "searxng"] }),
    );
    expect(result).toEqual({ status: "ok", output: "Error: No web search model configured." });
  });

  test("every configured engine failing returns the semicolon-separated provider summary", async () => {
    network.use(
      braveHandler(() => new HttpResponse("boom", { status: 500 })),
      http.get("https://searx.example.com/search", () =>
        HttpResponse.json({ results: [], unresponsive_engines: [["ddg", "timeout"]] }),
      ),
    );
    const result = await runWebSearchTool(
      { query: "test" },
      ctxWithConfig({
        chain: ["brave", "searxng"],
        engines: { brave: { apiKey: "k" }, searxng: { endpoint: "https://searx.example.com" } },
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toBe(
      "Error: All web search providers failed: brave: Brave API error (500): boom; searxng: SearXNG returned no usable results; upstream engines failed: ddg: timeout",
    );
  });

  test("credential-free transports pass omp-faithful form fields and parse both scrapers", async () => {
    let ddgForm = "";
    let startpageBody = "";
    network.use(
      http.post("https://html.duckduckgo.com/html/", async ({ request }) => {
        ddgForm = await request.text();
        return HttpResponse.html(DDG_HTML);
      }),
      startpageHomeHandler,
      http.post("https://www.startpage.com/sp/search", async ({ request }) => {
        startpageBody = await request.text();
        return HttpResponse.html(STARTPAGE_HTML);
      }),
    );
    // First success wins: single-engine chains isolate one transport each.
    const startpageResult = await runWebSearchTool(
      { query: "engines", recency: "week" },
      ctxWithConfig({ chain: ["startpage"] }),
    );
    expect(startpageResult.status).toBe("ok");
    // Startpage form flow: homepage `sc` token carried, query + with_date=w.
    expect(startpageBody).toContain("sc=tok-abc");
    expect(startpageBody).toContain("query=engines");
    expect(startpageBody).toContain("with_date=w");
    // Startpage parsing: div.result blocks, off-host hrefs only.
    expect(startpageResult.output).toContain("[1] Alpha result");
    expect(startpageResult.output).toContain("    https://example.org/alpha");
    expect(startpageResult.output).toContain("    The alpha page.");
    expect(startpageResult.output).toContain("[2] Beta result");
    expect(startpageResult.output).not.toContain("startpage.com/self");

    const ddgResult = await runWebSearchTool(
      { query: "engines", recency: "week" },
      ctxWithConfig({ chain: ["duckduckgo"] }),
    );
    expect(ddgResult.status).toBe("ok");
    // DDG form: raw query, kl default, recency → df=w, b empty.
    expect(ddgForm).toContain("q=engines");
    expect(ddgForm).toContain("kl=us-en");
    expect(ddgForm).toContain("df=w");
    expect(ddgForm).toContain("b=");
    // DDG parsing: uddg unwrap, entity decode, tag-strip snippet, ISO date.
    expect(ddgResult.output).toContain("[1] One & only");
    expect(ddgResult.output).toContain("    https://example.com/one");
    expect(ddgResult.output).toContain("    First snippet");
    expect(ddgResult.output).toContain("[2] Two");
    expect(ddgResult.output).toContain("    Second snippet");
  });

  test("searxng carries basic-auth precedence, json format, and projects suggestions/answers", async () => {
    let auth = "";
    let url = "";
    network.use(
      http.get("https://searx.example.com/search", ({ request }) => {
        auth = request.headers.get("Authorization") ?? "";
        url = request.url;
        return HttpResponse.json(SEARXNG_BODY);
      }),
    );
    const ctx = ctxWithConfig({
      chain: ["searxng"],
      engines: {
        searxng: {
          endpoint: "https://searx.example.com",
          basicUsername: "u",
          basicPassword: "p",
        },
      },
    });
    const result = await runWebSearchTool({ query: "q" }, ctx);
    expect(result.status).toBe("ok");
    expect(auth).toMatch(/^Basic /);
    expect(url).toContain("format=json");
    expect(url).toContain("q=q");
    // omp formatForLLM: the answer leads, sources follow, related last.
    expect(result.output.startsWith("42\n")).toBe(true);
    expect(result.output).toContain("## Sources");
    expect(result.output).toContain("[1] SearXNG hit");
    expect(result.output).toContain("## Related");
    expect(result.output).toContain("[1] related one");
  });

  test("a bot-detection challenge is a provider failure, never a browser escalation", async () => {
    network.use(
      http.post("https://html.duckduckgo.com/html/", () =>
        HttpResponse.html('<html><body><div id="anomaly-modal">challenge</div></body></html>'),
      ),
    );
    const result = await runWebSearchTool(
      { query: "q" },
      ctxWithConfig({ chain: ["duckduckgo"] }),
    );
    expect(result.status).toBe("ok");
    // Single failure: the normalized engine error, unprefixed (omp
    // formatSearchProviderFailure — the engine-id prefix appears only in the
    // multi-failure summary).
    expect(result.output).toBe(
      "Error: DuckDuckGo blocked the request with a bot-detection challenge. DuckDuckGo throttles automated HTML searches from datacenter/shared-egress IPs; configure a credentialed provider such as Brave, Tavily, Exa, or Kagi for reliable web search.",
    );
  });
});

// ---------------------------------------------------------------------------
// searxng VPC leg (#535) — the binding is deployment-shaped (staging only),
// so the wrapper is exercised directly at the ctx seam: bound searxng dials
// ride the binding, every other leg — and the whole surface when the
// binding is absent (local rig) — keeps the MSW-intercepted global fetch.
// ---------------------------------------------------------------------------

describe("searxng VPC leg routing (#535)", () => {
  test("with the binding, the searxng leg dials the binding fetcher with the auth-carrying init", async () => {
    let mswSawSearxng = false;
    network.use(
      http.get(`${SEARXNG_VPC_ENDPOINT}/search`, () => {
        mswSawSearxng = true;
        return HttpResponse.json(SEARXNG_BODY);
      }),
    );
    const binding = new RecordingVpcBinding();
    const config = resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, {
      chain: ["searxng"],
      engines: { searxng: { endpoint: SEARXNG_VPC_ENDPOINT, token: "tunnel-bearer" } },
    });
    const ctx = testCtx({
      config,
      fetchImpl: webSearchFetchImpl(config, { SEARXNG_VPC: binding as unknown as Fetcher }),
    });

    const result = await runWebSearchTool({ query: "q" }, ctx);

    expect(result.status).toBe("ok");
    expect(result.output).toContain("[1] SearXNG hit");
    expect(mswSawSearxng).toBe(false);
    expect(binding.calls).toHaveLength(1);
    const call = binding.calls[0];
    if (call === undefined) throw new Error("missing binding dial");
    const dialed =
      typeof call.input === "string"
        ? call.input
        : call.input instanceof URL
          ? call.input.href
          : call.input.url;
    expect(dialed).toBe(`${SEARXNG_VPC_ENDPOINT}/search?q=q&format=json&pageno=1`);
    // The binding forwards the engine transport's own init — auth included.
    expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer tunnel-bearer");
  });

  test("with the binding, the brave leg stays on global fetch", async () => {
    let braveHits = 0;
    network.use(
      braveHandler(() => {
        braveHits += 1;
        return HttpResponse.json(BRAVE_BODY);
      }),
    );
    const binding = new RecordingVpcBinding();
    const config = resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, {
      chain: ["brave", "searxng"],
      engines: {
        brave: { apiKey: "brv-key" },
        searxng: { endpoint: SEARXNG_VPC_ENDPOINT },
      },
    });
    const ctx = testCtx({
      config,
      fetchImpl: webSearchFetchImpl(config, { SEARXNG_VPC: binding as unknown as Fetcher }),
    });

    const result = await runWebSearchTool({ query: "durable objects" }, ctx);

    expect(result.status).toBe("ok");
    expect(braveHits).toBe(1);
    expect(binding.calls).toHaveLength(0);
  });

  test("no binding keeps the searxng leg on global fetch (local rig unchanged)", async () => {
    let mswSawSearxng = false;
    network.use(
      http.get(`${SEARXNG_VPC_ENDPOINT}/search`, () => {
        mswSawSearxng = true;
        return HttpResponse.json(SEARXNG_BODY);
      }),
    );
    const config = resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, {
      chain: ["searxng"],
      engines: { searxng: { endpoint: SEARXNG_VPC_ENDPOINT } },
    });
    const ctx = testCtx({ config, fetchImpl: webSearchFetchImpl(config, {}) });

    const result = await runWebSearchTool({ query: "q" }, ctx);

    expect(result.status).toBe("ok");
    expect(result.output).toContain("[1] SearXNG hit");
    expect(mswSawSearxng).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Timeout + abort discipline (retry-matrix §2.1 web_search row)
// ---------------------------------------------------------------------------

describe("M1.5/T12 — timeout cutoff and abort rethrow", () => {
  test("a transport past the per-transport ceiling fails and the chain advances", async () => {
    // Socket stand-in for brave only: rejects with the abort reason when the
    // composed transport signal fires. Production relies on workerd fetch
    // honoring AbortSignal.timeout — a real-socket behavior MSW interception
    // (handler-returned responses, no socket to cut) cannot exercise — so
    // the ceiling is asserted against the abort contract directly.
    const hangingBraveFetch = ((
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.search.brave.com")) {
        const { promise, reject } = Promise.withResolvers<Response>();
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            reject(signal.reason);
          },
          { once: true },
        );
        return promise;
      }
      return fetch(input, init);
    }) as typeof fetch;
    let ddgHits = 0;
    network.use(
      http.post("https://html.duckduckgo.com/html/", () => {
        ddgHits += 1;
        return HttpResponse.html(DDG_HTML);
      }),
    );
    const result = await runWebSearchTool(
      { query: "slow brave" },
      ctxWithConfig({ chain: ["brave", "duckduckgo"], timeoutSeconds: 1 }, {
        fetchImpl: hangingBraveFetch,
      }),
    );
    expect(result.status).toBe("ok");
    // Brave timed out at the ceiling, duckduckgo answered — the chain
    // advanced on the timeout instead of surfacing an Error text.
    expect(ddgHits).toBe(1);
    expect(result.output).toContain("[1] One & only");
  });

  test("a cancelled owning call rethrows as a cancelled result — never an Error text", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<true>();
    const release = Promise.withResolvers<true>();
    let braveHits = 0;
    network.use(
      braveHandler(async () => {
        braveHits += 1;
        entered.resolve(true);
        await release.promise;
        return HttpResponse.json(BRAVE_BODY);
      }),
    );
    const ctx = ctxWithConfig({ chain: ["brave"], engines: { brave: { apiKey: "k" } } }, {
      signal: controller.signal,
    });
    const pending = runWebSearchTool({ query: "cancel me" }, ctx);
    // Await the real signal (fetch in flight), not a guessed duration.
    await entered.promise;
    controller.abort();
    const result = await pending;
    expect(braveHits).toBe(1);
    expect(result).toEqual({ status: "cancelled", output: "" });
    // Release the stubbed transport so the shared worker drains cleanly.
    release.resolve(true);
  });

  test("an already-aborted signal cancels before any transport", async () => {
    // AbortSignal.timeout(0) yields an already-aborted signal without the
    // abort() primitives — workerd's abort()/AbortSignal.abort() inside the
    // vitest workers pool throws its own AbortError synchronously (runtime
    // quirk), while the executor contract under test is only signal.aborted.
    const signal = AbortSignal.timeout(0);
    const settled = Promise.withResolvers<true>();
    setTimeout(settled.resolve, 5);
    await settled.promise;
    expect(signal.aborted).toBe(true);
    const ctx = ctxWithConfig({ chain: ["brave"] }, {
      signal,
    });
    const result = await runWebSearchTool({ query: "q" }, ctx);
    expect(result).toEqual({ status: "cancelled", output: "" });
  });
});

// ---------------------------------------------------------------------------
// Public Web deadline race (omp providers/public.ts — 5s soft / 30s hard)
// ---------------------------------------------------------------------------

describe("M1.5/T12 — Public Web 5s/30s cutoff with straggler abort", () => {
  test("the aggregate returns at the soft deadline with one success; stragglers abort", async () => {
    const ddgRelease = Promise.withResolvers<true>();
    network.use(
      startpageHomeHandler,
      startpageSearchHandler,
      http.post("https://html.duckduckgo.com/html/", async () => {
        // Straggler: still parked when the aggregate decides to return.
        await ddgRelease.promise;
        return HttpResponse.html(DDG_HTML);
      }),
    );
    const result = await runWebSearchTool(
      { query: "race" },
      ctxWithConfig({ chain: ["public"] }, {
        publicDeadlines: { softMs: 500, hardMs: 2_000 },
      }),
    );
    expect(result.status).toBe("ok");
    // Startpage answered; the straggler ddg was cut at the soft deadline.
    expect(result.output).toContain("[1] Alpha result");
    expect(result.output).not.toContain("One & only");
    ddgRelease.resolve(true);
  });

  test("consensus merge dedups cross-engine URLs on the canonical key", async () => {
    network.use(
      startpageHomeHandler,
      http.post("https://www.startpage.com/sp/search", () =>
        HttpResponse.html(
          STARTPAGE_HTML.replace(
            "</body>",
            '<div class="result"><a class="result-link" href="https://example.com/one">Shared URL via startpage</a></div></body>',
          ),
        ),
      ),
      ddgHandler,
    );
    const result = await runWebSearchTool(
      { query: "dedup" },
      ctxWithConfig({ chain: ["public"] }, {
        publicDeadlines: { softMs: 2_000, hardMs: 8_000 },
      }),
    );
    // example.com/one appears in both engines (startpage fixture vs ddg's
    // uddg-unwrapped): merged into ONE consensus entry. omp mergeSources
    // keeps the better-ranked engine's title — ddg's rank 0 beats
    // startpage's rank 2, so the consensus line renders "One & only".
    const oneLines = result.output
      .split("\n")
      .filter((line) => line.includes("https://example.com/one"));
    expect(oneLines).toHaveLength(1);
    expect(result.output).toContain("[1] One & only");
    expect(result.output).not.toContain("Shared URL via startpage");
  });

  test("every public engine failing surfaces the aggregate failure", async () => {
    network.use(
      http.get(
        "https://www.startpage.com/",
        () =>
          new HttpResponse("captcha", { status: 503, headers: { "Content-Type": "text/plain" } }),
      ),
      // Tokenless GET fallback (homepage 503 → no form) handled locally too.
      http.get(
        "https://www.startpage.com/sp/search",
        () => new HttpResponse("down", { status: 503, headers: { "Content-Type": "text/plain" } }),
      ),
      http.post(
        "https://www.startpage.com/sp/search",
        () => new HttpResponse("down", { status: 503, headers: { "Content-Type": "text/plain" } }),
      ),
      http.post(
        "https://html.duckduckgo.com/html/",
        () => new HttpResponse("down", { status: 503, headers: { "Content-Type": "text/plain" } }),
      ),
    );
    const result = await runWebSearchTool(
      { query: "all fail" },
      ctxWithConfig({ chain: ["public"] }, {
        publicDeadlines: { softMs: 200, hardMs: 1_000 },
      }),
    );
    expect(result.status).toBe("ok");
    // Single aggregate failure: the message is unprefixed (omp format).
    // Failure order is settlement order (omp failures.push as engines
    // settle): ddg's single transport settles before startpage's
    // homepage→search two-step.
    expect(result.output).toBe(
      "Error: All public engines failed: duckduckgo: DuckDuckGo HTML error (503); startpage: Startpage HTML error (503)",
    );
  });
});

// ---------------------------------------------------------------------------
// DO-bound path — schema gate, engine surface wiring, replay consistency
// ---------------------------------------------------------------------------

function toolResultOf(events: readonly AnyAgentEvent[], threadId: string, tool: string) {
  const call = [...events]
    .reverse()
    .find((event) => event.type === "tool.call" && event.data.tool === tool);
  if (call?.type !== "tool.call") throw new Error(`no tool.call for ${tool}`);
  const executionId = executionIdFor(threadId, call.seq);
  const result = events.find(
    (event) => event.type === "tool.result" && event.data.executionId === executionId,
  );
  if (result?.type !== "tool.result") throw new Error(`no tool.result for ${tool}`);
  return { call, result };
}

describe("M1.5/T12 — edge execution end-to-end (replay consistency, zero daemon touches)", () => {
  test("web_search executes DO-locally over the MSW provider; replay answers from the journal", async () => {
    let startpageHits = 0;
    let ddgHits = 0;
    network.use(
      startpageHomeHandler,
      http.post("https://www.startpage.com/sp/search", () => {
        startpageHits += 1;
        return HttpResponse.html(STARTPAGE_HTML);
      }),
      http.post("https://html.duckduckgo.com/html/", () => {
        ddgHits += 1;
        return HttpResponse.html(DDG_HTML);
      }),
    );
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "web_search", arguments: { query: "fleet" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "ws-e2e",
      content: [{ type: "text", text: "search" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    const threadId = events[0]?.threadId;
    if (threadId === undefined) throw new Error("empty event list");

    // The default chain is [brave, public]: no brave key → public fan-out.
    const { result } = toolResultOf(events, threadId, "web_search");
    expect(result.data.status).toBe("ok");
    expect(result.data.exitCode).toBeNull();
    expect(result.data.output).toContain("[1] Alpha result");
    expect(startpageHits).toBe(1);
    expect(ddgHits).toBe(1);

    // Zero daemon touches: edge execution never leaves this DO.
    await expect(rig.service.journal()).resolves.toEqual([]);
    expect(events.some((event) => event.type === "tool.dispatch")).toBe(false);

    // Replay: eviction re-derives the identical log; the terminal executionId
    // re-dispatch answers from the journal — zero second outbound fetches.
    const before = events;
    await abortAllDurableObjects();
    const after = await rig.afterAbort(() => rig.events());
    expect(after.map((event) => [event.seq, event.type, event.id])).toEqual(
      before.map((event) => [event.seq, event.type, event.id]),
    );
    const { call } = toolResultOf(after, threadId, "web_search");
    const executionId = executionIdFor(threadId, call.seq);
    await runInDurableObject(rig.stub, async (instance) => {
      const seam = instance as unknown as {
        dispatchExecution: (turnId: string, executionId: string) => Promise<void>;
      };
      await seam.dispatchExecution(sent.turnId, executionId);
    });
    const replayed = await rig.events();
    expect(replayed).toHaveLength(after.length);
    const { result: replayResult } = toolResultOf(replayed, threadId, "web_search");
    expect(replayResult.data.output).toBe(result.data.output);
    expect(startpageHits).toBe(1);
    expect(ddgHits).toBe(1);
  });

  test("arguments validate against the registry row schema before any network surface", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "web_search", arguments: { recency: "fortnight" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "ws-schema",
      content: [{ type: "text", text: "bad args" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    const threadId = events[0]?.threadId;
    if (threadId === undefined) throw new Error("empty event list");
    const { result } = toolResultOf(events, threadId, "web_search");
    expect(result.data.status).toBe("error");
    expect(result.data.output).toContain("Invalid arguments");
  });
});
