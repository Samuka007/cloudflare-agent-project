/**
 * Local smoke for the daemon-service half of #34 (run: `bun scripts/poc-smoke-service.ts`).
 *
 * Proves THIS package end-to-end on a real socket path:
 *   wrangler dev → real client (Bun, /tmp/poc-sandbox) → fake agent-caller
 *   (plain HTTP to /agent/*) → echo/date/ls roundtrips → journal verified →
 *   mid-exec client kill → explicit orphan handling → restart → kill-list →
 *   OUTCOME_UNKNOWN → next dispatch works.
 *
 * The agent half (agent DO, real model loop) integrates on top of the same
 * seam at the combined-chain step; here the /agent/* HTTP projection of the
 * DO RPC seam drives dispatch/kill/ack exactly as the agent DO would.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Journal op rows as the smoke reads them (structural — the script must not
// pull the Workers-typed journal module into the Bun/Node type context).
interface OpRow {
  opSeq: number;
  kind: string;
  executionId?: string;
  verified?: boolean;
}

// Run from packages/daemon-service (bun scripts/poc-smoke-service.ts).
const PACKAGE = process.cwd();
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const SANDBOX = "/tmp/poc-sandbox";
const DATA_DIR = "/tmp/poc-daemon-smoke-data";
const HOST_KEY = "[REDACTED-staging-secret]";
const ENROLL_KEY = "[REDACTED-staging-secret]";
const THREAD_ID = "thr_smoke";

interface DispatchOutcomeResponse {
  kind: "accepted" | "completed_cached" | "host_offline";
}

interface AgentUpdate {
  kind: string;
  executionId: string;
  result?: { status: string; output: string };
}

let wrangler: ChildProcess | null = null;
let client: ChildProcess | null = null;
const clientLines: string[] = [];

function log(message: string): void {
  console.log(`[smoke] ${message}`);
}

function captureClientLines(prefix: string, chunk: Buffer): void {
  for (const line of chunk.toString().split("\n")) {
    if (line.trim() === "") continue;
    clientLines.push(`${prefix} ${line}`);
    console.log(`[client] ${line}`);
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${what}`);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, ms);
  return promise;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${HOST_KEY}` },
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${HOST_KEY}` } });
}

async function journal(executionId?: string): Promise<OpRow[]> {
  const response = await get(
    `/agent/journal${executionId ? `?executionId=${encodeURIComponent(executionId)}` : ""}`,
  );
  return ((await response.json()) as { ops: OpRow[] }).ops;
}

async function sinkUpdates(): Promise<AgentUpdate[]> {
  const response = await get(`/agent-sink/updates?threadId=${THREAD_ID}`);
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `agent-sink updates: non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || !("updates" in parsed)) {
    throw new Error(
      `agent-sink updates: unexpected body (HTTP ${response.status}): ${text.slice(0, 300)}`,
    );
  }
  const updates = parsed.updates;
  if (!Array.isArray(updates)) {
    throw new Error(`agent-sink updates: not an array: ${text.slice(0, 300)}`);
  }
  return updates as AgentUpdate[];
}

async function dispatch(executionId: string, command: string): Promise<DispatchOutcomeResponse> {
  const response = await post("/agent/dispatch", {
    threadId: THREAD_ID,
    turnId: `${THREAD_ID}-turn`,
    executionId,
    machineId: "poc-local",
    tool: "bash",
    arguments: { command },
    timeoutMs: 60_000,
  });
  return (await response.json()) as DispatchOutcomeResponse;
}

function startClient(prefix: string): ChildProcess {
  const child = spawn(
    "bun",
    ["src/client/index.ts", "--url", BASE, "--dataDir", DATA_DIR, "--sandbox", SANDBOX],
    {
      cwd: PACKAGE,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DAEMON_ENROLL_KEY: ENROLL_KEY },
    },
  );
  child.stdout.on("data", (chunk: Buffer) => {
    captureClientLines(prefix, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    captureClientLines(`${prefix}!`, chunk);
  });
  return child;
}

/** Finds the surviving orphan bash via its DAEMON_EXEC_MARKER environ. */
function findMarkerOrphanPid(): number {
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      if (readFileSync(`/proc/${pid}/environ`).toString("utf8").includes("DAEMON_EXEC_MARKER=1")) {
        return pid;
      }
    } catch {
      // gone or not readable — skip
    }
  }
  throw new Error("no marker orphan found — the explicit-abort drill did not leave one");
}

