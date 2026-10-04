/**
 * #34 final mile — ONE continuous full-chain run, driven externally:
 *
 *   composed worker (AgentDO + REAL DaemonServiceDO, wrangler dev)
 *     + REAL daemon client process (packages/daemon-service client, Bun)
 *     + real bash in /tmp/poc-sandbox
 *     + live glm-5.3 over the Anthropic-protocol relay
 *
 *  1. wrangler dev up (packages/agent-do/wrangler.hookup.jsonc)
 *  2. real client process: enroll → session/open → WS → boot.announce → sync
 *  3. turn 1 (external POST /drive): model runs `echo poc-$(date +%s)` via bash
 *  4. full event sequence asserted from the log; tool.result carries the REAL
 *     bash output; turn.completed answer echoes the marker
 *  5. disconnect drill: SIGKILL the client mid-exec → the watchdog re-asks →
 *     explicit host_offline tool.result (no hang) → turn terminates
 *  6. client restart → reconcile (kill-list → OUTCOME_UNKNOWN) → next turn
 *     runs clean end-to-end
 *  7. transcript → /tmp/poc-full-chain-transcript.txt
 *
 * Env: reads repo-root .dev.vars (MODEL_RELAY_*). Absent relay env → clear
 * message + exit 0 so CI skips the live parts. The sandbox is /tmp/poc-sandbox
 * and nothing here touches production machines.
 *
 * Run: `bun scripts/poc-full-chain.ts` (repo root).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const AGENT_PACKAGE = join(ROOT, "packages", "agent-do");
const CLIENT_PACKAGE = join(ROOT, "packages", "daemon-service");
const PORT = 8791;
const SANDBOX = "/tmp/poc-sandbox";
const DATA_DIR = "/tmp/poc-full-chain-data";
const HOST_KEY = "[REDACTED-staging-secret]";
const ENROLL_KEY = "[REDACTED-staging-secret]";
const TRANSCRIPT_PATH = "/tmp/poc-full-chain-transcript.txt";
const STAGING_NAME = "agent-do-poc-staging";
const STAGING_DATA_DIR = "/tmp/poc-full-chain-staging-data";
/** Overridden by the staging leg (deployed workers.dev URL). */
let baseUrl = `http://127.0.0.1:${PORT}`;
let threadId = `thr_poc_full_${Date.now().toString(36)}`;
/** Drill timing: re-ask fires at lastDispatchAt + execTimeoutMs + execGraceMs. */
const WATCHDOG = {
  execTimeoutMs: 20_000,
  execGraceMs: 5_000,
  turnWatchdogMs: 240_000,
  modelCallCapMs: 150_000,
};

