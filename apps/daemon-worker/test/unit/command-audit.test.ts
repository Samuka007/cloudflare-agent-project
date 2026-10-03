import { beforeEach, describe, expect, it } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import {
  fakeExecutionContext,
  fakeExecutionOptions,
} from "../../src/testing/fake-provider.js";
import type { AdapterCommand } from "../../src/provider-adapter.js";
import { executionIdFor } from "../../src/seam/machine-dispatch.js";
import {
  alarmStubFor,
  installFakes,
  openRequest,
  orchestratorFor,
  type InstalledFakes,
  type OrchestratorStub,
} from "../helpers.js";

/**
 * Command dispatch + persistence semantics: bb host_daemon_commands /
 * host_daemon_command_attempts audit shape (db/drizzle 0000 + 0010) — states
 * pending→fetched→completed|failed, per-host monotonic cursor, the
 * unique-active-attempt invariant, retry accounting, lease-timeout expiry and
 * the machine-route transport split (settled vs onlineRpc).
 */

let fakes: InstalledFakes;
const orchestrator = (): OrchestratorStub => orchestratorFor();

beforeEach(async () => {
  fakes = installFakes();
});

const turnStart = (clientRequestId: string): AdapterCommand => ({
  type: "turn/start",
  threadId: "thr_audit",
  providerThreadId: "pthr_1",
  input: [{ type: "text", text: "go", mentions: [] }],
  clientRequestId,
  options: fakeExecutionContext(fakeExecutionOptions()),
});

describe("command lifecycle and audit rows", () => {
  it("walks pending → fetched → completed with one ok attempt and a monotonic cursor", async () => {
    const orch = orchestrator();
    await orch.openSession(openRequest({ leaseTimeoutMs: 60_000 }));
    const first = await orch.enqueueCommand({
      type: "initialize",
      command: { type: "initialize" },
    });
    const second = await orch.enqueueCommand({
      type: "model/list",
      command: { type: "model/list" },
    });
    expect(second.cursor).toBe(first.cursor + 1);

    const outcome = await orch.dispatchCommand({ commandId: first.commandId });
    expect(outcome).toMatchObject({ kind: "settled" });
    if (outcome.kind !== "settled") return;

    const row = await orch.getCommand({ commandId: first.commandId });
    expect(row).toMatchObject({ state: "completed", retryCount: 0 });
    expect(row?.createdAt).toBeLessThanOrEqual(row?.fetchedAt ?? Infinity);
    expect(row?.fetchedAt).toBeLessThanOrEqual(row?.completedAt ?? Infinity);
    expect(row?.resultPayload).toMatchObject({
      ok: true,
      result: { protocolVersion: 1 },
    });
    const attempts = await orch.listAttempts({ commandId: first.commandId });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: "ok",
      settledAt: expect.any(Number),
    });
  });

  it("records provider failures with errorCode and a failed attempt", async () => {
    const orch = orchestrator();
    await orch.openSession(openRequest({ leaseTimeoutMs: 60_000 }));
    fakes.provider.failCommandTypes.add("thread/stop");
    const { commandId } = await orch.enqueueCommand({
      type: "thread/stop",
      command: {
        type: "thread/stop",
        threadId: "thr_audit",
        providerThreadId: "pthr_x",
        activeTurnId: null,
      },
    });
    const outcome = await orch.dispatchCommand({ commandId });
    expect(outcome.kind).toBe("settled");
    const row = await orch.getCommand({ commandId });
    expect(row).toMatchObject({ state: "failed" });
    expect(row?.resultPayload).toMatchObject({
      ok: false,
      errorCode: "fake_failure",
      retryable: false,
    });
    const attempts = await orch.listAttempts({ commandId });
    expect(attempts[0]?.status).toBe("failed");
  });

  it("refuses double dispatch and unknown commands", async () => {
    const orch = orchestrator();
    await orch.openSession(openRequest({ leaseTimeoutMs: 60_000 }));
    const { commandId } = await orch.enqueueCommand({
      type: "initialize",
      command: { type: "initialize" },
    });
    await orch.dispatchCommand({ commandId });
    const again = await orch.dispatchCommand({ commandId });
    expect(again).toEqual({ kind: "not_dispatchable", state: "completed" });
    expect(await orch.dispatchCommand({ commandId: "hcmd_missing" })).toEqual({
      kind: "unknown_command",
    });
  });
});

