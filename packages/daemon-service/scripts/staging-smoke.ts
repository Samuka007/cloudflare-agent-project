/**
 * Staging smoke — daemon client ⇄ deployed control plane tool roundtrip
 * (ticket #176 acceptance: "连 staging，工具调用回环").
 *
 * Contract: a running daemon client (same closure, `cap-daemon`) is already
 * attached to the staging deployment. This driver then proves, through the
 * public daemon face only:
 *
 *   1. session   — the service DO holds the client's live WS session
 *   2. dispatch  — POST /agent/dispatch (bash rides the embedded omp runtime
 *                  on the client since T9 #99, so this exercises the vendored
 *                  tool host + native addon, not a bare process spawn)
 *   3. roundtrip — the journal records dispatch → (client tool.exited) →
 *                  exited with the command's own output inline
 *   4. ack       — the result sequence acks clean (§3.5 loop closes)
 *
 * Auth uses the daemon's own enrolled hostKey (read from its dataDir
 * auth.json, same file the client persists 0600) — no separate credentials.
 *
 * Run: bun staging-smoke.ts --url <base> [--dataDir <dir>] [--hostKey <key>]
 *      [--hostId <id>] [--command '<shell>'] — dispatch an arbitrary command instead of the
 *      default `echo <marker> $(uname -m)` probe (#254 acceptance: prove the
 *      agent tool shell resolves host tools, e.g. `nix --version`). The
 *      dispatch still rides the marker gate: the command runs as
 *      `<command> && echo <marker>`, so a non-zero command exits without a
 *      marker and fails the smoke at the marker check.
 * Exit 0 = roundtrip proven; non-zero = failure with the journal tail printed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const JournalOpSchema = z.object({
  opSeq: z.number(),
  kind: z.string(),
  at: z.number(),
  executionId: z.string().optional(),
  tool: z.string().optional(),
  status: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  toolResult: z
    .object({
      status: z.string(),
      exitCode: z.number().nullable(),
      output: z.string().nullable().optional(),
    })
    .optional(),
});

const SessionResponseSchema = z.object({
  session: z
    .object({ bootId: z.string(), hostId: z.string().optional() })
    .nullable()
    .optional(),
});

const JournalResponseSchema = z.object({ ops: z.array(JournalOpSchema) });

const DispatchOutcomeSchema = z.object({
  kind: z.enum(["accepted", "completed_cached", "host_offline"]),
});

const UnackedResponseSchema = z.object({
  unacked: z.array(
    z.object({
      executionId: z.string(),
      result: z.object({ status: z.string(), exitCode: z.number().nullable() }),
    }),
  ),
});

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function log(message: string): void {
  console.log(`[staging-smoke] ${new Date().toISOString()} ${message}`);
}

function hostKeyFromEnvOrArgs(): string {
  const explicit = argValue("--hostKey") ?? process.env.DAEMON_HOST_KEY;
  if (explicit !== undefined && explicit !== "") return explicit;
  const dataDir = argValue("--dataDir") ?? process.env.DAEMON_DATA_DIR;
  if (dataDir === undefined || dataDir === "") {
    throw new Error("no hostKey: pass --hostKey or --dataDir (reads auth.json)");
  }
  const authPath = join(dataDir, "auth.json");
  const auth = z.object({ hostKey: z.string() }).parse(JSON.parse(readFileSync(authPath, "utf8")));
  return auth.hostKey;
}

/** The daemon's enrolled identity (#377): enroll mints a fresh host, so the
 * target host is whatever the client persisted (host-id, 0600) — never a
 * deployment-name assumption. */
function hostIdFromEnvOrArgs(): string {
  const explicit = argValue("--hostId");
  if (explicit !== undefined && explicit !== "") return explicit;
  const dataDir = argValue("--dataDir") ?? process.env.DAEMON_DATA_DIR;
  if (dataDir === undefined || dataDir === "") {
    throw new Error("no hostId: pass --hostId or --dataDir (reads host-id)");
  }
  return readFileSync(join(dataDir, "host-id"), "utf8").trim();
}

const baseUrl = (argValue("--url") ?? process.env.DAEMON_SERVICE_URL ?? "").replace(/\/$/, "");
if (baseUrl === "") throw new Error("--url or DAEMON_SERVICE_URL required");
const hostKey = hostKeyFromEnvOrArgs();
const hostId = hostIdFromEnvOrArgs();

