/**
 * Named timing/protocol constants.
 *
 * Everything cross-component is here, never inline (engineering.md practice 4:
 * durations come from the protocol package / named constants). bb lineage:
 * docs/research/bb-daemon-protocol.md 附录 constants table.
 */

/** M0 scheme A frozen protocol version (bb §3: strict-equal check at open). */
export const DAEMON_PROTOCOL_VERSION = 1;

/** WS subprotocol header value (bb `bb-host-daemon.v1` shape). */
export const DAEMON_WS_SUBPROTOCOL = "cap-daemon.v1";

// ---------------------------------------------------------------------------
// Frame budgets — omp/bb RPC precedent (1MiB frame / 256KiB chunk / 64MiB
// reassembled cap; bb bridge.ts:179-184).
// ---------------------------------------------------------------------------
export const MAX_FRAME_BYTES = 1_048_576;
/** Max payload bytes per `exec.output` frame (chunk granularity ≤256KiB). */
export const OUTPUT_CHUNK_BYTES = 256_000;
/** Coalesce window for client-side output batching (§8.3: 100ms / 64KB). */
export const OUTPUT_FLUSH_MS = 100;
export const OUTPUT_COALESCE_BYTES = 64_000;
export const MAX_REASSEMBLED_BYTES = 64_000_000;

// ---------------------------------------------------------------------------
// Lease & timing (bb defaults: heartbeat 5s / lease 30s / grace 5s / command
// ack 30s).
// ---------------------------------------------------------------------------
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const LEASE_TIMEOUT_MS = 30_000;
export const DISCONNECT_GRACE_MS = 5_000;
export const SPAWN_ACK_TIMEOUT_MS = 30_000;

/**
 * #62: minimum spacing between two hosts-registry last_seen_at writes
 * (hosts-registry.ts). bb stamps per WS message into local SQLite; the port
 * projects the 5s heartbeat into the registry D1 at most once per window so
 * the liveness stamp cannot burn D1 write quota. Staleness ceiling while
 * connected: this window (+5s heartbeat jitter).
 */
export const LIVENESS_PROJECTION_INTERVAL_MS = 30_000;

/** Default execution timeout carried with each dispatch (M0 policy). */
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Output path (§8.3/§8.4).
// ---------------------------------------------------------------------------
/** Client-side per-execution retransmit buffer cap (ring). */
export const CLIENT_RING_BUFFER_BYTES = 1_000_000;
/** Client pauses pipe reads above this much unacked outbound WS backlog. */
export const WS_BACKPRESSURE_HIGH_WATER_BYTES = 4_000_000;
/** Service DO inline result cap; beyond it truncate + `outputTruncated`. */
export const RESULT_INLINE_LIMIT_BYTES = 1_000_000;
/** Client command queue bound; overflow is an explicit `busy` (§8.3). */
export const CLIENT_COMMAND_QUEUE_LIMIT = 256;

// ---------------------------------------------------------------------------
// Reconnect backoff (bb server-connection-support.ts: 1s→30s, ×2, stable
// >10s resets the attempt counter).
// ---------------------------------------------------------------------------
export const RECONNECT_BACKOFF_MIN_MS = 1_000;
export const RECONNECT_BACKOFF_MAX_MS = 30_000;
export const RECONNECT_STABLE_RESET_MS = 10_000;

/** I30: dispatch while syncing defers at most this long before host_offline. */
export const SYNC_SPAWN_DEFER_TIMEOUT_MS = 5_000;

/** Kill escalation (§2.4): SIGTERM → 5s → SIGKILL on the process group. */
export const KILL_ESCALATION_MS = 5_000;

/**
 * Tombstone retention (§5.2.4): M0 keeps tombstone journal rows; a TTL sweep
 * over them is deferred (see package README deferred list) — the constant
 * pins the intended policy.
 */
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Edge shielding (#36): the front's DO-request budget. engineering.md
// 横切实践 11 — negotiation paths that must touch the DO are guarded by the
// three edge gates below; everything else is digested at the edge.
// ---------------------------------------------------------------------------

/**
 * KV TTL for the hostKey-hash auth cache. The ticket says "TTL = lease
 * horizon"; Cloudflare KV's platform floor is 60s, so the 30s lease horizon
 * sits inside one TTL. Revocation converges within one TTL: rotate →
 * re-enroll overwrites the DO mirror (authority) and the cache; a stale
 * cache entry survives ≤60s, and the DO authCheck fallback rejects it.
 */
export const HOST_KEY_KV_TTL_S = 60;

/**
 * Negative-cache window: after the DO raises a quota/overload-class failure
 * for a host, the front answers that host's negotiation requests with
 * 429 + Retry-After for this long without touching the DO. The L1 rig
 * overrides via the DAEMON_NEGATIVE_CACHE_MS var (real-clock window;
 * workerd isolates cannot be fake-timed from the test realm).
 */
export const NEGATIVE_CACHE_TTL_MS = 30_000;

/**
 * Per-hostId negotiation token bucket (in-isolate memory, best-effort per
 * the ticket — an isolate eviction resets the buckets, which fails open).
 * Capacity 20 with a 10/s refill admits any legitimate reconnect pattern
 * (client backoff floor is 1s per attempt) while capping a faulty client's
 * DO amplification.
 */
export const NEGOTIATE_BUCKET_CAPACITY = 20;
export const NEGOTIATE_REFILL_PER_SEC = 10;