async function main(): Promise<void> {
  mkdirSync(SANDBOX, { recursive: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
  // Fresh DO storage each run: the journal is durable across wrangler dev
  // restarts by design, so a rerun must not trip completed_cached dedup.
  rmSync(join(PACKAGE, ".wrangler", "state"), { recursive: true, force: true });

  // 1. wrangler dev up.
  log("starting wrangler dev …");
  const wranglerBin = join(PACKAGE, "node_modules", ".bin", "wrangler");
  wrangler = spawn(wranglerBin, ["dev", "--port", String(PORT), "--ip", "127.0.0.1"], {
    cwd: PACKAGE,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  wrangler.stderr?.on("data", (chunk: Buffer) =>
    process.stderr.write(`[wrangler] ${chunk.toString()}`),
  );
  await waitFor(async () => {
    try {
      return (await fetch(`${BASE}/health`)).ok;
    } catch {
      return false;
    }
  }, "wrangler dev /health");
  log("wrangler dev is up");

  // 2. Real client process (Bun) — enroll → open → attach → announce.
  log("starting daemon client …");
  client = startClient("boot1");
  await waitFor(async () => {
    try {
      const session = (
        (await (await get("/agent/session")).json()) as { session: { syncing: boolean } | null }
      ).session;
      return session !== null && !session.syncing;
    } catch {
      return false;
    }
  }, "client session reconciled");
  log("client enrolled, connected, reconciled");

  // 3. Roundtrips: echo / date / ls — the issue-34 acceptance commands.
  const commands = ["echo poc-$(date +%s)", "date", "ls -la"];
  const roundtripIds: string[] = [];
  for (const [index, command] of commands.entries()) {
    const executionId = `${THREAD_ID}:${index + 1}`;
    roundtripIds.push(executionId);
    log(`dispatch ${executionId}: ${command}`);
    const outcome = await dispatch(executionId, command);
    if (outcome.kind !== "accepted")
      throw new Error(`dispatch ${executionId} → ${JSON.stringify(outcome)}`);
    await waitFor(
      async () => (await journal(executionId)).some((op) => op.kind === "exited"),
      `exit of ${executionId}`,
    );
  }

  // 4. Journal + agent-sink verification.
  for (const executionId of roundtripIds) {
    const ops = await journal(executionId);
    const kinds = ops.map((op) => op.kind);
    log(`${executionId} journal: ${kinds.join(" → ")}`);
    if (!kinds.includes("dispatch") || !kinds.includes("spawn_ack") || !kinds.includes("exited")) {
      throw new Error(`${executionId} journal incomplete: ${kinds.join(",")}`);
    }
  }
  const exits = (await sinkUpdates()).filter((update) => update.kind === "exited");
  if (exits.length !== roundtripIds.length) {
    throw new Error(`expected ${roundtripIds.length} agent results, got ${exits.length}`);
  }
  for (const update of exits) {
    if (update.result?.status !== "ok") throw new Error(`non-ok result: ${JSON.stringify(update)}`);
  }
  log(`all ${roundtripIds.length} roundtrips ok; results reached the agent sink`);

  // 5. Mid-exec kill drill: kill the client while a sleeper runs.
  log("dispatching long sleeper, then killing the client mid-exec …");
  const sleeperId = `${THREAD_ID}:99`;
  const sleeperOutcome = await dispatch(sleeperId, "sleep 25 && echo late");
  if (sleeperOutcome.kind !== "accepted")
    throw new Error(`sleeper dispatch → ${JSON.stringify(sleeperOutcome)}`);
  await waitFor(
    async () => (await journal(sleeperId)).some((op) => op.kind === "spawn_ack"),
    "sleeper spawn",
  );
  client.kill("SIGKILL");
  client = null;
  log("client killed mid-exec — sleeper stays RUNNING, turn not hung");

  // The orphan bash survives (explicit-abort policy: disconnect kills nothing).
  await sleep(1000);
  const orphanPid = findMarkerOrphanPid();
  log(`orphan bash survived the client kill (marker pid ${orphanPid})`);

  // 6. Restart the client: new bootId → kill-list → SIGKILL → OUTCOME_UNKNOWN.
  log("restarting client (new bootId) …");
  client = startClient("boot2");
  await waitFor(
    async () => (await journal(sleeperId)).some((op) => op.kind === "outcome_unknown"),
    "sleeper judged OUTCOME_UNKNOWN via kill-list",
  );
  const sleeperOps = await journal(sleeperId);
  log(`sleeper journal: ${sleeperOps.map((op) => op.kind).join(" → ")}`);
  const killReceipt = sleeperOps.find((op) => op.kind === "kill_receipt");
  if (killReceipt?.kind !== "kill_receipt" || killReceipt.verified !== true) {
    throw new Error(`kill-list receipt not verified: ${JSON.stringify(killReceipt)}`);
  }
  log("kill-list receipt verified=true (pid + /proc start time matched)");

  // 7. Post-restart the machine serves new work.
  const afterId = `${THREAD_ID}:100`;
  const afterOutcome = await dispatch(afterId, "echo after-restart");
  if (afterOutcome.kind !== "accepted")
    throw new Error(`post-restart dispatch → ${JSON.stringify(afterOutcome)}`);
  await waitFor(
    async () => (await journal(afterId)).some((op) => op.kind === "exited"),
    "post-restart exit",
  );
  log("post-restart roundtrip ok");

  // Transcript summary.
  console.log("\n===== SMOKE TRANSCRIPT SUMMARY =====");
  console.log(`sandbox: ${SANDBOX}`);
  for (const executionId of [...roundtripIds, sleeperId, afterId]) {
    const ops = await journal(executionId);
    console.log(`${executionId}: ${ops.map((op) => op.kind).join(" → ")}`);
  }
  console.log(`client log tail:\n${clientLines.slice(-12).join("\n")}`);
  console.log("====================================");
  log("SMOKE OK");
}

function teardown(): void {
  client?.kill("SIGKILL");
  wrangler?.kill("SIGTERM");
}

main()
  .then(() => {
    teardown();
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(`[smoke] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
    teardown();
    process.exit(1);
  });
