import { afterEach, describe, expect, test, vi } from "vitest";
import { BACKOFF_JITTER_FRACTION, RECONNECT_BACKOFF_MIN_MS } from "../src/client/backoff.js";
import { runSessionLoop, type SessionLoopClock } from "../src/client/session-loop.js";
import { watchSocketClose, WSSession } from "../src/client/ws-session.js";

/**
 * L1 server-initiated WS close (issue #38): a close event must END the
 * session actively — clear the per-session timers and reject the ended
 * latch — so the unified chain (#35) consumes the rung and the client
 * re-enters negotiation on schedule. Regression shape: the old close
 * listener only logged; sessionLifetime polled a heartbeat flag that only
 * teardown (which runs after it returns) could clear, so a server close
 * (deploy restart, DO eviction, edge drop) stranded the client forever.
 *
 * Harness: the #35 virtual-clock loop clock drives the REAL session-loop
 * and the REAL WSSession/watchSocketClose wiring; the socket and its
 * heartbeat/flush intervals are thin stand-ins mirroring connection.ts.
 * Fake timers beat the intervals so no scenario waits on wall-clock time.
 */

const FIRST_RUNG_MS = RECONNECT_BACKOFF_MIN_MS;
const JITTER_SPAN_MS = FIRST_RUNG_MS * BACKOFF_JITTER_FRACTION;

class HourElapsed extends Error {
  constructor(
    readonly elapsedMs: number,
    readonly sleeps: number[],
  ) {
    super(`simulated time reached ${elapsedMs}ms`);
  }
}

interface VirtualClock {
  clock: SessionLoopClock;
  sleeps: number[];
  now: () => number;
}

function virtualClock(horizonMs: number, random: () => number): VirtualClock {
  let now = 0;
  const sleeps: number[] = [];
  return {
    clock: {
      now: () => now,
      random,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
        if (now > horizonMs) throw new HourElapsed(now, sleeps);
      },
    },
    sleeps,
    now: () => now,
  };
}

/** Minimal WebSocket stand-in: an EventTarget whose close ends it. */
class FakeSocket extends EventTarget {
  readonly OPEN = 1;
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  /** The server side hangs up (deploy restart, DO eviction, edge drop). */
  serverClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  send(raw: string): void {
    if (this.readyState !== this.OPEN) throw new Error("send on closed socket");
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
}

interface SessionRecord {
  session: WSSession;
  socket: FakeSocket;
  timerState: { heartbeatTimer: number | null; flushTimer: number | null };
}

interface CloseScenarioOptions {
  /** Heartbeat interval the "server" declared in session/open. */
  heartbeatIntervalMs: number;
  /** 0 → close queued immediately after attach, before any heartbeat tick;
   *  >0 → the session lives through that many simulated heartbeat-ms (the
   *  beats really fire), then the close lands mid-interval while
   *  sessionLifetime is provably pending (the gate). */
  closeDelayMs: number;
  /** Simulated chain horizon; the loop aborts with HourElapsed past it. */
  horizonMs: number;
}

interface CloseScenarioRun {
  sleeps: number[];
  openCalls: number;
  records: SessionRecord[];
}

async function runCloseScenario(options: CloseScenarioOptions): Promise<CloseScenarioRun> {
  const virtual = virtualClock(options.horizonMs, () => 0.5); // jitter-neutral
  const records: SessionRecord[] = [];
  let openCalls = 0;
  let current: WSSession | null = null;
  const lifetimeEntered = Promise.withResolvers<void>();

  const establishSession = async (): Promise<number> => {
    openCalls += 1;
    const socket = new FakeSocket();
    const session = current = new WSSession();
    const timerState: SessionRecord["timerState"] = { heartbeatTimer: null, flushTimer: null };
    records.push({ session, socket, timerState });
    // The exact production wiring (connection.ts): the close event clears
    // the per-session timers and rejects the latch; the loop consumes the
    // failed rung and reconnects.
    watchSocketClose(
      socket,
      session,
      () => current === session,
      () => {
        clearInterval(timerState.heartbeatTimer);
        clearInterval(timerState.flushTimer);
        timerState.heartbeatTimer = null;
        timerState.flushTimer = null;
      },
    );
    socket.open();
    // Production heartbeat shape (connection.ts): guard on OPEN, send JSON.
    timerState.heartbeatTimer = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" }));
    }, options.heartbeatIntervalMs);
    timerState.flushTimer = setInterval(() => {}, 100);
    if (options.closeDelayMs === 0) {
      // Immediate close: queued behind attach, before any heartbeat tick.
      queueMicrotask(() => socket.serverClose());
    } else {
      // Once the loop is provably pending in sessionLifetime, fire the
      // beats across closeDelayMs of simulated time, then hang up before
      // the next beat would fall due — mid-heartbeat-interval.
      void lifetimeEntered.promise.then(() => {
        vi.advanceTimersByTime(options.closeDelayMs);
        socket.serverClose();
      });
    }
    return virtual.now();
  };

  try {
    await runSessionLoop(
      {
        ensureIdentity: async () => ({ hostId: "host_test", hostKey: "key_test" }),
        establishSession,
        sessionLifetime: async () => {
          if (current === null) throw new Error("lifetime before establish");
          lifetimeEntered.resolve();
          await current.ended.promise;
        },
        teardownSession: () => {},
      },
      virtual.clock,
    );
  } catch (error) {
    if (!(error instanceof HourElapsed)) throw error;
  }
  return { sleeps: virtual.sleeps, openCalls, records };
}

/** The rung sequence proving the close rode the #35 chain: 1s, then ×2. */
function expectBackoffChain(sleeps: number[]): void {
  expect(sleeps.length).toBe(2);
  expect(sleeps[0]).toBeGreaterThanOrEqual(FIRST_RUNG_MS - JITTER_SPAN_MS);
  expect(sleeps[0]).toBeLessThanOrEqual(FIRST_RUNG_MS + JITTER_SPAN_MS);
  expect(sleeps[0]).toBe(FIRST_RUNG_MS); // jitter-neutral random() = 0.5
  expect(sleeps[1]).toBe(FIRST_RUNG_MS * 2);
}

describe("L1 server-initiated WS close (issue #38)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("close immediately after attach: timers cleared, client re-enters negotiation on the first rung", async () => {
    vi.useFakeTimers();
    const run = await runCloseScenario({
      heartbeatIntervalMs: 50,
      closeDelayMs: 0,
      horizonMs: FIRST_RUNG_MS * 2,
    });

    expect(run.openCalls).toBe(2); // re-entered negotiation exactly once
    expectBackoffChain(run.sleeps);

    const [first, second] = run.records;
    if (first === undefined || second === undefined) throw new Error("expected two sessions");
    expect(first.socket.sent.filter((frame) => frame.type === "heartbeat")).toHaveLength(0);
    // The close — not teardown — actively cleared the live session's timers.
    expect(first.timerState.heartbeatTimer).toBeNull();
    expect(first.timerState.flushTimer).toBeNull();
    expect(second.timerState.heartbeatTimer).toBeNull();
    // The latch carried the close reason into the loop's failure path.
    const loss = await first.session.ended.promise.then(
      () => "unexpectedly resolved",
      (error: unknown) => String(error),
    );
    expect(loss).toContain("ws closed by peer (code 1006)");
    // No stranded per-session timers: nothing pends, and letting the clock
    // run past the cleared beats fires nothing (a leaked interval's send
    // on a closed socket would throw here).
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(200);
  });

  test("close mid-heartbeat-interval: heartbeats flowed, session still ends and reconnects on schedule", async () => {
    vi.useFakeTimers();
    const run = await runCloseScenario({
      heartbeatIntervalMs: 100,
      closeDelayMs: 250, // beats at 100/200 fire; the 300 beat never falls due
      horizonMs: FIRST_RUNG_MS * 2,
    });

    expect(run.openCalls).toBe(2);
    expectBackoffChain(run.sleeps);

    const [first] = run.records;
    if (first === undefined) throw new Error("expected at least one session");
    // The session really lived across two beats before the hang-up.
    expect(first.socket.sent.filter((frame) => frame.type === "heartbeat")).toHaveLength(2);
    // Cleared mid-interval by the close event, not by a natural timer path.
    expect(first.timerState.heartbeatTimer).toBeNull();
    expect(first.timerState.flushTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(200);
  });
});
