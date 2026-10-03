import { describe, expect, it } from "vitest";
import {
  DAEMON_DISCONNECT_GRACE_MS,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_WS_SUBPROTOCOL,
  COMMAND_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  LEASE_TIMEOUT_MS,
} from "../../src/constants.js";
import {
  OMP_RPC_CHUNK_BYTES,
  OMP_RPC_MAX_FRAME_BYTES,
  OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_RPC_REQUEST_TIMEOUT_MS,
  OMP_RPC_STARTUP_TIMEOUT_MS,
} from "../../src/frame-budget.js";

/**
 * Scheme A frozen constants (bb-daemon-protocol.md 附录): the whole fleet
 * reads one set of numbers. daemon-service (untracked, #30/#34) declares the
 * same values locally — these assertions pin the lockstep until both promote
 * into packages/protocol.
 */
describe("frozen protocol + frame-budget constants (scheme A)", () => {
  it("matches the bb/omp precedent values", () => {
    expect(DAEMON_PROTOCOL_VERSION).toBe(1);
    expect(DAEMON_WS_SUBPROTOCOL).toBe("cap-daemon.v1");
    expect(HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(LEASE_TIMEOUT_MS).toBe(30_000);
    expect(COMMAND_TIMEOUT_MS).toBe(30_000);
    expect(DAEMON_DISCONNECT_GRACE_MS).toBe(5_000);

    expect(OMP_RPC_MAX_FRAME_BYTES).toBe(1_048_576); // 1 MiB
    expect(OMP_RPC_CHUNK_BYTES).toBe(262_144); // 256 KiB
    expect(OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES).toBe(67_108_864); // 64 MiB
    expect(OMP_RPC_STARTUP_TIMEOUT_MS).toBe(30_000);
    expect(OMP_RPC_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("keeps the chunk arithmetic consistent (chunks ≤ frame ≤ reassembled)", () => {
    expect(OMP_RPC_MAX_FRAME_BYTES % OMP_RPC_CHUNK_BYTES).toBe(0);
    expect(OMP_RPC_MAX_FRAME_BYTES).toBeLessThan(
      OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES,
    );
  });
});