const stamp = Date.now().toString(36);
const threadId = `thr_stg_smoke_${stamp}`;
const executionId = `${threadId}:1`;
const marker = `cap-verify-smoke-ok-${stamp}`;
const customCommand = argValue("--command");
// `&&` composition keeps the exit-0 + marker-in-output gate verbatim for
// custom commands: marker only prints when the command itself succeeded.
const command =
  customCommand === undefined
    ? `echo ${marker} $(uname -m)`
    : `${customCommand} && echo ${marker}`;

const headers = { "content-type": "application/json", authorization: `Bearer ${hostKey}` };

async function getJson<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path}: non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${path}: unexpected shape (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  return result.data;
}

async function postJson<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
): Promise<z.infer<S>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path}: non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${path}: unexpected shape (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  return result.data;
}

async function waitFor<T>(
  predicate: () => Promise<T | null>,
  what: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const value = await predicate();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error(`timeout after ${timeoutMs}ms waiting for ${what}`);
    }
    if (attempt % 10 === 0) log(`waiting for ${what}…`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function sessionUp(): Promise<string | null> {
  const body = await getJson(
    `/agent/session?hostId=${encodeURIComponent(hostId)}`,
    SessionResponseSchema,
  );
  if (body.session === undefined || body.session === null) return null;
  return `hostId=${body.session.hostId} bootId=${body.session.bootId}`;
}

async function journalOps(targetExecutionId: string): Promise<z.infer<typeof JournalOpSchema>[]> {
  const body = await getJson(
    `/agent/journal?hostId=${encodeURIComponent(hostId)}&executionId=${encodeURIComponent(targetExecutionId)}`,
    JournalResponseSchema,
  );
  return body.ops;
}

async function findExitedOp(): Promise<z.infer<typeof JournalOpSchema> | null> {
  const ops = await journalOps(executionId);
  return ops.find((op) => op.kind === "exited") ?? null;
}

async function main(): Promise<void> {
  log(`target ${baseUrl} (executionId ${executionId})`);

  const session = await waitFor(sessionUp, "live daemon session", 90_000);
  log(`session live: ${session}`);

  const outcome = await postJson(
    "/agent/dispatch",
    {
      threadId,
      turnId: `${threadId}-turn`,
      machineId: hostId,
      executionId,
      tool: "bash",
      arguments: { command },
      timeoutMs: 60_000,
    },
    DispatchOutcomeSchema,
  );
  if (outcome.kind !== "accepted") {
    throw new Error(`dispatch not accepted: ${JSON.stringify(outcome)}`);
  }
  log(`dispatch accepted (tool=bash)`);

  const exited = await waitFor(findExitedOp, "exited journal op", 60_000);

  const ops = await journalOps(executionId);
  const dispatched = ops.find((op) => op.kind === "dispatch");
  if (dispatched?.tool !== "bash") {
    throw new Error(`journal dispatch op missing/tool mismatch: ${JSON.stringify(dispatched)}`);
  }
  if (exited.status !== "ok" || exited.exitCode !== 0) {
    throw new Error(`exit not clean: status=${exited.status} exitCode=${exited.exitCode}`);
  }
  const output = exited.toolResult?.output ?? "";
  if (!output.includes(marker)) {
    throw new Error(`tool output missing marker: ${JSON.stringify(output.slice(0, 200))}`);
  }
  log(`roundtrip closed: exit 0, output "${output.trim().slice(0, 120)}"`);

  const unacked = await getJson(
    `/agent/unacked?threadId=${encodeURIComponent(threadId)}`,
    UnackedResponseSchema,
  );
  const entry = unacked.unacked.find((item) => item.executionId === executionId);
  if (entry === undefined) {
    log(`no unacked result to ack (already settled)`);
  } else {
    await postJson("/agent/ack", { executionId, resultSeq: exited.opSeq }, z.object({}));
    log(`result acked at journal seq ${exited.opSeq}`);
  }

  log(`PASS — staging tool roundtrip proven`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`[staging-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    journalOps(executionId)
      .then((ops) => {
        for (const op of ops) console.error(`[staging-smoke] journal: ${JSON.stringify(op)}`);
      })
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });
