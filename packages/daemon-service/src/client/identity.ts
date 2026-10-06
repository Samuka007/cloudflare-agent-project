import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { negotiationFailure } from "./backoff.js";
import { cfAccessHeaders, type CfAccessConfig } from "./cf-access.js";
import { log } from "./log.js";
import type { AgentAuthConfig } from "./agent-auth.js";
import type { TaskIsolationConfig } from "./task-isolation.js";

/**
 * Client identity (§8.1): the ONLY persisted client state — hostId + hostKey
 * in the dataDir (bb `host-id` + `auth.json` shape, 0600). Lost identity →
 * re-enroll (bb §5).
 */

export interface ClientConfig {
  baseUrl: string;
  dataDir: string;
  sandboxRoot: string;
  /** Static deployment enrollment key (#176 env model). */
  enrollKey: string;
  /**
   * One-time join code from the control plane's POST /hosts/join-codes
   * (#258) — the add-a-machine path. Alternative to `enrollKey`; exactly one
   * is required (the CLI entry validates and exits otherwise).
   */
  joinCode: string | null;
  /** T20 #110 isolation policy — decoded from DAEMON_TASK_ISOLATION. */
  taskIsolation: TaskIsolationConfig;
  /** #145 provider channel — decoded from DAEMON_AGENT_AUTH. */
  agentAuth: AgentAuthConfig;
  /** #420 CF Access service-token pair (the wall; hostKey is the door
   * lock) — undefined when the daemon dials an Access-free face. */
  cfAccess?: CfAccessConfig;
}

export interface ClientIdentity {
  hostId: string;
  hostKey: string;
}

const HOST_ID_FILE = "host-id";
const AUTH_FILE = "auth.json";

/**
 * Whether `dataDir` carries an enrollable persisted identity — the same
 * both-files test `loadIdentity` uses to restore instead of enroll. The CLI
 * entry gates its credential requirement on this: an enrolled machine
 * restarts (systemd, reboot) without any enrollment credential; only a
 * fresh machine needs one (#378 resident-host contract, host-onboarding.md
 * step 4).
 */
export function hasPersistedIdentity(dataDir: string): boolean {
  return existsSync(join(dataDir, HOST_ID_FILE)) && existsSync(join(dataDir, AUTH_FILE));
}

export async function loadIdentity(config: ClientConfig): Promise<ClientIdentity> {
  mkdirSync(config.dataDir, { recursive: true });
  const hostIdPath = join(config.dataDir, HOST_ID_FILE);
  const authPath = join(config.dataDir, AUTH_FILE);
  if (hasPersistedIdentity(config.dataDir)) {
    const hostId = readFileSync(hostIdPath, "utf8").trim();
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as { hostKey: string };
    log(`identity restored from ${config.dataDir} (hostId=${hostId})`);
    return { hostId, hostKey: auth.hostKey };
  }
  return enroll(config, hostIdPath, authPath);
}

async function enroll(
  config: ClientConfig,
  hostIdPath: string,
  authPath: string,
): Promise<ClientIdentity> {
  const response = await fetch(`${config.baseUrl}/enroll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // #420: Access service-token headers when configured — the only
      // credential this path can carry (enroll mints the hostKey).
      ...cfAccessHeaders(config.cfAccess),
    },
    // hostName rides the first registry insert (bb /hosts/enroll upserts the
    // daemon's self-reported name, internal/hosts.ts:110).
    body: JSON.stringify({
      enrollKey: config.joinCode ?? config.enrollKey,
      hostName: hostname(),
    }),
  });
  const text = await response.text();
  if (response.status !== 201) {
    throw negotiationFailure(
      "enroll",
      response.status,
      response.headers.get("retry-after"),
      Date.now(),
      text,
    );
  }
  const issued = JSON.parse(text) as { hostId: string; hostKey: string };
  writeFileSync(hostIdPath, `${issued.hostId}\n`);
  writeFileSync(authPath, `${JSON.stringify({ hostKey: issued.hostKey })}\n`);
  chmodSync(hostIdPath, 0o600);
  chmodSync(authPath, 0o600);
  log(`enrolled as hostId=${issued.hostId} (credentials persisted 0600)`);
  return { hostId: issued.hostId, hostKey: issued.hostKey };
}