interface AgentEvent {
  seq: number;
  id: string;
  threadId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

const transcript: string[] = [];
const clientLines: string[] = [];
const wranglerLines: string[] = [];

let wrangler: ChildProcess | null = null;
let client: ChildProcess | null = null;

function log(message: string): void {
  console.log(`[poc] ${message}`);
  transcript.push(message);
}

function note(line: string): void {
  transcript.push(line);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Polls `predicate` until it yields a non-null value (that value is the
 * result); boolean predicates simply yield `true`. Keeps closure-produced
 * results in the return channel instead of captured `let` variables, whose
 * static types the compiler cannot see through.
 */
async function waitFor<T>(
  predicate: () => Promise<T | null>,
  what: string,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result !== null) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

/** Auth defaults plus per-call headers, merged without array-index spread. */
function driveHeaders(extra: RequestInit["headers"]): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${HOST_KEY}`,
  });
  for (const [name, value] of new Headers(extra)) headers.set(name, value);
  return headers;
}

/** Reads repo-root .dev.vars (simple KEY=VALUE lines, comments allowed). */
function devVars(): Record<string, string> {
  const path = join(ROOT, ".dev.vars");
  if (!existsSync(path)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  let text = "";
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: driveHeaders(init?.headers),
    });
    status = response.status;
    text = await response.text();
    if (response.ok) break;
    // A wrangler dev hot reload (sibling lanes touch node_modules) can serve
    // one transient bad response; record and retry before giving up.
    log(`WARN ${path}: HTTP ${status} (attempt ${attempt + 1}) — ${text.slice(0, 120)}`);
    if (attempt < 2) await sleep(1500);
  }
  try {
    return { status, body: JSON.parse(text) as unknown };
  } catch {
    note("## wrangler log tail (at failure)");
    for (const line of wranglerLines.slice(-40)) note(line);
    throw new Error(`${path}: non-JSON (HTTP ${status}): ${text.slice(0, 300)}`);
  }
}

async function events(sinceSeq = 0): Promise<{ events: AgentEvent[]; latestSeq: number }> {
  const { status, body } = await fetchJson(`/drive/${threadId}/events?sinceSeq=${sinceSeq}`);
  if (status !== 200 || typeof body !== "object" || body === null || !("events" in body)) {
    throw new Error(`/drive events HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body as { events: AgentEvent[]; latestSeq: number };
}

async function driveTurn(text: string, clientRequestId: string): Promise<string> {
  const { status, body } = await fetchJson(`/drive/${threadId}`, {
    method: "POST",
    body: JSON.stringify({ text, clientRequestId }),
  });
  if (status !== 200 || typeof body !== "object" || body === null || !("turnId" in body)) {
    throw new Error(`drive POST HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return (body as { turnId: string }).turnId;
}

async function waitTurnTerminal(
  turnId: string,
  sinceSeq: number,
  timeoutMs: number,
): Promise<{ events: AgentEvent[]; latestSeq: number }> {
  let snapshot: AgentEvent[] = [];
  let latestSeq = sinceSeq;
  await waitFor(
    async () => {
      const page = await events(sinceSeq);
      snapshot = page.events;
      latestSeq = page.latestSeq;
      return snapshot.some(
        (event) =>
          (event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.cancelled") &&
          event.data.turnId === turnId,
      );
    },
    `terminal event of ${turnId}`,
    timeoutMs,
  );
  return { events: snapshot, latestSeq };
}

const EVENT_SEQUENCE_TYPES = [
  "thread.created",
  "turn.input",
  "model.call_started",
  "model.call_completed",
  "tool.call",
  "tool.dispatch",
  "tool.result",
  "turn.completed",
] as const;

/** Asserts the ordered presence of the core event kinds in one turn's slice. */
function assertCoreSequence(slice: AgentEvent[], label: string, firstOnThread = false): void {
  const types = slice.map((event) => event.type);
  let cursor = 0;
  for (const wanted of EVENT_SEQUENCE_TYPES) {
    if (wanted === "thread.created" && !firstOnThread) continue;
    const found = types.indexOf(wanted, cursor);
    if (found === -1) {
      throw new Error(
        `${label}: expected ${wanted} after position ${cursor}, got ${types.join(" → ")}`,
      );
    }
    cursor = found + 1;
  }
  const execEvents = types.filter((type) => type === "tool.exec_started" || type === "tool.output");
  if (execEvents.length === 0) {
    throw new Error(`${label}: no tool.exec_started/tool.output events — was bash really run?`);
  }
}

function terminalEventOf(slice: AgentEvent[], turnId: string): AgentEvent {
  const terminal = slice.find(
    (event) =>
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.cancelled") &&
      event.data.turnId === turnId,
  );
  if (terminal === undefined) throw new Error(`no terminal event for ${turnId}`);
  return terminal;
}

/** Text of the FINAL model call in the slice (the turn's answer). */
function finalTextOf(slice: AgentEvent[]): string {
  const completed = slice.filter((event) => event.type === "model.call_completed");
  const last = completed.at(-1);
  if (last === undefined) return "";
  const text = last.data.text;
  return typeof text === "string" ? text : "";
}

function sliceOf(all: AgentEvent[], sinceSeq: number): AgentEvent[] {
  return all.filter((event) => event.seq > sinceSeq);
}

function renderEvents(slice: AgentEvent[]): string[] {
  const t0 = slice[0]?.createdAt ?? 0;
  return slice.map((event) => {
    const data = { ...event.data };
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (typeof value === "string" && value.length > 200) data[key] = `${value.slice(0, 200)}…`;
    }
    return `  +${((event.createdAt - t0) / 1000).toFixed(1)}s #${event.seq} ${event.type} ${JSON.stringify(data)}`;
  });
}

function startWrangler(): ChildProcess {
  // workerd's BoringSSL trust probing finds no root store on NixOS — the
  // hookup vitest config points it at the system bundle; same here.
  const caBundle = "/etc/ssl/certs/ca-certificates.crt";
  const child = spawn(
    join(AGENT_PACKAGE, "node_modules", ".bin", "wrangler"),
    ["dev", "-c", "wrangler.hookup.jsonc", "--port", String(PORT), "--ip", "127.0.0.1"],
    {
      cwd: AGENT_PACKAGE,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG: "warn",
        ...(existsSync(caBundle) ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? caBundle } : {}),
      },
    },
  );
  child.stderr.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8");
    wranglerLines.push(line.trimEnd());
    process.stderr.write(`[wrangler] ${line}`);
  });
  return child;
}

