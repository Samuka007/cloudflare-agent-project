/**
 * walk.ts — #392 the acceptance-probe surface: AP.walk(url, checks).
 *
 * The engineering discipline "UI: verify actual surface — visual proof" named
 * no execution surface: every lane improvised raw-CDP driving per ticket (the
 * scripts/accept/ jev family) and UI tickets drifted to closing on CI alone
 * (#390's finding). This module is the missing surface, one call:
 *
 *     const report = await walk(
 *       "https://cap-server-staging.../settings/plugins/cap-provider-config",
 *       [{ selector: "[data-testid]", atLeast: 1 }],
 *       { tabName: "l392-walk" },
 *     );
 *     // → report.ok, report.consoleErrors, report.failedRequests,
 *     //   report.evidence.anchor — the string AP.closeout's evidence field
 *     //   consumes (source:walk, gate #390).
 *
 * Evidence is the point: every walk writes `<outDir>/<stamp>-<slug>/` with
 * report.json (full observation: console errors, page errors, failed
 * requests, selector assertions, timings) plus the screenshot, and the
 * report carries a sha256 anchor so a closeout re-check can verify bytes.
 *
 * Transport ladder (2026-10-06 user ruling, supersedes the raw-CDP-first
 * draft): the eval-kernel `browser` global is the PREFERRED surface —
 * tool-inventory absence ≠ capability absence (probe `typeof globalThis.browser`
 * before declaring anything missing; that probe lesson is load-bearing):
 *   1. browser facade (managed headless Chromium — no GUI, default topology
 *      for non-gated faces). It covers everything walk needs: goto/reload,
 *      console + pageerror streams, request log, selector count/text,
 *      screenshot (observed live 2026-10-06).
 *   2. explicit `cdpHttp` — raw CDP against a caller-declared endpoint. The
 *      Windows Chrome bridge (launch-chrome.ps1 + portproxy, the human-login
 *      profile) for CF Access-gated faces is THE sanctioned use: declarative
 *      at the call site, never a silent default. This is the supplement on
 *      top of / beside the facade, not a replacement of it.
 *   3. `allowFetchFallback` — fetch + raw-HTML checks when no browser exists.
 *      Console capture is impossible there: the report says
 *      consoleCapture: "unavailable" so a gate can reject the evidence for a
 *      UI ticket instead of the honesty gap passing silently.
 *
 * Tab discipline (#240): the walk runs in a lane-owned named tab (the
 * facade's named-tab space; raw CDP targets the same name via the jev
 * `#__pm_walk:<tabName>` URL-marker recipe, disjoint marker family) — the
 * default tab and other lanes' tabs are never opened or probed. Lanes under
 * a browser lease pass their leased tab name; the walk closes its tab.
 *
 * Reuse note (anti-NIH 三问): the only in-repo CDP client is
 * scripts/accept/jev-loop.ts, and plugins→scripts would invert the package
 * dependency direction (pm-harness is imported BY scripts, jev-locate.ts:42
 * precedent). Same runtime (Node/Bun WebSocket), so the raw client below
 * follows the jev-loop recipe behind a structural seam (`WalkCdp`) that
 * tests inject fakes into.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One selector assertion: ≥atLeast matches (default 1), optional text
 *  substring on the first matched element. */
export interface WalkCheck {
  selector: string;
  atLeast?: number;
  text?: string;
}

/** One console-level error observation. `kind`: console = console.error,
 *  exception = uncaught page error, log = CDP Log-domain entry. */
export interface WalkConsoleEntry {
  at: string;
  kind: "console" | "exception" | "log";
  text: string;
  /** Source location when the backend provides one (facade: "url:line:col"). */
  url?: string;
}

/** One failed network observation: !ok on the request log (status ≥400 or a
 *  transport failure with failureText). */
export interface WalkFailedRequest {
  at: string;
  url: string;
  status?: number;
  errorText?: string;
}

/** Result of one check against the live surface. */
export interface WalkCheckResult {
  selector: string;
  atLeast: number;
  count: number;
  passed: boolean;
  /** Required text substring (echoed from the check). */
  text?: string;
  /** First matched element's text (whitespace-collapsed by the probe). */
  textSeen?: string | null;
  why?: string;
  /** fetch fallback: checks match raw markup, not the live DOM. */
  via?: "dom" | "raw-html";
}

