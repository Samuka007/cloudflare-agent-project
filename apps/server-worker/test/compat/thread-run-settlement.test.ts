import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { threadResponseSchema } from "../../src/contract/api/threads.js";
import { createThread, send, type CreatedThread } from "../helpers.js";
import { exports } from "cloudflare:workers";
import { deriveSettledTurnEvent } from "../../src/services/thread-run-settlement.js";
import { evaluateThreadLifecycleEvent } from "../../src/contract/domain/thread-lifecycle.js";
import type { UxThreadEvent } from "../../src/seam/agent-do.js";

/**
 * #52: terminal turn events must settle the coarse M0 execution status.
 * The send route flips `active` on dispatch; without consuming the agent
 * DO's turn/completed the row never leaves active, so every thread renders
 * the SPA's permanent busy state (waiting-for-host → queue-path composer,
 * Working... + Host disconnected) regardless of turn outcome.
 */
beforeAll(ensureMigrations);

let seqCounter = 0;

function uxEvent(type: string, data: unknown, seq?: number): UxThreadEvent {
  seqCounter += 1;
  return {
    id: `evt-${seqCounter}`,
    threadId: "thr_test",
    seq: seq ?? seqCounter,
    type,
    data,
    createdAt: 0,
  };
}

const ACTIVE_ROW = { status: "active" as const, archivedAt: null, deletedAt: null };

describe("terminal turn → lifecycle event derivation", () => {
  it("maps an accepted→completed turn to run.succeeded and the row to idle", () => {
    const events = [
      uxEvent("item/started", {
        turnId: "t1",
        item: { type: "userMessage", id: "u1", content: [] },
      }),
      uxEvent("turn/started", { turnId: "t1" }),
      uxEvent("turn/completed", { turnId: "t1", status: "completed", error: null }),
    ];
    expect(deriveSettledTurnEvent(events)).toEqual({ type: "run.succeeded" });
    expect(
      evaluateThreadLifecycleEvent({ event: { type: "run.succeeded" }, thread: ACTIVE_ROW }),
    ).toEqual({
      to: "idle",
    });
  });

  it("maps an accepted→failed (sealed) turn to run.failed and the row to error", () => {
    const events = [
      uxEvent("turn/started", { turnId: "t1" }),
      uxEvent("system/error", {
        message: "model stream interrupted mid-call; turn sealed",
        category: "internal",
      }),
      uxEvent("turn/completed", {
        turnId: "t1",
        status: "failed",
        error: { category: "internal", message: "interrupted_mid_stream" },
      }),
    ];
    expect(deriveSettledTurnEvent(events)).toEqual({ type: "run.failed" });
    expect(
      evaluateThreadLifecycleEvent({ event: { type: "run.failed" }, thread: ACTIVE_ROW }),
    ).toEqual({
      to: "error",
    });
  });

  it("maps an interrupted turn to run.succeeded (coarse idle)", () => {
    const events = [
      uxEvent("turn/started", { turnId: "t1" }),
      uxEvent("turn/completed", {
        turnId: "t1",
        status: "interrupted",
        error: { category: "cancelled", message: "turn cancelled" },
      }),
    ];
    expect(deriveSettledTurnEvent(events)).toEqual({ type: "run.succeeded" });
  });

  it("stays null while the latest turn is in flight", () => {
    const inFlight = [
      uxEvent("turn/completed", { turnId: "t0", status: "completed", error: null }),
      uxEvent("turn/started", { turnId: "t1" }),
    ];
    expect(deriveSettledTurnEvent(inFlight)).toBeNull();
    expect(deriveSettledTurnEvent([uxEvent("turn/started", { turnId: "t1" })])).toBeNull();
    expect(deriveSettledTurnEvent([])).toBeNull();
  });

  it("settles from the latest terminal event of a multi-turn log", () => {
    const events = [
      uxEvent("turn/started", { turnId: "t1" }),
      uxEvent("turn/completed", { turnId: "t1", status: "completed", error: null }),
      uxEvent("turn/started", { turnId: "t2" }),
      uxEvent("turn/completed", {
        turnId: "t2",
        status: "failed",
        error: { category: "internal", message: "boom" },
      }),
    ];
    expect(deriveSettledTurnEvent(events)).toEqual({ type: "run.failed" });
  });

  it("ignores malformed terminal events", () => {
    const events = [
      uxEvent("turn/started", { turnId: "t1" }),
      uxEvent("turn/completed", { turnId: "t1" }),
      uxEvent("turn/completed", { turnId: "t1", status: "sideways" }),
    ];
    expect(deriveSettledTurnEvent(events)).toBeNull();
  });

  it("no-ops through the FSM when the row is already settled", () => {
    // An idle row has no run.succeeded cell: the FSM reports the illegal
    // transition, which is what makes repeated timeline fetches idempotent.
    const evaluation = evaluateThreadLifecycleEvent({
      event: { type: "run.succeeded" },
      thread: { status: "idle", archivedAt: null, deletedAt: null },
    });
    expect(evaluation).toEqual({
      noop: "illegal-transition",
      detail: "no transition for run.succeeded from status idle",
    });
  });
});

describe("timeline fetch settles the thread execution status", () => {
  it("an accepted→completed turn lands the row idle after the turn seals", async () => {
    const thread: CreatedThread = await createThread({ title: "settle-completed" });
    await send(thread.id);
    // The turn runs asynchronously; /events/wait resolves the moment the
    // DO seals the mock turn with its terminal event — no guessed sleep.
    const wait = await exports.default.fetch(
      `https://example.com/api/v1/threads/${thread.id}/events/wait` +
        `?type=${encodeURIComponent("turn/completed")}&afterSeq=0&waitMs=15000`,
    );
    expect(wait.status).toBe(200);
    const timeline = await exports.default.fetch(
      `https://example.com/api/v1/threads/${thread.id}/timeline?segmentLimit=20`,
    );
    expect(timeline.status).toBe(200);
    const detail = await exports.default.fetch(`https://example.com/api/v1/threads/${thread.id}`);
    const body = threadResponseSchema.parse(await detail.json());
    expect(body.status).toBe("idle");
    expect(body.runtime.displayStatus).toBe("idle");
  });

  it("leaves a thread without terminal turn events untouched", async () => {
    const thread: CreatedThread = await createThread({ title: "settle-no-turn" });
    const timeline = await exports.default.fetch(
      `https://example.com/api/v1/threads/${thread.id}/timeline?segmentLimit=20`,
    );
    expect(timeline.status).toBe(200);
    const detail = await exports.default.fetch(`https://example.com/api/v1/threads/${thread.id}`);
    const body = threadResponseSchema.parse(await detail.json());
    expect(body.status).toBe("starting");
  });
});
