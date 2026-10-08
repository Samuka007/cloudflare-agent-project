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
import { hasPersistedIdentity, type ClientConfig } from "./identity.js";
import { decodeCfAccessConfig } from "./cf-access.js";

import { decodeTaskIsolationConfig } from "./task-isolation.js";
import { homedir } from "node:os";
import { join } from "node:path";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

// #425: `docker run image --help` is the container smoke arm — the image
// entrypoint has no wrapper to answer, so the client itself carries the
// usage surface (flag names mirror the env knobs below).
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    [
      "usage: cap-daemon [--server <url>] [--join-code <code>] [--dataDir <dir>]",
      "                  [--sandbox <dir>] [--cf-client-id <id> --cf-client-secret <secret>]",
      "",
      "Runs the daemon client (WS session loop + exec executor). Configuration",
      "comes from flags or DAEMON_* environment variables — the container image",
      "(packages.cap-daemon-image) passes everything through docker --env-file:",
      "",
      "  DAEMON_SERVICE_URL                 control plane base URL (--server/--url)",
      "  DAEMON_ENROLL_KEY | DAEMON_JOIN_CODE  one enrollment credential (#258)",
      "  DAEMON_DATA_DIR                    identity dir (host-id + auth.json, 0600)",
      "  DAEMON_SANDBOX_ROOT                tool sandbox root",
      "  DAEMON_CF_ACCESS_CLIENT_ID/SECRET  Access service-token pair (#420, both or neither)",
      "",
      "A dataDir with a persisted identity restores on boot without any",
      "credential (#378); a fresh machine needs exactly one.",
    ].join("\n"),
  );
  process.exit(0);
}

/** Enroll credentials are deployment secrets — refusing to ship a dev
 * default (the POC's "[REDACTED-staging-secret]") means a misconfigured daemon
 * fails at start instead of enrolling against whatever it can reach. The
 * add-a-machine path (#258) swaps the static key for a one-time join code
 * (minted by POST /hosts/join-codes); exactly one credential is required
 * — but only when there is something to enroll (#378): a machine with a
 * persisted identity (dataDir host-id + auth.json) restores it and needs
 * no credential to come back up (systemd Restart=always, CT reboot). The
 * gate must agree exactly with loadIdentity's restore-vs-enroll test,
 * hence the shared hasPersistedIdentity predicate. */
const enrollKey = process.env.DAEMON_ENROLL_KEY;
const joinCode = argValue("--join-code") ?? process.env.DAEMON_JOIN_CODE;
const dataDir =
  argValue("--dataDir") ??
  process.env.DAEMON_DATA_DIR ??
  join(homedir(), ".local", "state", "cap-daemon");
const credentialPresent =
  (enrollKey !== undefined && enrollKey !== "") || (joinCode !== undefined && joinCode !== "");
if (!credentialPresent && !hasPersistedIdentity(dataDir)) {
  console.error(
    "[daemon-client] a credential is required: DAEMON_ENROLL_KEY, or a one-time join code via --join-code / DAEMON_JOIN_CODE",
  );
  process.exit(1);
}

const config: ClientConfig = {
  // --server is the bb installer contract flag (AddMachineDialog
  // pairingCommand); --url stays for existing env files.
  baseUrl:
    argValue("--server") ??
    argValue("--url") ??
    process.env.DAEMON_SERVICE_URL ??
    "http://127.0.0.1:8790",
  dataDir,
  sandboxRoot: argValue("--sandbox") ?? process.env.DAEMON_SANDBOX_ROOT ?? "/tmp/cap-sandbox",
  enrollKey: enrollKey ?? "",
  joinCode: joinCode ?? null,
  taskIsolation: decodeTaskIsolationConfig(process.env.DAEMON_TASK_ISOLATION),
  // #420: --cf-client-id/--cf-client-secret mirror the env pair (arg wins,
  // the --server/--join-code convention); decode enforces both-or-neither.
  cfAccess: decodeCfAccessConfig(
    argValue("--cf-client-id") ?? process.env.DAEMON_CF_ACCESS_CLIENT_ID,
    argValue("--cf-client-secret") ?? process.env.DAEMON_CF_ACCESS_CLIENT_SECRET,
  ),
};

await runClient(config);
