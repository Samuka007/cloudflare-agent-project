/**
 * bb lineage constants (docs/research/bb-daemon-protocol.md 附录 + §2.1/§3/§4).
 * Scheme A: the M0 protocol version stays frozen at its initial value; any
 * wire-semantics change bumps it and adds a rejection path (bb §3 discipline).
 *
 * `DAEMON_PROTOCOL_VERSION` / `DAEMON_WS_SUBPROTOCOL` must stay in lockstep
 * with packages/daemon-service (declared there too until both promote into
 * packages/protocol — cross-lane incident rule #0 forbids importing a package
 * that is not on origin).
 */

/** Strict-equal check at session open only (bb session.ts:52-77 shape). */
export const DAEMON_PROTOCOL_VERSION = 1 as const;

/** WS subprotocol header value (bb `bb-host-daemon.v1` shape, session.ts:33). */
export const DAEMON_WS_SUBPROTOCOL = "cap-daemon.v1";

/** Server-suggested heartbeat cadence (bb apps/server/src/constants.ts:2). */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** Lease window granted per session open / renewal (bb constants.ts:3). */
export const LEASE_TIMEOUT_MS = 30_000;
/** Default per-command dispatch timeout (bb COMMAND_TIMEOUT_MS). */
export const COMMAND_TIMEOUT_MS = 30_000;
/**
 * Disconnect grace: after a socket drop the session row is closed immediately
 * (reason "daemon-disconnect") and owner-side-effect completion waits this
 * long for a reconnect (bb constants.ts:4, hub.ts pendingDaemonDisconnects).
 * The separate active-work grace lives in apps/server-worker's hub.
 */
export const DAEMON_DISCONNECT_GRACE_MS = 5_000;
