/**
 * Daemon client — plain Bun/Node process on the user's machine (M0: this
 * dev box, sandbox /tmp/poc-sandbox). Non-authoritative executor per
 * unified-turn-state §1.3/§8.1:
 *
 * - persisted: identity only (hostId + hostKey, dataDir 0600 files)
 * - memory:    bootId (per process start, deliberately never persisted),
 *              process table, per-execution output ring buffer, session
 *              handle, reconnect backoff state
 *
 * Behavior contract (§1.3/§8.2/§8.3/§8.5): spawn on exec.spawn (marker env +
 * own process group), stream merged output by byte offset, resume on
 * exec.resume from the acked offset (gap declared explicitly), kill by
 * pid+start-time verification, full boot.announce on every reconnect,
 * disconnect never self-kills running work, buffers trim only behind
 * exec.output_ack, buffers drop only on exec.forget.
 */

import { runClient } from "./connection.js";
import type { ClientConfig } from "./identity.js";
import { decodeAgentAuthConfig } from "./agent-auth.js";
import { decodeTaskIsolationConfig } from "./task-isolation.js";
import { homedir } from "node:os";
import { join } from "node:path";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

/** Enroll credentials are deployment secrets — refusing to ship a dev
 * default (the POC's "poc-dev-enroll-key") means a misconfigured daemon
 * fails at start instead of enrolling against whatever it can reach. */
const enrollKey = process.env.DAEMON_ENROLL_KEY;
if (enrollKey === undefined || enrollKey === "") {
  console.error("[daemon-client] DAEMON_ENROLL_KEY is required (set it in the daemon env file)");
  process.exit(1);
}

const config: ClientConfig = {
  baseUrl: argValue("--url") ?? process.env.DAEMON_SERVICE_URL ?? "http://127.0.0.1:8790",
  dataDir: argValue("--dataDir") ?? process.env.DAEMON_DATA_DIR ?? join(homedir(), ".local", "state", "cap-daemon"),
  sandboxRoot: argValue("--sandbox") ?? process.env.DAEMON_SANDBOX_ROOT ?? "/tmp/cap-sandbox",
  enrollKey,
  taskIsolation: decodeTaskIsolationConfig(process.env.DAEMON_TASK_ISOLATION),
  agentAuth: decodeAgentAuthConfig(process.env.DAEMON_AGENT_AUTH),
};

await runClient(config);