/** The full walk observation — exactly what lands in report.json. */
export interface WalkReport {
  url: string;
  finalUrl: string;
  title: string;
  /** browser = the kernel facade (managed headless); cdp = raw CDP against
   *  `cdpHttp` (the Windows-bridge case); fetch = the honest downgrade. */
  transport: "browser" | "cdp" | "fetch";
  /** Raw-CDP endpoint when transport === "cdp", else "". */
  cdpHttp: string;
  tabName: string;
  ok: boolean;
  checksPassed: boolean;
  checks: WalkCheckResult[];
  consoleErrors: WalkConsoleEntry[];
  /** Fetch fallback cannot see the console — the honesty field a walk gate
   *  reads before accepting the evidence for a UI ticket. */
  consoleCapture: "captured" | "unavailable";
  failedRequests: WalkFailedRequest[];
  screenshot: { file: string; sha256: string; bytes: number } | null;
  evidence: { dir: string; report: string; anchor: string };
  startedAt: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Validation (pure — before any transport work, zero writes)
// ---------------------------------------------------------------------------

/** Throws with a caller-actionable message on a malformed walk spec. */
export function validateWalkSpec(url: string, checks: readonly WalkCheck[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`AP.walk: url is not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `AP.walk: only http(s) URLs are walkable, got ${parsed.protocol} — ${JSON.stringify(url)}`,
    );
  }
  for (const [i, check] of checks.entries()) {
    if (typeof check.selector !== "string" || check.selector.trim().length === 0) {
      throw new Error(`AP.walk: checks[${i}].selector must be a non-empty string`);
    }
    const atLeast = check.atLeast ?? 1;
    if (!Number.isInteger(atLeast) || atLeast < 1) {
      throw new Error(
        `AP.walk: checks[${i}].atLeast must be a positive integer, got ${String(atLeast)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Verdict (pure)
// ---------------------------------------------------------------------------

/** Walk verdict: every selector assertion passed AND the surface logged zero
 *  console-level errors. Failed network requests are recorded evidence but
 *  not fatal by default (optional assets 404 legitimately; the reviewer sees
 *  them in the report). */
export function walkVerdict(report: Pick<WalkReport, "checks" | "consoleErrors">): boolean {
  return report.checks.every((c) => c.passed) && report.consoleErrors.length === 0;
}

// ---------------------------------------------------------------------------
// Shared walk plumbing
// ---------------------------------------------------------------------------

export interface WalkOptions {
  /** Raw-CDP endpoint override — the DECLARATIVE path to the Windows Chrome
   *  bridge (http://172.27.0.1:9222, launch-chrome.ps1 + portproxy) for
   *  CF Access-gated faces needing the human-login profile. Omit to use the
   *  kernel browser facade (managed headless Chromium). Env:
   *  PM_WALK_CDP_HTTP forces the raw path session-wide. */
  cdpHttp?: string;
  /** Lane-owned tab identity (lease discipline #240). Default "pm-walk". */
  tabName?: string;
  /** Post-load settle time — SPA hydration/console noise window (ms). */
  settleMs?: number;
  /** Evidence root. Default ".pm-walk". */
  outDir?: string;
  /** Degrade to fetch + raw-HTML checks when no browser is reachable.
   *  Default false — a silent downgrade would fake a console capture. */
  allowFetchFallback?: boolean;
  /** Per-CDP-request timeout, raw path only (ms). Default 10_000. */
  timeoutMs?: number;
  /** Reference clock (tests inject). Default now. */
  now?: Date;
  /** Write evidence files. Default true. False still returns the report
   *  (anchor: "") — for probes that only want the verdict. */
  writeEvidence?: boolean;
  /** Facade injection (tests): replaces the globalThis.browser probe. */
  browser?: unknown;
  /** Raw-CDP transport injection (tests / relays). */
  cdp?: WalkCdp;
  /** fetch injection (tests). */
  fetchImpl?: typeof fetch;
}

const MARKER_PREFIX = "#__pm_walk:";
const FETCH_FALLBACK_MAX_BYTES = 2_000_000;
const MAX_ENTRIES = 200;

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, ms);
  return promise;
};

function slugifyUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "walk";
  }
  const raw = `${parsed.hostname}${parsed.pathname}`;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "walk";
}

function stripMarker(url: string): string {
  const idx = url.indexOf(MARKER_PREFIX);
  return idx === -1 ? url : url.slice(0, idx);
}

/** One transport's normalized observation; walk() assembles the report. */
interface WalkObservation {
  url: string;
  finalUrl: string;
  title: string;
  checks: WalkCheckResult[];
  consoleErrors: WalkConsoleEntry[];
  failedRequests: WalkFailedRequest[];
  /** Raw screenshot bytes (encoded as the backend produced them) or null. */
  screenshot: { bytes: Buffer; ext: string } | null;
}

// ---------------------------------------------------------------------------
// Facade path — the kernel `browser` global (preferred surface)
// ---------------------------------------------------------------------------

/** Structural view of the kernel browser global's surface walk uses. The
 *  facade is outside-controlled (kernel prelude), so every reply is narrowed
 *  at read time — shapes observed live 2026-10-06 on the headless backend. */
interface FacadeTab {
  url(): Promise<string>;
  title(): Promise<string>;
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  /** Present on the managed backend; absent handles degrade silently. */
  clearConsole?(): Promise<unknown>;
  clearRequests?(): Promise<unknown>;
  console(): Promise<unknown>;
  errors(): Promise<unknown>;
  requests(): Promise<unknown>;
  count(selector: string): Promise<number>;
  text(selector: string): Promise<string>;
  screenshot(): Promise<unknown>;
  close(): Promise<unknown>;
}

interface FacadeBrowser {
  open(opts: { name: string; url?: string }): Promise<unknown>;
  tab(name: string): Promise<unknown>;
}

/** The probe lesson (user ruling 2026-10-06): tool-inventory absence ≠
 *  capability absence — probe the global structurally before declaring the
 *  surface missing. */
function probeFacade(injected?: unknown): FacadeBrowser | null {
  // Explicit null opts OUT of the facade (tests); absence probes the global.
  const candidate =
    injected !== undefined ? injected : (globalThis as { browser?: unknown }).browser;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (!("open" in candidate) || typeof candidate.open !== "function") return null;
  if (!("tab" in candidate) || typeof candidate.tab !== "function") return null;
  // The single DI-boundary cast: the kernel prelude object, structurally
  // probed just above (ompi facade; shape observed live 2026-10-06).
  return candidate as FacadeBrowser;
}

/** Type guard for the outside-controlled tab handle: the calls walk makes. */
function isFacadeTab(value: unknown): value is FacadeTab {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "function" &&
    "goto" in value &&
    typeof value.goto === "function" &&
    "reload" in value &&
    typeof value.reload === "function" &&
    "console" in value &&
    typeof value.console === "function" &&
    "errors" in value &&
    typeof value.errors === "function" &&
    "requests" in value &&
    typeof value.requests === "function" &&
    "count" in value &&
    typeof value.count === "function" &&
    "text" in value &&
    typeof value.text === "function" &&
    "screenshot" in value &&
    typeof value.screenshot === "function" &&
    "close" in value &&
    typeof value.close === "function"
  );
}

/** find-or-open the lane's named tab; a stale handle (dead tab) reopens. */
async function facadeFindOrOpen(
  facade: FacadeBrowser,
  tabName: string,
  url: string,
): Promise<FacadeTab> {
  // browser.tab() returns the handle SYNCHRONOUSLY (observed live) — wrap
  // before .catch, and a dead tab's url() rejects → reopen below.
  const existing = await Promise.resolve(facade.tab(tabName)).catch(() => null);
  if (isFacadeTab(existing)) {
    const alive = await existing
      .url()
      .then(() => true)
      .catch(() => false);
    if (alive) return existing;
  }
  const opened = await facade.open({ name: tabName, url });
  if (!isFacadeTab(opened)) throw new Error("browser facade open() returned no tab surface");
  return opened;
}

/** Narrows a facade console()/errors() reply: { entries: [...] } — unknown
 *  boundary, so read-time guards instead of casts. */
function facadeEntries(
  reply: unknown,
): { ts: number; level: string; text: string; location?: string }[] {
  if (typeof reply !== "object" || reply === null || !("entries" in reply)) return [];
  const entries: unknown = reply.entries;
  if (!Array.isArray(entries)) return [];
  const out: { ts: number; level: string; text: string; location?: string }[] = [];
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.text !== "string" && !Array.isArray(rec.args)) continue;
    // The backend joins args with String() — objects become "[object
    // Object]". Re-render args as JSON for evidence-grade text.
    const args = Array.isArray(rec.args) ? rec.args : [];
    const rendered =
      args.length > 0
        ? args
            .map((a) => {
              if (typeof a === "string") return a;
              try {
                // Errors JSON-stringify to "{}" (non-enumerable props) —
                // fall back to String() for their message form.
                const json: unknown = JSON.stringify(a);
                if (typeof json === "string" && json !== "{}") return json;
              } catch {
                // not JSON-serializable — String() below
              }
              return String(a);
            })
            .join(" ")
        : typeof rec.text === "string"
          ? rec.text
          : "";
    out.push({
      ts: typeof rec.ts === "number" ? rec.ts : 0,
      level: typeof rec.level === "string" ? rec.level : "",
      text: rendered,
      ...(typeof rec.location === "string" ? { location: rec.location } : {}),
    });
  }
  return out;
}

/** Narrows a facade requests() reply row into a failed-request observation. */
function facadeFailedRequest(row: unknown): WalkFailedRequest | null {
  if (typeof row !== "object" || row === null) return null;
  const rec = row as Record<string, unknown>;
  if (rec.ok !== false) return null;
  if (typeof rec.url !== "string") return null;
  return {
    at: new Date(typeof rec.ts === "number" ? rec.ts : 0).toISOString(),
    url: rec.url,
    ...(typeof rec.status === "number" ? { status: rec.status } : {}),
    ...(typeof rec.failureText === "string" && rec.failureText.length > 0
      ? { errorText: rec.failureText }
      : {}),
  };
}

async function facadeEvaluateCheck(tab: FacadeTab, check: WalkCheck): Promise<WalkCheckResult> {
  const atLeast = check.atLeast ?? 1;
  const count = await tab.count(check.selector).catch(() => 0);
  let textSeen: string | null = null;
  if (count > 0) textSeen = await tab.text(check.selector).catch(() => null);
  const textOk = check.text === undefined || textSeen?.includes(check.text) === true;
  const passed = count >= atLeast && textOk;
  return {
    selector: check.selector,
    atLeast,
    count,
    passed,
    ...(check.text !== undefined ? { text: check.text, textSeen } : {}),
    ...(passed
      ? {}
      : {
          why:
            count < atLeast
              ? `expected ≥${String(atLeast)} matches, saw ${String(count)}`
              : `text ${JSON.stringify(check.text)} not in first match`,
        }),
    via: "dom",
  };
}

async function facadeWalk(
  facade: FacadeBrowser,
  url: string,
  checks: readonly WalkCheck[],
  opts: { tabName: string; settleMs: number; startedAtMs: number },
): Promise<WalkObservation> {
  const tab = await facadeFindOrOpen(facade, opts.tabName, url);
  try {
    await tab.goto(url);
    // Fresh-load observation window: clear, reload, settle — the console
    // stream then covers exactly this load (module-load crashes included).
    if (tab.clearConsole !== undefined) await tab.clearConsole();
    if (tab.clearRequests !== undefined) await tab.clearRequests();
    await tab.reload();
    await sleep(opts.settleMs);

    const finalUrl = await tab.url();
    const title = await tab.title().catch(() => "");

    const consoleErrors: WalkConsoleEntry[] = [];
    for (const entry of facadeEntries(await tab.console())) {
      if (entry.level !== "error") continue;
      consoleErrors.push({
        at: new Date(entry.ts).toISOString(),
        kind: "console",
        text: entry.text,
        ...(entry.location !== undefined ? { url: entry.location } : {}),
      });
    }
    for (const entry of facadeEntries(await tab.errors())) {
      if (entry.level !== "error") continue;
      consoleErrors.push({
        at: new Date(entry.ts).toISOString(),
        kind: "exception",
        text: entry.text,
        ...(entry.location !== undefined ? { url: entry.location } : {}),
      });
    }

    const requestReply: unknown = await tab.requests();
    const requestRows = Array.isArray(requestReply) ? requestReply : [];
    const failedRequests = requestRows
      .map(facadeFailedRequest)
      .filter((r): r is WalkFailedRequest => r !== null)
      .slice(0, MAX_ENTRIES);

    const checkResults: WalkCheckResult[] = [];
    for (const check of checks) checkResults.push(await facadeEvaluateCheck(tab, check));

    let screenshot: WalkObservation["screenshot"] = null;
    const shotPath = await tab.screenshot().catch(() => null);
    if (typeof shotPath === "string" && shotPath.length > 0) {
      const bytes = readFileSync(shotPath);
      const dot = shotPath.lastIndexOf(".");
      screenshot = { bytes, ext: dot >= 0 ? shotPath.slice(dot + 1) : "png" };
    }

    return {
      url,
      finalUrl: stripMarker(finalUrl),
      title,
      checks: checkResults,
      consoleErrors: consoleErrors.slice(0, MAX_ENTRIES),
      failedRequests,
      screenshot,
    };
  } finally {
    await tab.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Raw-CDP path — the declarative bridge (Windows Chrome for Access faces)
// ---------------------------------------------------------------------------

/** /json/list entry (CDP HTTP boundary shape). */
export interface WalkCdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface WalkCdpEvent {
  method: string;
  params: Record<string, unknown>;
  at: number;
}

/** One attached page-target connection. */
export interface WalkCdpPageConn {
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  events(): readonly WalkCdpEvent[];
  /** Resolves when the next `method` event arrives; rejects on timeout. */
  waitEvent(method: string, timeoutMs: number): Promise<void>;
  close(): void;
}

/** Browser-level transport: discovery, tab creation, page attachment. */
export interface WalkCdp {
  listTargets(): Promise<WalkCdpTarget[]>;
  createTarget(url: string): Promise<{ targetId: string }>;
  attach(target: WalkCdpTarget): Promise<WalkCdpPageConn>;
}

interface WsConn {
  readonly readyState: number;
  send(data: string): unknown;
  close(): unknown;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (ev: unknown) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (ev: unknown) => void,
  ): void;
}

function connectWs(url: string, timeoutMs: number): Promise<WsConn> {
  const { promise, resolve, reject } = Promise.withResolvers<WsConn>();
  // Bun's global WebSocket narrowed to the structural subset used here (the
  // jev-loop.ts:241 boundary precedent).
  const ws = new WebSocket(url) as unknown as WsConn;
  const timer = setTimeout(() => {
    try {
      ws.close();
    } catch {
      // already gone
    }
    reject(new Error(`CDP WS open timeout after ${String(timeoutMs)}ms: ${url}`));
  }, timeoutMs);
  const onOpen = (): void => {
    clearTimeout(timer);
    ws.removeEventListener("open", onOpen);
    ws.removeEventListener("error", onError);
    resolve(ws);
  };
  const onError = (ev: unknown): void => {
    clearTimeout(timer);
    reject(new Error(`CDP WS error on ${url}: ${wsErrorMessage(ev)}`));
  };
  ws.addEventListener("open", onOpen);
  ws.addEventListener("error", onError);
  return promise;
}

function wsErrorMessage(ev: unknown): string {
  if (ev !== null && typeof ev === "object" && "message" in ev) return String(ev.message);
  return "unknown error";
}

async function rawListTargets(
  http: string,
  timeoutMs: number,
  attempts = 3,
): Promise<WalkCdpTarget[]> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${http}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`GET /json/list ${String(res.status)}`);
      // CDP HTTP boundary (jev-loop.ts:271 precedent — shape per protocol docs).
      return (await res.json()) as WalkCdpTarget[];
    } catch (error) {
      lastError = error;
      await sleep(250 * (i + 1));
    }
  }
  throw new Error(`CDP discovery failed at ${http}: ${String(lastError)}`);
}

/** One request over a short-lived browser-level WS (Target.createTarget). */
async function rawCreateTarget(
  http: string,
  url: string,
  timeoutMs: number,
): Promise<{ targetId: string }> {
  const version = (await (await fetch(`${http}/json/version`)).json()) as {
    webSocketDebuggerUrl?: string;
  };
  if (typeof version.webSocketDebuggerUrl !== "string")
    throw new Error("browser-level webSocketDebuggerUrl missing");
  const ws = await connectWs(version.webSocketDebuggerUrl, timeoutMs);
  try {
    const { promise, resolve, reject } = Promise.withResolvers<{ targetId: string }>();
    const onMsg = (ev: unknown): void => {
      if (ev === null || typeof ev !== "object" || !("data" in ev)) return;
      const data = ev.data;
      if (typeof data !== "string" || !data.includes('"id":1')) return;
      // CDP reply boundary — parsed JSON narrowed per protocol shape.
      const msg = JSON.parse(data) as {
        result?: { targetId?: string };
        error?: { message: string };
      };
      if (msg.error !== undefined)
        reject(new Error(`CDP Target.createTarget: ${msg.error.message}`));
      else resolve({ targetId: msg.result?.targetId ?? "" });
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url } }));
    const result = await promise;
    if (result.targetId.length === 0) throw new Error("Target.createTarget returned no targetId");
    return result;
  } finally {
    ws.close();
  }
}

class RawCdpPage implements WalkCdpPageConn {
  private nextId = 0;
  private readonly pending = new Map<number, PromiseWithResolvers<unknown>>();
  private readonly collected: WalkCdpEvent[] = [];
  private readonly waiters: { method: string; resolve: () => void }[] = [];

