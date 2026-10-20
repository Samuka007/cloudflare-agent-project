import { createRpcControlPlaneClient, type ControlPlaneFetcher } from "@cap/protocol";

/**
 * #62 hosts-registry liveness projection — the port's `markHostSeen`
 * (bb packages/db/src/data/hosts.ts:113-122): the daemon's heartbeat
 * refreshes the control-plane registry's last_seen_at, so /hosts can show
 * "last seen" truth instead of a stamp frozen at attach time.
 *
 * T7 #599: the direct D1 UPDATE is retired — the hosts table layout is
 * server-private storage now, and the stamp rides the ControlPlane typed
 * RPC face (the CONTROL_PLANE service binding). The ≥30s write throttle is
 * the SERVER's policy since this change (#591 ruling: markSeen 节流内聚
 * Hosts repo); this side just fires per heartbeat.
 *
 * Rows are created by the #49 attach bridge (the composed front's
 * onDaemonAttach); this projection only ever stamps: a host that never
 * attached simply has no row to stamp.
 */
export async function markHostSeen(
  binding: ControlPlaneFetcher,
  hostId: string,
  at: number,
): Promise<void> {
  await createRpcControlPlaneClient(binding).markHostSeen({ hostId, at });
}