function startClient(base: string, dataDir: string): ChildProcess {
  const child = spawn(
    "bun",
    ["src/client/index.ts", "--url", base, "--dataDir", dataDir, "--sandbox", SANDBOX],
    {
      cwd: CLIENT_PACKAGE,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DAEMON_ENROLL_KEY: ENROLL_KEY },
    },
  );
  child.stdout.on("data", (chunk: Buffer) => {
    captureClient("client", chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    captureClient("client!", chunk);
  });
  return child;
}

function captureClient(prefix: string, chunk: Buffer): void {
  for (const line of chunk.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    clientLines.push(`[${prefix}] ${line}`);
    process.stdout.write(`[poc-${prefix}] ${line}\n`);
  }
}

async function sessionSynced(): Promise<boolean> {
  const { body } = await fetchJson("/agent/session");
  const session = (body as { session: { syncing: boolean } | null }).session;
  return session !== null && !session.syncing;
}

async function journalOps(executionId: string): Promise<string> {
  const { body } = await fetchJson(`/agent/journal?executionId=${encodeURIComponent(executionId)}`);
  const ops = (body as { ops: { kind: string; at: number }[] }).ops;
  return ops.map((op) => op.kind).join(" → ");
}

function teardown(): void {
  client?.kill("SIGKILL");
  wrangler?.kill("SIGTERM");
}

async function main(): Promise<void> {
  const vars = devVars();
  const relayBase = vars.MODEL_RELAY_BASE_URL_ANTHROPIC;
  const relayKey = vars.MODEL_RELAY_API_KEY;
  if (relayBase === undefined || relayBase === "" || relayKey === undefined || relayKey === "") {
    console.log(
      "[poc] SKIPPED: MODEL_RELAY_BASE_URL_ANTHROPIC / MODEL_RELAY_API_KEY missing from repo-root .dev.vars — live full-chain POC needs the relay env; CI runs the hookup vitest instead.",
    );
    return;
  }
  const relayModel = vars.MODEL_RELAY_MODEL ?? "glm-5.3";

  note(`# poc-full-chain transcript — ${new Date().toISOString()}`);
  note(`thread: ${threadId}`);
  note(`relay model: ${relayModel} (thinking disabled, maxTokens 8192)`);
  note(`worker: ${AGENT_PACKAGE} wrangler.hookup.jsonc port ${PORT}`);
  note(`sandbox: ${SANDBOX}`);

  // Fresh rig state: durable DO storage + client identity + sandbox.
  mkdirSync(SANDBOX, { recursive: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(join(AGENT_PACKAGE, ".wrangler", "state"), { recursive: true, force: true });
  // wrangler dev loads .dev.vars next to the wrangler config; regenerate it
  // from the repo-root file (gitignored at every depth).
  writeFileSync(
    join(AGENT_PACKAGE, ".dev.vars"),
    [
      `MODEL_RELAY_BASE_URL_ANTHROPIC=${relayBase}`,
      `MODEL_RELAY_API_KEY=${relayKey}`,
      `MODEL_RELAY_MODEL=${relayModel}`,
      `AGENT_DO_WATCHDOG=${JSON.stringify(WATCHDOG)}`,
      "",
    ].join("\n"),
  );

  // 1. Composed worker up.
  log("starting composed worker (wrangler dev) …");
  wrangler = startWrangler();
  await waitFor(
    async () => {
      try {
        return (await fetch(`${baseUrl}/health`)).ok;
      } catch {
        return false;
      }
    },
    "wrangler dev /health",
    90_000,
  );
  log("composed worker is up (AgentDO + real DaemonServiceDO)");

  // 2. REAL daemon client process.
  log("starting real daemon client (bun process) …");
  client = startClient(baseUrl, DATA_DIR);
  await waitFor(sessionSynced, "client enroll → session → sync complete", 60_000);
  log("client enrolled, connected, reconciled (hostId=local, sandbox-confined)");

  // 3. Turn 1 — external drive, live model, real bash.
  const sinceTurn1 = 0;
  log("driving turn 1: run echo poc-$(date +%s) via bash …");
  const turn1 = await driveTurn(
    "Use the bash tool to run exactly this command, then report the exact output line it printed: echo poc-$(date +%s)",
    "poc-drive-turn-1",
  );
  const { events: turn1All, latestSeq: turn1Latest } = await waitTurnTerminal(
    turn1,
    sinceTurn1,
    180_000,
  );
  const turn1Slice = sliceOf(turn1All, sinceTurn1);
  assertCoreSequence(turn1Slice, "turn 1", true);
  note("");
  note(`## turn 1 events (${turn1})`);
  for (const line of renderEvents(turn1Slice)) note(line);

  const turn1Result = turn1Slice.find((event) => event.type === "tool.result");
  const turn1RawOutput = turn1Result?.data.output;
  const turn1Output = typeof turn1RawOutput === "string" ? turn1RawOutput : "";
  const markerMatch = /poc-(\d+)/.exec(turn1Output);
  if (turn1Result?.data.status !== "ok") {
    throw new Error(`turn 1 tool.result not ok: ${JSON.stringify(turn1Result?.data)}`);
  }
  if (markerMatch === null) {
    throw new Error(
      `turn 1 tool.result output has no poc-<epoch> marker: ${JSON.stringify(turn1Output)}`,
    );
  }
  const marker = markerMatch[0];
  const turn1Final = finalTextOf(turn1Slice);
  if (!turn1Final.includes(marker)) {
    throw new Error(
      `turn 1 final model answer does not echo ${marker}: ${JSON.stringify(turn1Final.slice(0, 400))}`,
    );
  }
  log(
    `turn 1 OK: real bash produced ${marker}; final answer echoes it (${turn1Slice.length} events)`,
  );

  // 4. Disconnect drill — kill the client mid-exec.
  const drillCommand = "sleep 120 && echo late-drill";
  log(`driving drill turn: run \`${drillCommand}\`, then killing the client mid-exec …`);
  const drillSince = turn1Latest;
  const drillTurn = await driveTurn(
    `Use the bash tool to run exactly this command and report its output: ${drillCommand}`,
    "poc-drive-drill",
  );
  const drillExecId = await waitFor(
    async () => {
      const page = await events(drillSince);
      const started = page.events.find((event) => event.type === "tool.exec_started");
      return started ? String(started.data.executionId) : null;
    },
    "drill tool.exec_started",
    60_000,
  );
  client.kill("SIGKILL");
  client = null;
  const killAt = Date.now();
  log(
    `client SIGKILLed mid-exec (drill execution ${drillExecId} left orphaned) — turn must fail explicitly, not hang`,
  );

  const { events: drillAll, latestSeq: drillLatest } = await waitTurnTerminal(
    drillTurn,
    drillSince,
    280_000,
  );
  const drillSlice = sliceOf(drillAll, drillSince);
  note("");
  note(`## drill turn events (${drillTurn}) — client killed at ${new Date(killAt).toISOString()}`);
  for (const line of renderEvents(drillSlice)) note(line);

  const drillResult = drillSlice.find((event) => event.type === "tool.result");
  const reasks = drillSlice.filter(
    (event) => event.type === "tool.dispatch" && Number(event.data.attempt ?? 1) > 1,
  );
  if (drillResult?.data.status !== "error") {
    throw new Error(
      `drill: expected explicit error tool.result, got ${JSON.stringify(drillResult?.data)}`,
    );
  }
  if (String(drillResult.data.output) !== "host_offline") {
    note(
      `drill: error output is ${JSON.stringify(drillResult.data.output)} (expected host_offline)`,
    );
  }
  const drillTerminal = terminalEventOf(drillSlice, drillTurn);
  const drillSeconds = Math.round((Date.now() - killAt) / 1000);
  log(
    `drill OK: explicit error (tool.result status=error output=${JSON.stringify(drillResult.data.output)}), ` +
      `${reasks.length} re-ask(s), terminal=${drillTerminal.type} — ${drillSeconds}s after the kill, no hang`,
  );
  const drillFinal = finalTextOf(drillSlice);
  note(`drill final answer: ${JSON.stringify(drillFinal.slice(0, 400))}`);

  // 5. Client restart → reconcile; journal shows the kill-list judgment.
  log("restarting client (new bootId; identity persisted) …");
  client = startClient(baseUrl, DATA_DIR);
  await waitFor(sessionSynced, "restarted client session sync", 60_000);
  log("client reconnected and reconciled");
  try {
    const drillJournal = await journalOps(drillExecId);
    note(`drill execution journal: ${drillJournal}`);
    log(`drill journal: ${drillJournal}`);
  } catch (error) {
    note(
      `drill journal read failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 6. Post-restart turn runs clean.
  log("driving post-restart turn: echo poc-clean-restart …");
  const cleanSince = drillLatest;
  const cleanTurn = await driveTurn(
    "Use the bash tool to run exactly this command, then report the exact output line it printed: echo poc-clean-restart",
    "poc-drive-clean-2",
  );
  const { events: cleanAll } = await waitTurnTerminal(cleanTurn, cleanSince, 180_000);
  const cleanSlice = sliceOf(cleanAll, cleanSince);
  assertCoreSequence(cleanSlice, "post-restart turn");
  note("");
  note(`## post-restart turn events (${cleanTurn})`);
  for (const line of renderEvents(cleanSlice)) note(line);
  const cleanResult = cleanSlice.find((event) => event.type === "tool.result");
  if (
    cleanResult?.data.status !== "ok" ||
    String(cleanResult.data.output).trim() !== "poc-clean-restart"
  ) {
    throw new Error(`post-restart turn not clean: ${JSON.stringify(cleanResult?.data)}`);
  }
  const cleanFinal = finalTextOf(cleanSlice);
  if (!cleanFinal.includes("poc-clean-restart")) {
    throw new Error(
      `post-restart final answer missing marker: ${JSON.stringify(cleanFinal.slice(0, 400))}`,
    );
  }
  log("post-restart turn OK: clean end-to-end roundtrip after the drill");

  await stagingLeg(vars, marker);

  note("");
  note("## client process log");
  for (const line of clientLines) note(line);
  note("");
  note("## summary");
  note(`turn1 marker (real bash output): ${marker}`);
  note(
    `drill: tool.result status=error, output=${JSON.stringify(drillResult.data.output)}, terminal=${drillTerminal.type}, ${drillSeconds}s`,
  );
  note(`post-restart: clean roundtrip, output poc-clean-restart`);
  log("POC FULL CHAIN OK");
}

/** Deploys the hookup rig as a staging worker and drives one live turn against it. */
async function stagingLeg(vars: Record<string, string>, marker: string): Promise<void> {
  note("");
  note("## staging leg");
  const token = process.env.CLOUDFLARE_API_TOKEN ?? vars.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? vars.CLOUDFLARE_ACCOUNT_ID;
  if (token === undefined || token === "" || accountId === undefined || accountId === "") {
    log("staging leg SKIPPED: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID absent");
    return;
  }
  let url: string;
  try {
    url = await deployStaging(token, accountId, vars);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`staging leg STOPPED: deploy rejected — ${message.split("\n").slice(-3).join(" | ")}`);
    return;
  }
  log(`staging deployed at ${url} — driving one live turn against it …`);
  const localBase = baseUrl;
  const localThread = threadId;
  baseUrl = url;
  threadId = `thr_poc_stage_${Date.now().toString(36)}`;
  try {
    // Readiness = the DO-backed route answering JSON, not just /health: a
    // fresh deploy propagates its workers.dev route for a few seconds.
    await waitFor(
      async () => {
        try {
          const response = await fetch(`${url}/agent/session`, {
            headers: { authorization: `Bearer ${HOST_KEY}` },
          });
          return (
            response.ok && ((await response.json()) as { session: unknown }).session !== undefined
          );
        } catch {
          return false;
        }
      },
      "staging DO-backed readiness",
      90_000,
    );
    rmSync(STAGING_DATA_DIR, { recursive: true, force: true });
    client = startClient(url, STAGING_DATA_DIR);
    await waitFor(sessionSynced, "staging client enroll → sync", 60_000);
    const stagingTurn = await driveTurn(
      "Use the bash tool to run exactly this command, then report the exact output line it printed: echo poc-staging-$(date +%s)",
      "poc-drive-staging",
    );
    const { events: stagingAll } = await waitTurnTerminal(stagingTurn, 0, 180_000);
    const stagingSlice = sliceOf(stagingAll, 0);
    assertCoreSequence(stagingSlice, "staging turn", true);
    for (const line of renderEvents(stagingSlice)) note(line);
    const stagingResult = stagingSlice.find((event) => event.type === "tool.result");
    const stagingRawOutput = stagingResult?.data.output;
    const stagingOutput = (typeof stagingRawOutput === "string" ? stagingRawOutput : "").trim();
    const stageMarker = /poc-staging-\d+/.exec(stagingOutput)?.[0];
    if (stagingResult?.data.status !== "ok" || stageMarker === undefined) {
      throw new Error(`staging tool.result not ok: ${JSON.stringify(stagingResult?.data)}`);
    }
    const stagingFinal = finalTextOf(stagingSlice);
    if (!stagingFinal.includes(stageMarker)) {
      throw new Error(`staging final answer does not echo ${stageMarker}`);
    }
    log(
      `staging turn OK: real bash produced ${stageMarker} on the deployed worker (local marker was ${marker})`,
    );
    note(`staging marker: ${stageMarker}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`staging drive FAILED: ${message.split("\n")[0]}`);
  } finally {
    client?.kill("SIGKILL");
    client = null;
    baseUrl = localBase;
    threadId = localThread;
  }
  try {
    await captureWrangler(["delete", "--name", STAGING_NAME], token, accountId, "y\n");
    log(`staging worker ${STAGING_NAME} deleted (relay key not left on the edge)`);
  } catch (error) {
    log(
      `staging delete FAILED (manual cleanup needed): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `wrangler deploy` with the relay/watchdog vars inline; resolves the URL. */
async function deployStaging(
  token: string,
  accountId: string,
  vars: Record<string, string>,
): Promise<string> {
  const args = [
    "deploy",
    "-c",
    "wrangler.hookup.jsonc",
    "--name",
    STAGING_NAME,
    "--var",
    `MODEL_RELAY_BASE_URL_ANTHROPIC:${vars.MODEL_RELAY_BASE_URL_ANTHROPIC}`,
    "--var",
    `MODEL_RELAY_API_KEY:${vars.MODEL_RELAY_API_KEY}`,
    "--var",
    `MODEL_RELAY_MODEL:${vars.MODEL_RELAY_MODEL ?? "glm-5.3"}`,
    "--var",
    `AGENT_DO_WATCHDOG:${JSON.stringify(WATCHDOG)}`,
  ];
  const out = await captureWrangler(args, token, accountId);
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(out)?.[0];
  if (url === undefined) throw new Error(`no workers.dev URL in deploy output: ${out.slice(-600)}`);
  return url;
}

/** Runs one wrangler CLI invocation, returning combined output; rejects non-zero. */
async function captureWrangler(
  args: string[],
  token: string,
  accountId: string,
  stdin?: string,
): Promise<string> {
  const child = spawn(join(AGENT_PACKAGE, "node_modules", ".bin", "wrangler"), args, {
    cwd: AGENT_PACKAGE,
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      WRANGLER_SEND_METRICS: "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const { promise, resolve } = Promise.withResolvers<number>();
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.on("close", (code) => {
    resolve(code ?? -1);
  });
  if (stdin !== undefined) child.stdin.write(stdin);
  child.stdin.end();
  const code = await promise;
  if (code !== 0) throw new Error(`${args[0]} exit ${code}: ${out.slice(-1200)}`);
  return out;
}

main()
  .then(() => {
    writeFileSync(TRANSCRIPT_PATH, `${transcript.join("\n")}\n`);
    console.log(`[poc] transcript written to ${TRANSCRIPT_PATH}`);
    teardown();
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(`[poc] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
    writeFileSync(TRANSCRIPT_PATH, `${transcript.join("\n")}\n`);
    console.error(`[poc] partial transcript written to ${TRANSCRIPT_PATH}`);
    teardown();
    process.exit(1);
  });