  constructor(
    private readonly ws: WsConn,
    private readonly timeoutMs: number,
  ) {
    ws.addEventListener("message", (ev: unknown) => {
      if (ev === null || typeof ev !== "object" || !("data" in ev)) return;
      const data: unknown = ev.data;
      if (typeof data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== "object") return;
      // CDP message boundary — the JSON-RPC envelope shape (protocol docs);
      // field-level guards below, never member access before a guard.
      const msg = parsed as {
        id?: unknown;
        result?: unknown;
        error?: { message?: unknown };
        method?: unknown;
        params?: unknown;
      };
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (entry === undefined) return;
        const err = msg.error?.message;
        if (typeof err === "string") entry.reject(new Error(`CDP ${String(msg.id)}: ${err}`));
        else entry.resolve(msg.result);
        return;
      }
      if (typeof msg.method === "string") {
        const params =
          msg.params !== null && typeof msg.params === "object"
            ? (msg.params as Record<string, unknown>)
            : {};
        const event: WalkCdpEvent = { method: msg.method, params, at: Date.now() };
        this.collected.push(event);
        for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
          const waiter = this.waiters[i];
          if (waiter?.method === msg.method) {
            this.waiters.splice(i, 1);
            waiter.resolve();
          }
        }
      }
    });
    ws.addEventListener("close", () => {
      for (const [, entry] of this.pending) entry.reject(new Error("CDP WS closed"));
      this.pending.clear();
    });
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.ws.readyState !== 1) throw new Error(`CDP WS not open for ${method}`);
    const id = ++this.nextId;
    const entry = Promise.withResolvers<unknown>();
    this.pending.set(id, entry);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      entry.reject(new Error(`CDP ${method} timeout after ${String(this.timeoutMs)}ms`));
    }, this.timeoutMs + 20_000);
    try {
      this.ws.send(JSON.stringify({ id, method, params }));
      return (await entry.promise) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  events(): readonly WalkCdpEvent[] {
    return this.collected;
  }

  async waitEvent(method: string, timeoutMs: number): Promise<void> {
    if (this.collected.some((e) => e.method === method)) return;
    // A load-event timeout fails the walk loudly (the surface did not load);
    // the zero-arg wrapper keeps the waiter slot `() => void`.
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    const waiter = {
      method,
      resolve: () => {
        resolve(undefined);
      },
    };
    this.waiters.push(waiter);
    const timer = setTimeout(() => {
      const idx = this.waiters.indexOf(waiter);
      if (idx >= 0) this.waiters.splice(idx, 1);
      reject(new Error(`CDP event ${method} timeout after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    try {
      await promise;
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
}

/** Raw CDP against a running Chromium/Chrome at `http` — never launches a
 *  browser; topology is the caller's declaration (the bridge case). */
export function rawCdp(http: string, timeoutMs = 10_000): WalkCdp {
  return {
    listTargets: () => rawListTargets(http, timeoutMs),
    createTarget: (url) => rawCreateTarget(http, url, timeoutMs),
    async attach(target) {
      if (
        typeof target.webSocketDebuggerUrl !== "string" ||
        target.webSocketDebuggerUrl.length === 0
      )
        throw new Error(`target ${target.id} has no webSocketDebuggerUrl`);
      const ws = await connectWs(target.webSocketDebuggerUrl, timeoutMs);
      return new RawCdpPage(ws, timeoutMs);
    },
  };
}

const CHECK_FN_PREFIX = "/*__pmWalkCheck*/";

function checkExpression(selector: string): string {
  return `${CHECK_FN_PREFIX} (() => {
"use strict";
const nodes = document.querySelectorAll(${JSON.stringify(selector)});
const first = nodes[0];
const text = first ? (first.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200) : null;
return JSON.stringify({ count: nodes.length, text });
})()`;
}

interface RawCheckReply {
  count: number;
  text: string | null;
}

async function evaluateJson<T>(page: WalkCdpPageConn, expression: string): Promise<T> {
  const reply = await page.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>("Runtime.evaluate", { expression, returnByValue: true });
  if (reply.exceptionDetails !== undefined) {
    const detail = reply.exceptionDetails;
    throw new Error(`in-page probe threw: ${detail.exception?.description ?? detail.text}`);
  }
  if (typeof reply.result?.value !== "string")
    throw new Error("in-page probe returned no JSON string");
  return JSON.parse(reply.result.value) as T;
}

async function rawEvaluateCheck(page: WalkCdpPageConn, check: WalkCheck): Promise<WalkCheckResult> {
  const atLeast = check.atLeast ?? 1;
  try {
    const reply = await evaluateJson<RawCheckReply>(page, checkExpression(check.selector));
    const textOk = check.text === undefined || reply.text?.includes(check.text) === true;
    const passed = reply.count >= atLeast && textOk;
    return {
      selector: check.selector,
      atLeast,
      count: reply.count,
      passed,
      ...(check.text !== undefined ? { text: check.text, textSeen: reply.text } : {}),
      ...(passed
        ? {}
        : {
            why:
              reply.count < atLeast
                ? `expected ≥${String(atLeast)} matches, saw ${String(reply.count)}`
                : `text ${JSON.stringify(check.text)} not in first match`,
          }),
      via: "dom",
    };
  } catch (error) {
    return {
      selector: check.selector,
      atLeast,
      count: 0,
      passed: false,
      ...(check.text !== undefined ? { text: check.text } : {}),
      why: `evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      via: "dom",
    };
  }
}

/** Narrows one CDP event param value by `in`/typeof guards (no cast-access). */
function paramAt(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = params[key];
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

/** Extracts the observation out of the collected CDP event stream: console
 *  errors + uncaught exceptions + Log-domain errors, and failed network
 *  (status ≥400 or loadingFailed, requestId-correlated). */
export function extractSurfaceObservation(
  events: readonly WalkCdpEvent[],
  startedAtMs: number,
): { consoleErrors: WalkConsoleEntry[]; failedRequests: WalkFailedRequest[] } {
  const consoleErrors: WalkConsoleEntry[] = [];
  const failedRequests: WalkFailedRequest[] = [];
  const requestUrls = new Map<string, string>();
  for (const event of events) {
    const at = new Date(event.at || startedAtMs).toISOString();
    const p = event.params;
    switch (event.method) {
      case "Runtime.consoleAPICalled": {
        if (p.type !== "error" && p.type !== "assert") break;
        const args = Array.isArray(p.args) ? p.args : [];
        const text = args.map(cdpArgText).join(" ").trim();
        if (text.length === 0 && p.type !== "assert") break;
        consoleErrors.push({ at, kind: "console", text: text || "(empty console.error)" });
        break;
      }
      case "Runtime.exceptionThrown": {
        const detail = paramAt(p, "exceptionDetails");
        const exception = paramAt(detail ?? {}, "exception");
        const described =
          exception !== undefined && typeof exception.description === "string"
            ? exception.description
            : undefined;
        const text =
          described ?? (typeof detail?.text === "string" ? detail.text : "(unknown exception)");
        const entry: WalkConsoleEntry = { at, kind: "exception", text };
        if (typeof detail?.url === "string") entry.url = detail.url;
        consoleErrors.push(entry);
        break;
      }
      case "Log.entryAdded": {
        const entry = paramAt(p, "entry");
        if (entry?.level !== "error") break;
        const record: WalkConsoleEntry = {
          at,
          kind: "log",
          text: typeof entry.text === "string" ? entry.text : "(empty log error)",
        };
        if (typeof entry.url === "string") record.url = entry.url;
        consoleErrors.push(record);
        break;
      }
      case "Network.requestWillBeSent": {
        const request = paramAt(p, "request");
        if (typeof p.requestId === "string" && typeof request?.url === "string")
          requestUrls.set(p.requestId, request.url);
        break;
      }
      case "Network.responseReceived": {
        const response = paramAt(p, "response");
        if (typeof response?.status !== "number" || response.status < 400) break;
        let url = "(unknown)";
        if (typeof response.url === "string") url = response.url;
        else if (typeof p.requestId === "string") url = requestUrls.get(p.requestId) ?? "(unknown)";
        failedRequests.push({ at, url, status: response.status });
        break;
      }
      case "Network.loadingFailed": {
        const url =
          typeof p.requestId === "string"
            ? (requestUrls.get(p.requestId) ?? "(unknown)")
            : "(unknown)";
        const record: WalkFailedRequest = { at, url };
        if (typeof p.errorText === "string") record.errorText = p.errorText;
        failedRequests.push(record);
        break;
      }
      default:
        break;
    }
  }
  return {
    consoleErrors: consoleErrors.slice(0, MAX_ENTRIES),
    failedRequests: failedRequests.slice(0, MAX_ENTRIES),
  };
}

function cdpArgText(arg: unknown): string {
  if (arg === null || typeof arg !== "object") return String(arg);
  const rec = arg as Record<string, unknown>;
  if (typeof rec.description === "string" && rec.description.length > 0) return rec.description;
  if ("value" in rec) {
    const value = rec.value;
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return "unserializable";
    }
  }
  const preview = paramAt(rec, "preview");
  if (preview !== undefined && Array.isArray(preview.properties)) {
    const props: unknown[] = preview.properties;
    const parts: string[] = [];
    for (const prop of props) {
      if (typeof prop !== "object" || prop === null) continue;
      // CDP RemoteObject preview boundary — narrow per property.
      const record = prop as { name?: unknown; value?: unknown };
      const name = typeof record.name === "string" ? record.name : "?";
      const value = typeof record.value === "string" ? record.value : "?";
      parts.push(`${name}: ${value}`);
    }
    return parts.join(", ");
  }
  if (Object.keys(rec).length === 0) return "{}";
  try {
    return JSON.stringify(rec);
  } catch {
    return "unserializable";
  }
}

async function rawCdpWalk(
  url: string,
  checks: readonly WalkCheck[],
  opts: { transport: WalkCdp; tabName: string; settleMs: number; startedAtMs: number },
): Promise<WalkObservation> {
  const marker = `${MARKER_PREFIX}${opts.tabName}`;
  const targets = await opts.transport.listTargets();
  let mine = targets.find(
    (t) =>
      t.type === "page" && typeof t.webSocketDebuggerUrl === "string" && t.url.includes(marker),
  );
  if (mine === undefined) {
    const created = await opts.transport.createTarget("about:blank");
    const relisted = await opts.transport.listTargets();
    mine = relisted.find((t) => t.id === created.targetId);
    if (mine === undefined) throw new Error(`created target ${created.targetId} not in /json/list`);
  }
  const page = await opts.transport.attach(mine);
  try {
    // Subscribe before acting: the console/network stream must cover the load.
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Log.enable");
    await page.send("Network.enable");
    await page.send("Runtime.evaluate", {
      expression: `window.name = ${JSON.stringify(opts.tabName)}; undefined;`,
    });

    const wanted = `${url}${marker}`;
    const currentHref = await evaluateJson<string>(
      page,
      `${CHECK_FN_PREFIX} JSON.stringify(document.location.href)`,
    );
    if (stripMarker(currentHref) !== url) {
      await page.send("Page.navigate", { url: wanted });
    } else {
      await page.send("Page.reload");
    }
    await page.waitEvent("Page.loadEventFired", 30_000);
    await sleep(opts.settleMs);

    const meta = await evaluateJson<{ href: string; title: string }>(
      page,
      `${CHECK_FN_PREFIX} JSON.stringify({ href: document.location.href, title: document.title })`,
    );
    const checkResults: WalkCheckResult[] = [];
    for (const check of checks) checkResults.push(await rawEvaluateCheck(page, check));

    const shot = await page.send<{ data?: string }>("Page.captureScreenshot", { format: "png" });
    const png = typeof shot.data === "string" ? Buffer.from(shot.data, "base64") : Buffer.alloc(0);

    const observation = extractSurfaceObservation(page.events(), opts.startedAtMs);
    return {
      url,
      finalUrl: stripMarker(meta.href),
      title: meta.title,
      checks: checkResults,
      consoleErrors: observation.consoleErrors,
      failedRequests: observation.failedRequests,
      screenshot: png.length > 0 ? { bytes: png, ext: "png" } : null,
    };
  } finally {
    page.close();
  }
}

// ---------------------------------------------------------------------------
// Fetch fallback — the honest downgrade
// ---------------------------------------------------------------------------

/** fetch + raw-HTML checks; console capture impossible, and the report says
 *  so (consoleCapture: "unavailable"). */
async function fetchWalk(
  url: string,
  checks: readonly WalkCheck[],
  opts: { fetchImpl: typeof fetch; now: Date },
): Promise<WalkObservation> {
  const res = await opts.fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  const body = res.ok ? (await res.text()).slice(0, FETCH_FALLBACK_MAX_BYTES) : "";
  const failedRequests: WalkFailedRequest[] = [];
  if (!res.ok)
    failedRequests.push({ at: opts.now.toISOString(), url: res.url || url, status: res.status });
  const checkResults: WalkCheckResult[] = checks.map((check) => {
    const atLeast = check.atLeast ?? 1;
    const count = body.split(check.selector).length - 1;
    const textOk = check.text === undefined || body.includes(check.text);
    const passed = count >= atLeast && textOk;
    return {
      selector: check.selector,
      atLeast,
      count,
      passed,
      ...(check.text !== undefined ? { text: check.text } : {}),
      ...(passed
        ? {}
        : {
            why:
              count < atLeast
                ? `raw markup has ${String(count)} occurrence(s), expected ≥${String(atLeast)}`
                : `text ${JSON.stringify(check.text)} not in raw HTML`,
          }),
      via: "raw-html" as const,
    };
  });
  return {
    url,
    finalUrl: res.url || url,
    title: "",
    checks: checkResults,
    consoleErrors: [],
    failedRequests,
    screenshot: null,
  };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Walk one URL on the real surface and leave ledger-able evidence.
 * See the module doc for the transport ladder and the evidence layout.
 */
export async function walk(
  url: string,
  checks: readonly WalkCheck[] = [],
  opts: WalkOptions = {},
): Promise<WalkReport> {
  validateWalkSpec(url, checks);
  const startedAtMs = (opts.now ?? new Date()).getTime();
  const startedAt = new Date(startedAtMs).toISOString();
  const tabName = opts.tabName ?? "pm-walk";
  const settleMs = opts.settleMs ?? 3_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const runOpts = { tabName, settleMs, startedAtMs };
  let observation: WalkObservation;
  let transport: WalkReport["transport"];
  let cdpHttp = "";

  const rawEndpoint = opts.cdpHttp ?? process.env.PM_WALK_CDP_HTTP;
  const forcedRaw = opts.cdp ?? (rawEndpoint !== undefined ? rawCdp(rawEndpoint, timeoutMs) : null);
  if (forcedRaw !== null) {
    cdpHttp = rawEndpoint ?? "";
    transport = "cdp";
    try {
      observation = await rawCdpWalk(url, checks, { ...runOpts, transport: forcedRaw });
    } catch (error) {
      return degradeOrThrow(url, checks, opts, startedAtMs, startedAt, tabName, error);
    }
  } else {
    const facade = probeFacade(opts.browser);
    if (facade === null) {
      return degradeOrThrow(
        url,
        checks,
        opts,
        startedAtMs,
        startedAt,
        tabName,
        new Error("no browser facade on globalThis"),
      );
    }
    transport = "browser";
    try {
      observation = await facadeWalk(facade, url, checks, runOpts);
    } catch (error) {
      return degradeOrThrow(url, checks, opts, startedAtMs, startedAt, tabName, error);
    }
  }

  return assembleReport({
    observation,
    transport,
    cdpHttp,
    tabName,
    url,
    startedAt,
    startedAtMs,
    outDir: opts.outDir,
    writeEvidence: opts.writeEvidence !== false,
  });
}

/** The failure branch: honest fetch downgrade when allowed, otherwise a
 *  topology-pointing error (never a silent surface swap). */
function degradeOrThrow(
  url: string,
  checks: readonly WalkCheck[],
  opts: WalkOptions,
  startedAtMs: number,
  startedAt: string,
  tabName: string,
  cause: unknown,
): Promise<WalkReport> {
  if (opts.allowFetchFallback !== true) {
    throw new Error(
      `AP.walk: surface unavailable (${cause instanceof Error ? cause.message : String(cause)}) — ` +
        `default surface is the kernel browser facade (managed headless Chromium); for an ` +
        `Access-gated face pass cdpHttp (the Windows Chrome bridge, launch-chrome.ps1 + portproxy), ` +
        `or allowFetchFallback for the fetch+raw-HTML surface (no console capture)`,
    );
  }
  return fetchWalk(url, checks, {
    fetchImpl: opts.fetchImpl ?? fetch,
    now: new Date(startedAtMs),
  }).then((observation) =>
    assembleReport({
      observation,
      transport: "fetch",
      cdpHttp: "",
      tabName,
      url,
      startedAt,
      startedAtMs,
      outDir: opts.outDir,
      writeEvidence: opts.writeEvidence !== false,
    }),
  );
}

interface AssembleArgs {
  observation: WalkObservation;
  transport: WalkReport["transport"];
  cdpHttp: string;
  tabName: string;
  url: string;
  startedAt: string;
  startedAtMs: number;
  outDir?: string;
  writeEvidence: boolean;
}

/** Observation → WalkReport: verdict, evidence dir, sha256 anchor. */
function assembleReport(args: AssembleArgs): WalkReport {
  const { observation } = args;
  const checksPassed = observation.checks.every((c) => c.passed);
  // On the fetch surface the status line IS the page load — a non-ok fetch
  // means the surface is down (CDP paths leave failed requests as recorded
  // evidence without failing the walk; optional assets 404 legitimately).
  const fetchSurfaceDown = args.transport === "fetch" && observation.failedRequests.length > 0;
  const report: WalkReport = {
    url: args.url,
    finalUrl: observation.finalUrl,
    title: observation.title,
    transport: args.transport,
    cdpHttp: args.cdpHttp,
    tabName: args.tabName,
    ok: checksPassed && observation.consoleErrors.length === 0 && !fetchSurfaceDown,
    checksPassed,
    checks: observation.checks,
    consoleErrors: observation.consoleErrors,
    consoleCapture: args.transport === "fetch" ? "unavailable" : "captured",
    failedRequests: observation.failedRequests,
    screenshot: null,
    evidence: { dir: "", report: "", anchor: "" },
    startedAt: args.startedAt,
    durationMs: Date.now() - args.startedAtMs,
  };

  if (!args.writeEvidence) return report;

  const stamp = new Date(args.startedAtMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dir = join(args.outDir ?? ".pm-walk", `${stamp}-${slugifyUrl(args.url)}`);
  mkdirSync(dir, { recursive: true });

  if (observation.screenshot !== null && observation.screenshot.bytes.length > 0) {
    const file = join(dir, `screenshot.${observation.screenshot.ext}`);
    writeFileSync(file, observation.screenshot.bytes);
    report.screenshot = {
      file,
      sha256: createHash("sha256").update(observation.screenshot.bytes).digest("hex"),
      bytes: observation.screenshot.bytes.length,
    };
  }

  const reportPath = join(dir, "report.json");
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(reportPath, reportBytes);
  report.evidence = {
    dir,
    report: reportPath,
    anchor: `${reportPath} sha256=${createHash("sha256").update(reportBytes).digest("hex")}`,
  };
  return report;
}
