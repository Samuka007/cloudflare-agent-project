/**
 * omp `--mode rpc` frame budgets (docs/research/omp-engine-portability.md §2.1;
 * bb bridge.ts:179-184, :331-332). Named constants for the daemon client and
 * provider layers to consume — never inline these numbers (engineering.md
 * practice 4).
 */

/** Single logical frame cap before chunking (omp rpc-frame.ts:6-10). */
export const OMP_RPC_MAX_FRAME_BYTES = 1_048_576; // 1 MiB
/** Per-chunk payload cap for v2 `rpc_chunk` framing. */
export const OMP_RPC_CHUNK_BYTES = 262_144; // 256 KiB
/** Reassembly cap across chunks of one logical frame. */
export const OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES = 67_108_864; // 64 MiB
/** Protocol negotiation window after spawn (bb OMP_RPC_STARTUP_TIMEOUT_MS). */
export const OMP_RPC_STARTUP_TIMEOUT_MS = 30_000;
/** Per-request timeout inside the provider RPC loop (bb bridge request cap). */
export const OMP_RPC_REQUEST_TIMEOUT_MS = 30_000;
