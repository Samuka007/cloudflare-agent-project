import type { DaemonServiceDO } from "@cap/daemon-service";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import { hostSchema } from "../contract/domain/host.js";
import type { Host } from "../contract/domain/host.js";
import { listNonDestroyedHostRows } from "../db/hosts.js";
import type { HostDbRow } from "../db/rows.js";
import type { Env } from "../env.js";

/**
 * bb toHostRecord reads the status out of the live session before shaping
 * the response (entity-lookup.ts:82-94); same here, one DO round trip per
 * host. Every non-connected answer — no DAEMON_SERVICE binding in this
 * deployment, a failed or cold RPC, no current session — degrades to
 * "disconnected", exactly bb's reading for an unregistered host.
 *
 * #436 virtual liveness: the cloud placeholder is the deployment's own
 * carrier face, so the hosts projection reports it permanently connected.
 * The pinned SPA then applies its upstream primary semantics unchanged
 * (primary row ⇒ no Remove — matching the server's removal refusal; every
 * real machine shows Remove — matching its 200). The DO seam below is NOT
 * fooled: no session can exist for the reserved id, so execution faces
 * (runtime-display suspension banners, tool dispatch) keep answering the
 * honest offline.
 */
export async function toHostRecord(env: Env, row: HostDbRow): Promise<Host> {
  return hostSchema.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    status:
      row.type === "placeholder" || (await daemonConnected(env, row.id))
        ? "connected"
        : "disconnected",
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

/**
 * bb resolvePrimaryHostId (services/hosts/primary-host.ts:70-76) cascade
 * (dataDir → unique connected → only remaining) with the port's first leg
 * resolved by the server-body binding (#436): this Worker deployment IS the
 * cloud, so the "machine hosting the server" leg names the seeded placeholder
 * row — a declarative truth, not a fallback (the port has no server-side
 * dataDir host-id file to read, bb-host-surface.md §S4 主 host 裁定). The bb
 * fallback legs follow verbatim for the impossible placeholder-less fleet:
 * the unique connected host, else the only remaining host, else null.
 */
export async function resolvePrimaryHostId(env: Env): Promise<string | null> {
  const rows = await listNonDestroyedHostRows(env);
  if (rows.length === 0) return null;
  const placeholder = rows.find((row) => row.id === CLOUD_PLACEHOLDER_HOST_ID);
  if (placeholder !== undefined) return placeholder.id;
  const liveness = await Promise.all(rows.map((row) => daemonConnected(env, row.id)));
  const connectedRows = rows.filter((_, index) => liveness[index] === true);
  const connectedHost = connectedRows[0];
  if (connectedRows.length === 1 && connectedHost !== undefined) return connectedHost.id;
  const soleHost = rows[0];
  if (rows.length === 1 && soleHost !== undefined) return soleHost.id;
  return null;
}
