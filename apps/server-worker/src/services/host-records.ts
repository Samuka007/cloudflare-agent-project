import type { DaemonServiceDO } from "@cap/daemon-service";
import { hostSchema } from "../contract/domain/host.js";
import type { Host } from "../contract/domain/host.js";
import type { HostDbRow } from "../db/rows.js";
import type { Env } from "../env.js";

/**
 * bb toHostRecord reads the status out of the live session before shaping
 * the response (entity-lookup.ts:82-94); same here, one DO round trip per
 * host. Every non-connected answer — no DAEMON_SERVICE binding in this
 * deployment, a failed or cold RPC, no current session — degrades to
 * "disconnected", exactly bb's reading for an unregistered host.
 */
export async function toHostRecord(env: Env, row: HostDbRow): Promise<Host> {
  return hostSchema.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    status: (await daemonConnected(env, row.id)) ? "connected" : "disconnected",
    maxPermissionMode: row.maxPermissionMode,
    lastSeenAt: row.lastSeenAt,
    lastRejectedProtocolVersion: row.lastRejectedProtocolVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export async function daemonConnected(env: Env, hostId: string): Promise<boolean> {
  const namespace = env.DAEMON_SERVICE;
  if (namespace === undefined) return false;
  const stub = namespace.get(namespace.idFromName(hostId)) as DurableObjectStub & DaemonServiceDO;
  try {
    return (await stub.hostLiveness({ hostId })).connected;
  } catch {
    return false;
  }
}
