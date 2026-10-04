import { NegotiationBackoff, NegotiationError, type BackoffClock } from "./backoff.js";
import { log } from "./log.js";

/**
 * The single reconnect loop (issue #35): session establishment and every
 * failure path — enroll, session/open, WS attach, WS disconnect — share one
 * NegotiationBackoff chain. The stable-session reset evaluates exactly the
 * session that just ended, so a never-connected client keeps climbing (the
 * incident fix) while a proven-stable session restarts at the chain floor.
 * Clock and steps are injectable: the L1 test runs this loop unchanged
 * against a rejecting endpoint with a virtual hour.
 */

/**
 * @typeParam TIdentity — the credential bundle shape is opaque to the loop;
 * the concrete `ClientIdentity` lives in identity.ts (a node:fs module, so
 * it must stay out of this file's import graph).
 */
export interface SessionLoopSteps<TIdentity> {
  /** Load the persisted identity or enroll (bb §5); failures ride the chain. */
  readonly ensureIdentity: () => Promise<TIdentity>;
  /** Open the session and attach the WS; resolves with the ws-open time. */
  readonly establishSession: (identity: TIdentity) => Promise<number>;
  /** Resolves when the live session ends (socket closed). */
  readonly sessionLifetime: () => Promise<void>;
  /** Clears per-session timers and sockets before the next attempt. */
  readonly teardownSession: () => void;
}

export interface SessionLoopClock extends BackoffClock {
  sleep(ms: number): Promise<void>;
}

export const realSessionLoopClock: SessionLoopClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export async function runSessionLoop<TIdentity>(
  steps: SessionLoopSteps<TIdentity>,
  clock: SessionLoopClock = realSessionLoopClock,
): Promise<never> {
  const backoff = new NegotiationBackoff(clock);
  let identity: TIdentity | null = null;
  let connectedAtMs = 0;
  for (;;) {
    let failure: unknown;
    try {
      identity ??= await steps.ensureIdentity();
      connectedAtMs = await steps.establishSession(identity);
      await steps.sessionLifetime();
      failure = undefined;
    } catch (error) {
      failure = error;
    }
    steps.teardownSession();
    // Consume the boundary once: a later attempt must not inherit this
    // session's timestamp — a stale one would mint a bogus stable reset.
    const endedAtMs = connectedAtMs;
    connectedAtMs = 0;
    if (backoff.resetAfterSessionEnd(endedAtMs)) {
      log("session was stable — backoff chain reset");
    }
    const retryAfterMs = failure instanceof NegotiationError ? failure.retryAfterMs : null;
    const delayMs = backoff.nextDelayMs(retryAfterMs);
    // Error-first: the `failure === undefined` guard would narrow the
    // remaining type to `{}` before a String() render, so the check follows
    // the instanceof branch instead. Non-Error throwables render as JSON —
    // reconnect decisions never read this string.
    const outcome =
      failure instanceof Error
        ? `session lost: ${failure.message}`
        : failure === undefined
          ? "session closed"
          : `session lost: ${JSON.stringify(failure)}`;
    log(`${outcome} — reconnecting in ${Math.round(delayMs)}ms`);
    await clock.sleep(delayMs);
  }
}