describe("attempt lease timeout (bb command timeout semantics)", () => {
  it("expires the attempt via alarm, fails the command retryable, rejects late settles", async () => {
    const orch = orchestrator();
    await orch.openSession(openRequest({ leaseTimeoutMs: 60_000 }));
    fakes.provider.hangCommandTypes.add("turn/start");
    const { commandId } = await orch.enqueueCommand({
      type: "turn/start",
      command: turnStart("creq_timeoutaaa"),
      threadId: "thr_audit",
    });

    // A hanging provider means the dispatch promise never resolves in-request;
    // queue it and let the alarm expire the attempt.
    const inFlight = orch.dispatchCommand({ commandId, timeoutMs: 0 });
    await runDurableObjectAlarm(alarmStubFor());

    const row = await orch.getCommand({ commandId });
    expect(row).toMatchObject({ state: "failed" });
    expect(row?.resultPayload).toMatchObject({
      ok: false,
      errorCode: "timeout",
      retryable: true,
    });
    const attempts = await orch.listAttempts({ commandId });
    expect(attempts[0]?.status).toBe("timeout");
    expect(attempts[0]?.settledAt).not.toBeNull();

    // Late settlement after the lease expired is rejected — the journal
    // already holds the terminal truth (bb stale-response disposition).
    const late = await orch.settleCommand({
      commandId,
      attemptId: attempts[0]?.id ?? "",
      outcome: { ok: true, result: "late" },
    });
    expect(late).toEqual({ kind: "rejected", reason: "attempt-terminal" });

    // The hanging dispatch eventually answers — and its settlement is
    // reported stale, exactly the bb late-response race.
    fakes.provider.releaseHangs();
    await expect(inFlight).resolves.toEqual({
      kind: "stale_settlement",
      attemptId: attempts[0]?.id,
    });
  });

  it("retries a failed command with a fresh attempt (retry_count audit)", async () => {
    const orch = orchestrator();
    await orch.openSession(openRequest({ leaseTimeoutMs: 60_000 }));
    // The retry's second dispatch must settle ok against the provider, so
    // the turn's provider thread has to exist first.
    const seed = await orch.enqueueCommand({
      type: "thread/start",
      command: {
        type: "thread/start",
        threadId: "thr_audit",
        cwd: "/w",
        options: fakeExecutionContext(fakeExecutionOptions()),
        instructionMode: "append",
      },
      threadId: "thr_audit",
    });
    await orch.dispatchCommand({ commandId: seed.commandId });
    fakes.provider.hangCommandTypes.add("turn/start");
    const { commandId } = await orch.enqueueCommand({
      type: "turn/start",
      command: turnStart("creq_retryaaaaa"),
      threadId: "thr_audit",
    });
    const inFlight = orch.dispatchCommand({ commandId, timeoutMs: 0 });
    await runDurableObjectAlarm(alarmStubFor());
    // The hung dispatch only resolves once released — awaiting it before
    // release would wedge this DO's dispatch chain (and the test clock).
    fakes.provider.releaseHangs();
    await inFlight;

    const retried = await orch.retryCommand({ commandId });
    expect(retried).toMatchObject({ queued: true, retryCount: 1 });
    // Only failed commands re-enter the queue.
    expect(await orch.retryCommand({ commandId })).toMatchObject({
      queued: false,
    });

    fakes.provider.hangCommandTypes.delete("turn/start");
    const outcome = await orch.dispatchCommand({ commandId, timeoutMs: 60_000 });
    expect(outcome.kind).toBe("settled");

    const row = await orch.getCommand({ commandId });
    expect(row).toMatchObject({ state: "completed", retryCount: 1 });
    const attempts = await orch.listAttempts({ commandId });
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.status)).toEqual(["timeout", "ok"]);
    // bb unique-active index: at most one attempt is ever 'active'.
    expect(attempts.filter((a) => a.status === "active")).toHaveLength(0);
  });
});

describe("machine route (settled transport, #30/#34 seam)", () => {
  it("accepted dispatch leaves the command fetched until settleCommand completes it", async () => {
    const orch = orchestrator();
    await orch.openSession(openRequest({ leaseTimeoutMs: 60_000 }));
    const { commandId, cursor } = await orch.enqueueCommand({
      type: "turn/start",
      command: turnStart("creq_machaaaaaa"),
      threadId: "thr_audit",
    });

    const accepted = await orch.dispatchCommand({
      commandId,
      timeoutMs: 60_000,
      route: "machine",
    });
    expect(accepted.kind).toBe("accepted_async");
    if (accepted.kind !== "accepted_async") return;

    // The machine seam saw the self-routable executionId + command + budget.
    expect(fakes.machine.requests).toHaveLength(1);
    expect(fakes.machine.requests[0]).toMatchObject({
      executionId: executionIdFor("thr_audit", cursor),
      threadId: "thr_audit",
      timeoutMs: 60_000,
    });

    // Still in flight: fetched + active attempt.
    const inFlightRow = await orch.getCommand({ commandId });
    expect(inFlightRow?.state).toBe("fetched");

    const settled = await orch.settleCommand({
      commandId,
      attemptId: accepted.attemptId,
      outcome: { ok: true, result: { turnId: "creq_machaaaaaa" } },
    });
    expect(settled).toEqual({ kind: "accepted" });
    const row = await orch.getCommand({ commandId });
    expect(row).toMatchObject({ state: "completed" });
    expect(row?.resultPayload).toMatchObject({
      ok: true,
      result: { turnId: "creq_machaaaaaa" },
    });
  });

  it("maps host_offline to a retryable machine_unavailable failure", async () => {
    const orch = orchestrator();
    await orch.openSession(openRequest({ leaseTimeoutMs: 60_000 }));
    fakes.machine.queueOutcome({ kind: "host_offline" });
    const { commandId } = await orch.enqueueCommand({
      type: "turn/start",
      command: turnStart("creq_offlineaaa"),
      threadId: "thr_audit",
    });
    const outcome = await orch.dispatchCommand({
      commandId,
      route: "machine",
    });
    expect(outcome.kind).toBe("settled");
    const row = await orch.getCommand({ commandId });
    expect(row).toMatchObject({ state: "failed" });
    expect(row?.resultPayload).toMatchObject({
      ok: false,
      errorCode: "machine_unavailable",
      retryable: true,
    });
  });

  it("settles immediately from a completed_cached journal hit", async () => {
    const orch = orchestrator();
    await orch.openSession(openRequest({ leaseTimeoutMs: 60_000 }));
    fakes.machine.queueOutcome({
      kind: "completed_cached",
      result: { cached: true },
    });
    const { commandId } = await orch.enqueueCommand({
      type: "turn/start",
      command: turnStart("creq_cacheaaaaa"),
      threadId: "thr_audit",
    });
    const outcome = await orch.dispatchCommand({
      commandId,
      route: "machine",
    });
    expect(outcome).toMatchObject({
      kind: "settled",
      outcome: { ok: true, result: { cached: true } },
    });
    expect(await orch.getCommand({ commandId })).toMatchObject({
      state: "completed",
    });
  });
});
