import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractSurfaceObservation,
  walkVerdict,
  validateWalkSpec,
  walk,
  rawCdp,
  type WalkCdp,
  type WalkCdpEvent,
  type WalkCdpPageConn,
  type WalkCdpTarget,
  type WalkReport,
} from "../src/walk.js";

/**
 * L1 for #392 AP.walk (plugins/pm-harness/src/walk.ts). Same discipline as
 * the sibling suites: zero network — the browser facade is a scripted fake
 * injected through the `browser` option, the raw-CDP transport a scripted
 * fake through `cdp`, and the fetch fallback an injected fetchImpl; node:fs
 * is REAL but confined to a per-test tmpdir (evidence writing is the point).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pm-walk-test-"));
  delete process.env.PM_WALK_CDP_HTTP;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

interface FakeTabState {
  urlValue: string;
  titleValue: string;
  consoleEntries: { ts: number; level: string; text: string; location?: string }[];
  errorEntries: { ts: number; level: string; text: string; location?: string }[];
  requests: Record<string, unknown>[];
  counts: Record<string, number>;
  texts: Record<string, string>;
  screenshotPath: string | null;
}

interface FakeFacadeRecord {
  calls: string[];
  tabState: FakeTabState;
  existingHandleDies: boolean;
}

function fakeFacadeFrom(record: FakeFacadeRecord): unknown {
  const tab = (): Record<string, unknown> => ({
    url: () => Promise.resolve(record.tabState.urlValue),
    title: () => Promise.resolve(record.tabState.titleValue),
    goto: (target: string) => {
      record.calls.push(`goto:${target}`);
      record.tabState.urlValue = target;
      return Promise.resolve(undefined);
    },
    reload: () => {
      record.calls.push("reload");
      return Promise.resolve(undefined);
    },
    clearConsole: () => {
      record.calls.push("clearConsole");
      return Promise.resolve(undefined);
    },
    clearRequests: () => {
      record.calls.push("clearRequests");
      return Promise.resolve(undefined);
    },
    console: () =>
      Promise.resolve({ entries: record.tabState.consoleEntries, nextSeq: 1, dropped: 0 }),
    errors: () =>
      Promise.resolve({ entries: record.tabState.errorEntries, nextSeq: 1, dropped: 0 }),
    requests: () => Promise.resolve(record.tabState.requests),
    count: (selector: string) => Promise.resolve(record.tabState.counts[selector] ?? 0),
    text: (selector: string) => Promise.resolve(record.tabState.texts[selector] ?? ""),
    screenshot: () => Promise.resolve(record.tabState.screenshotPath),
    close: () => {
      record.calls.push("close");
      return Promise.resolve(undefined);
    },
  });
  const deadHandle = (): Record<string, unknown> => ({
    url: () => Promise.reject(new Error('Tab "x" is not alive.')),
  });
  return {
    open: (opts: { name: string; url?: string }) => {
      record.calls.push(`open:${opts.name}:${opts.url ?? ""}`);
      return Promise.resolve(tab());
    },
    tab: (name: string) => {
      record.calls.push(`tab:${name}`);
      return Promise.resolve(record.existingHandleDies ? deadHandle() : tab());
    },
  };
}

const BASE_STATE: FakeTabState = {
  urlValue: "https://staging.example/settings",
  titleValue: "Settings",
  consoleEntries: [],
  errorEntries: [],
  requests: [],
  counts: { "[data-section]": 2 },
  texts: { "[data-section]": "Providers" },
  screenshotPath: null,
};

// ---------------------------------------------------------------------------
// Pure surfaces
// ---------------------------------------------------------------------------

describe("walk spec validation (pure)", () => {
  it("rejects non-URLs, non-http(s) protocols, empty selectors, bad atLeast", () => {
    expect(() => {
      validateWalkSpec("not a url", []);
    }).toThrow(/not a valid URL/);
    expect(() => {
      validateWalkSpec("ftp://host/x", []);
    }).toThrow(/only http\(s\)/);
    expect(() => {
      validateWalkSpec("https://ok.example/", [{ selector: "  " }]);
    }).toThrow(/checks\[0\].selector/);
    expect(() => {
      validateWalkSpec("https://ok.example/", [{ selector: "a", atLeast: 0 }]);
    }).toThrow(/checks\[0\].atLeast/);
    expect(() => {
      validateWalkSpec("https://ok.example/", [{ selector: "a" }]);
    }).not.toThrow();
  });

  it("walkVerdict: checks all pass ∧ zero console errors", () => {
    const pass = { selector: "a", atLeast: 1, count: 2, passed: true, via: "dom" as const };
    expect(walkVerdict({ checks: [pass], consoleErrors: [] })).toBe(true);
    expect(walkVerdict({ checks: [{ ...pass, passed: false }], consoleErrors: [] })).toBe(false);
    expect(
      walkVerdict({
        checks: [pass],
        consoleErrors: [{ at: "t", kind: "console", text: "boom" }],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Facade path (the default surface)
// ---------------------------------------------------------------------------

describe("facade walk (injected fake browser)", () => {
  it("captures console + page errors, runs checks, writes evidence with sha256 anchor", async () => {
    const png = Buffer.from("89504e470d0a1a0a-fake", "utf8");
    const shotPath = join(workDir, "shot.webp");
    writeFileSync(shotPath, png);
    const record: FakeFacadeRecord = {
      calls: [],
      tabState: {
        ...BASE_STATE,
        consoleEntries: [
          {
            ts: 1_000,
            level: "error",
            text: "plugin crash: cannot read properties of undefined",
            location: "https://staging.example/app.js:1:1",
          },
          { ts: 2_000, level: "info", text: "hydrated" },
        ],
        errorEntries: [
          {
            ts: 3_000,
            level: "error",
            text: "Error: uncaught top-level",
            location: "https://staging.example/app.js:9:9",
          },
        ],
        requests: [
          { ts: 4_000, url: "https://staging.example/app.js", status: 200, ok: true },
          { ts: 5_000, url: "https://staging.example/missing.js", status: 404, ok: false },
        ],
        screenshotPath: shotPath,
      },
      existingHandleDies: true,
    };
    const report = await walk(
      "https://staging.example/settings",
      [{ selector: "[data-section]", atLeast: 2, text: "Providers" }],
      { browser: fakeFacadeFrom(record), outDir: join(workDir, "evidence"), now: new Date(0) },
    );

    expect(report.transport).toBe("browser");
    expect(report.ok).toBe(false); // console error present — the #387 face
    expect(report.checksPassed).toBe(true);
    expect(report.consoleErrors).toHaveLength(2);
    expect(report.consoleErrors[0]).toMatchObject({ kind: "console" });
    expect(report.consoleErrors[1]).toMatchObject({ kind: "exception" });
    expect(report.failedRequests).toEqual([
      { at: new Date(5_000).toISOString(), url: "https://staging.example/missing.js", status: 404 },
    ]);
    expect(report.screenshot).toMatchObject({ bytes: png.length, sha256: sha256(png) });
    expect(report.consoleCapture).toBe("captured");

    // Tab discipline: dead handle → open; fresh-load window; close at end.
    expect(record.calls[0]).toBe("tab:pm-walk");
    expect(record.calls).toContain("open:pm-walk:https://staging.example/settings");
    expect(record.calls).toContain("clearConsole");
    expect(record.calls).toContain("clearRequests");
    expect(record.calls).toContain("reload");
    expect(record.calls[record.calls.length - 1]).toBe("close");

    // Evidence on disk: report.json parses, anchor sha matches the bytes.
    expect(existsSync(report.evidence.report)).toBe(true);
    const onDisk = JSON.parse(readFileSync(report.evidence.report, "utf8")) as WalkReport;
    expect(onDisk.ok).toBe(false);
    const bytes = readFileSync(report.evidence.report);
    expect(report.evidence.anchor).toBe(`${report.evidence.report} sha256=${sha256(bytes)}`);
  });

  it("clean surface walks green: ok=true, verdict gated on consoleErrors", async () => {
    const record: FakeFacadeRecord = {
      calls: [],
      tabState: { ...BASE_STATE },
      existingHandleDies: false,
    };
    const report = await walk(
      "https://staging.example/settings",
      [{ selector: "[data-section]" }, { selector: "[data-missing]", atLeast: 1 }],
      { browser: fakeFacadeFrom(record), outDir: join(workDir, "evidence"), now: new Date(0) },
    );
    expect(report.ok).toBe(false); // the missing selector check failed
    expect(report.checks[1]).toMatchObject({ passed: false, count: 0 });
    expect(report.checks[1]?.why).toContain("expected ≥1 matches, saw 0");
    expect(report.consoleErrors).toHaveLength(0);

    const green = await walk("https://staging.example/settings", [{ selector: "[data-section]" }], {
      browser: fakeFacadeFrom(record),
      outDir: join(workDir, "evidence"),
      now: new Date(0),
      writeEvidence: false,
    });
    expect(green.ok).toBe(true);
    expect(green.evidence.anchor).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Raw-CDP path (the declarative bridge)
// ---------------------------------------------------------------------------

interface FakeCdpRecord {
  calls: string[];
  collected: WalkCdpEvent[];
  targets: WalkCdpTarget[];
  checkReplies: Record<string, { count: number; text: string | null }>;
}

function fakeCdp(record: FakeCdpRecord, finalHref: string, title: string): WalkCdp {
  const page: WalkCdpPageConn = {
    send: <T>(method: string, params: Record<string, unknown> = {}) => {
      record.calls.push(`${method}:${JSON.stringify(params).slice(0, 80)}`);
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression);
        if (expression.includes("window.name")) return Promise.resolve({} as T);
        if (expression.includes("document.location.href") && !expression.includes("title")) {
          // First probe = pre-navigation location of the fresh tab.
          return Promise.resolve({ result: { value: JSON.stringify("about:blank") } } as T);
        }
        if (expression.includes("{ href:")) {
          return Promise.resolve({
            result: { value: JSON.stringify({ href: finalHref, title }) },
          } as T);
        }
        // checkExpression: route by the selector literal inside the probe.
        for (const [selector, reply] of Object.entries(record.checkReplies)) {
          if (expression.includes(JSON.stringify(selector))) {
            return Promise.resolve({ result: { value: JSON.stringify(reply) } } as T);
          }
        }
        return Promise.reject(new Error(`fake cdp: unrouted evaluate ${expression.slice(0, 60)}`));
      }
      if (method === "Page.navigate" || method === "Page.reload") {
        record.collected.push({ method: "Page.loadEventFired", params: {}, at: 10_000 });
        return Promise.resolve({} as T);
      }
      if (method === "Page.captureScreenshot") {
        return Promise.resolve({
          data: Buffer.from("fake-png-bytes", "utf8").toString("base64"),
        } as T);
      }
      return Promise.resolve({} as T);
    },
    events: () => record.collected,
    waitEvent: () => Promise.resolve(undefined),
    close: () => {
      record.calls.push("close:ws");
    },
  };
  return {
    listTargets: () => Promise.resolve(record.targets),
    createTarget: (url: string) => {
      record.calls.push(`createTarget:${url}`);
      const target: WalkCdpTarget = {
        id: "t-new",
        type: "page",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://fake/devtools/page/t-new",
      };
      record.targets = [target];
      return Promise.resolve({ targetId: "t-new" });
    },
    attach: () => Promise.resolve(page),
  };
}

describe("raw CDP walk (injected transport, the bridge case)", () => {
  it("creates the marker tab, navigates, extracts events, screenshots, anchors", async () => {
    const record: FakeCdpRecord = {
      calls: [],
      collected: [
        {
          method: "Runtime.consoleAPICalled",
          params: { type: "error", args: [{ type: "string", value: "top-level crash" }] },
          at: 11_000,
        },
        {
          method: "Network.responseReceived",
          params: {
            requestId: "r1",
            response: { status: 500, url: "https://staging.example/app.js" },
          },
          at: 12_000,
        },
        {
          method: "Network.loadingFailed",
          params: { requestId: "r2", errorText: "net::ERR_FAILED" },
          at: 13_000,
        },
      ],
      targets: [],
      checkReplies: { "[data-section]": { count: 2, text: "Providers" } },
    };
    const report = await walk(
      "https://staging.example/settings",
      [{ selector: "[data-section]" }],
      {
        cdpHttp: "http://172.27.0.1:9222",
        cdp: fakeCdp(record, "https://staging.example/settings", "Settings"),
        outDir: join(workDir, "evidence"),
        now: new Date(0),
      },
    );
    expect(record.calls).toContain("createTarget:about:blank");
    expect(record.calls.some((c) => c.startsWith("Page.navigate:"))).toBe(true);
    expect(report.transport).toBe("cdp");
    expect(report.cdpHttp).toBe("http://172.27.0.1:9222");
    expect(report.tabName).toBe("pm-walk");
    expect(report.finalUrl).toBe("https://staging.example/settings");
    expect(report.title).toBe("Settings");
    expect(report.consoleErrors).toEqual([
      { at: new Date(11_000).toISOString(), kind: "console", text: "top-level crash" },
    ]);
    expect(report.failedRequests).toEqual([
      { at: new Date(12_000).toISOString(), url: "https://staging.example/app.js", status: 500 },
      { at: new Date(13_000).toISOString(), url: "(unknown)", errorText: "net::ERR_FAILED" },
    ]);
    expect(report.ok).toBe(false);
    expect(existsSync(report.screenshot?.file ?? "")).toBe(true);
    expect(report.screenshot?.file.endsWith(".png")).toBe(true);
  });

  it("rawCdp() is the exported bridge constructor with the documented shape", () => {
    const transport = rawCdp("http://172.27.0.1:9222");
    expect(typeof transport.listTargets).toBe("function");
    expect(typeof transport.createTarget).toBe("function");
    expect(typeof transport.attach).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// extractSurfaceObservation (pure)
// ---------------------------------------------------------------------------

describe("extractSurfaceObservation (pure)", () => {
  const at = (ms: number): number => ms;

  it("captures console.error + assert, exceptions, log errors; filters the rest", () => {
    const { consoleErrors } = extractSurfaceObservation(
      [
        {
          method: "Runtime.consoleAPICalled",
          params: { type: "error", args: [{ value: "a" }] },
          at: at(1),
        },
        {
          method: "Runtime.consoleAPICalled",
          params: { type: "log", args: [{ value: "noise" }] },
          at: at(2),
        },
        { method: "Runtime.consoleAPICalled", params: { type: "assert", args: [] }, at: at(3) },
        {
          method: "Runtime.exceptionThrown",
          params: {
            exceptionDetails: { text: "Uncaught", exception: { description: "Error: x" } },
          },
          at: at(4),
        },
        {
          method: "Log.entryAdded",
          params: { entry: { level: "warning", text: "slow" } },
          at: at(5),
        },
        {
          method: "Log.entryAdded",
          params: { entry: { level: "error", text: "bad", url: "https://x/a.js" } },
          at: at(6),
        },
      ],
      0,
    );
    expect(consoleErrors).toHaveLength(4);
    expect(consoleErrors.map((e) => e.kind)).toEqual(["console", "console", "exception", "log"]);
    expect(consoleErrors[3]).toMatchObject({ kind: "log", text: "bad", url: "https://x/a.js" });
  });

  it("correlates failed requests by requestId and caps at 200", () => {
    const events: WalkCdpEvent[] = [
      {
        method: "Network.requestWillBeSent",
        params: { requestId: "r9", request: { url: "https://x/slow.js", method: "GET" } },
        at: at(1),
      },
      {
        method: "Network.loadingFailed",
        params: { requestId: "r9", errorText: "net::ERR_TIMED_OUT" },
        at: at(2),
      },
    ];
    for (let i = 0; i < 250; i += 1) {
      events.push({
        method: "Network.responseReceived",
        params: {
          requestId: `c${String(i)}`,
          response: { status: 404, url: `https://x/${String(i)}.js` },
        },
        at: at(3),
      });
    }
    const { failedRequests } = extractSurfaceObservation(events, 0);
    expect(failedRequests).toHaveLength(200);
    expect(failedRequests[0]).toMatchObject({
      url: "https://x/slow.js",
      errorText: "net::ERR_TIMED_OUT",
    });
  });
});

// ---------------------------------------------------------------------------
// Fetch fallback (injected fetchImpl — zero network)
// ---------------------------------------------------------------------------

describe("fetch fallback (injected fetchImpl)", () => {
  const html = `<html><body><div data-section="a">Alpha</div></body></html>`;
  const fetchOk: typeof fetch = () => Promise.resolve(new Response(html, { status: 200 }));
  const fetchDown: typeof fetch = () => Promise.resolve(new Response("nope", { status: 503 }));

  it("raw-HTML checks with honest consoleCapture=unavailable", async () => {
    const report = await walk(
      "https://staging.example/settings",
      [{ selector: 'data-section="a"', text: "Alpha" }],
      {
        browser: null,
        allowFetchFallback: true,
        fetchImpl: fetchOk,
        outDir: join(workDir, "evidence"),
        now: new Date(0),
      },
    );
    expect(report.transport).toBe("fetch");
    expect(report.consoleCapture).toBe("unavailable");
    expect(report.consoleErrors).toEqual([]);
    expect(report.checksPassed).toBe(true);
    expect(report.checks[0]).toMatchObject({ via: "raw-html", count: 1, passed: true });
    expect(report.screenshot).toBeNull();
    expect(existsSync(report.evidence.report)).toBe(true);
  });

  it("non-ok status lands in failedRequests and fails the walk", async () => {
    const report = await walk("https://staging.example/settings", [], {
      browser: null,
      allowFetchFallback: true,
      fetchImpl: fetchDown,
      outDir: join(workDir, "evidence"),
      now: new Date(0),
    });
    expect(report.ok).toBe(false);
    expect(report.failedRequests).toEqual([
      { at: new Date(0).toISOString(), url: "https://staging.example/settings", status: 503 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Refusals — never a silent surface swap
// ---------------------------------------------------------------------------

describe("refusals", () => {
  it("no facade ∧ no fallback → topology-pointing error, zero writes", async () => {
    await expect(
      walk("https://staging.example/settings", [], { browser: null, now: new Date(0) }),
    ).rejects.toThrow(/kernel browser facade.*cdpHttp.*allowFetchFallback/s);
    expect(existsSync(join(workDir, ".pm-walk"))).toBe(false);
  });

  it("cdp transport failure surfaces the cause without a silent facade swap", async () => {
    const broken: WalkCdp = {
      listTargets: () => Promise.reject(new Error("bridge down")),
      createTarget: () => Promise.resolve({ targetId: "" }),
      attach: () => Promise.reject(new Error("unreachable")),
    };
    await expect(
      walk("https://staging.example/settings", [], {
        cdp: broken,
        cdpHttp: "http://172.27.0.1:9222",
        now: new Date(0),
      }),
    ).rejects.toThrow(/bridge down/);
  });
});
