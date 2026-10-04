import { log } from "./log.js";

/**
 * One live WS session's end-latch (issue #38): what the socket's close
 * event fires so the unified loop's sessionLifetime step returns. Node-free
 * (log.ts convention) so the L1 tests drive the exact wiring connection.ts
 * uses; per-session timer handles stay in connection.ts (Node-only
 * typecheck) and reach this module through watchSocketClose's `onLost`.
 *
 * The defect this closes: the old close listener only logged, and the
 * heartbeat timer it had to clear is nulled only by teardownSession — which
 * runs after sessionLifetime returns. A server-initiated close (deploy
 * restart, DO eviction, edge drop) could therefore strand the lifetime
 * forever and the reconnect chain (#35) never ran. The latch breaks that
 * cycle: the close event clears the timers (onLost) and rejects the latch,
 * the loop consumes it as a failed rung, and the client reconnects on the
 * backoff schedule.
 */
export class WSSession {
  /**
   * Rejects when the session's socket ends; never resolves (a live session
   * ends through this latch or process exit). A plain Error, not a
   * NegotiationError: a WS close carries no Retry-After, so the chain's own
   * jittered schedule — not a server-indicated wait — governs the reconnect.
   */
  readonly ended = Promise.withResolvers<undefined>();

  private lost = false;

  /** A lost socket ends the session actively (#38): fire the latch exactly
   * once (a second close event is a no-op). */
  lose(message: string): void {
    if (this.lost) return;
    this.lost = true;
    this.ended.reject(new Error(message));
  }
}

/**
 * Wires the socket's close event into the session latch (#38): `onLost`
 * clears the session's timers, the latch rejection ends sessionLifetime.
 * `isActive` ignores a close from a superseded attempt's abandoned socket
 * so a stale event cannot kill the current session. Every close of the
 * live socket — server-initiated or abnormal — ends the lifetime.
 */
export function watchSocketClose(
  socket: EventTarget,
  session: WSSession,
  isActive: () => boolean,
  onLost: () => void,
): void {
  socket.addEventListener("close", (event) => {
    const { code, reason } = event as CloseEvent;
    log(`ws closed (code ${code}${reason === "" ? "" : `: ${reason}`})`);
    if (!isActive()) return;
    onLost();
    session.lose(`ws closed by peer (code ${code})`);
  });
}
