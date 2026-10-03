import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Client identity (§8.1): the ONLY persisted client state — hostId + hostKey
 * in the dataDir (bb `host-id` + `auth.json` shape, 0600). Lost identity →
 * re-enroll (bb §5).
 */

export interface ClientConfig {
  baseUrl: string;
  dataDir: string;
  sandboxRoot: string;
  enrollKey: string;
}

export interface ClientIdentity {
  hostId: string;
  hostKey: string;
}

const HOST_ID_FILE = "host-id";
const AUTH_FILE = "auth.json";

export async function loadIdentity(config: ClientConfig): Promise<ClientIdentity> {
  mkdirSync(config.dataDir, { recursive: true });
  const hostIdPath = join(config.dataDir, HOST_ID_FILE);
  const authPath = join(config.dataDir, AUTH_FILE);
  if (existsSync(hostIdPath) && existsSync(authPath)) {
    const hostId = readFileSync(hostIdPath, "utf8").trim();
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as { hostKey: string };
    log(`identity restored from ${config.dataDir} (hostId=${hostId})`);
    return { hostId, hostKey: auth.hostKey };
  }
  return enroll(config, hostIdPath, authPath);
}

async function enroll(config: ClientConfig, hostIdPath: string, authPath: string): Promise<ClientIdentity> {
  const response = await fetch(`${config.baseUrl}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey: config.enrollKey }),
  });
  const text = await response.text();
  if (response.status !== 201) {
    throw new Error(`enroll failed: HTTP ${response.status} ${text}`);
  }
  const issued = JSON.parse(text) as { hostId: string; hostKey: string };
  writeFileSync(hostIdPath, `${issued.hostId}\n`);
  writeFileSync(authPath, `${JSON.stringify({ hostKey: issued.hostKey })}\n`);
  chmodSync(hostIdPath, 0o600);
  chmodSync(authPath, 0o600);
  log(`enrolled as hostId=${issued.hostId} (credentials persisted 0600)`);
  return { hostId: issued.hostId, hostKey: issued.hostKey };
}

export function log(message: string): void {
  console.log(`[daemon-client] ${new Date().toISOString()} ${message}`);
}
