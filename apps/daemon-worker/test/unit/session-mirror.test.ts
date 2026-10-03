import { beforeEach, describe, expect, it } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import { DAEMON_PROTOCOL_VERSION, DAEMON_WS_SUBPROTOCOL } from "../../src/constants.js";
import type { OrchestratorStub } from "../helpers.js";
import {
  alarmStubFor,
  installFakes,
  openRequest,
  orchestratorFor,
} from "../helpers.js";

/**
 * Session mirror semantics, aligned test-by-test with bb-daemon-protocol.md
 * §1-§2 (open → WS attach handshake, heartbeat/lease, replace, grace) and §4.3
 * (disconnect). Named after the protocol facts they pin.
 */

const orchestrator = (): OrchestratorStub =>
  orchestratorFor();

beforeEach(() => {
  installFakes();
});

async function open(overrides?: Parameters<typeof openRequest>[0]) {
  return orchestrator().openSession(
    openRequest({ leaseTimeoutMs: 400, ...overrides }),
  );
}

describe("session open (bb §2.1 + §3)", () => {
  it("returns sessionId, heartbeat/lease params and the reconciled watch set", async () => {
    const outcome = await open();
    expect(outcome.kind).toBe("opened");
    if (outcome.kind !== "opened") return;
    expect(outcome.session.id).toMatch(/^hses_/);
    expect(outcome.session.status).toBe("active");
    expect(outcome.session.heartbeatIntervalMs).toBe(5_000);
    expect(outcome.session.leaseTimeoutMs).toBe(400);
    expect(outcome.session.leaseExpiresAt).toBeGreaterThan(Date.now());
    expect(outcome.watchSet).toEqual({
      generation: 0,
      workspaceTargets: [],
      threadStorageTargets: [],
    });
  });

  it("rejects protocol version mismatch with strict equality (bb §3)", async () => {
    const outcome = await open({ protocolVersion: DAEMON_PROTOCOL_VERSION + 1 });
    expect(outcome).toEqual({
      kind: "protocol_version_mismatch",
      details: {
        serverProtocolVersion: DAEMON_PROTOCOL_VERSION,
        rejectedProtocolVersion: DAEMON_PROTOCOL_VERSION + 1,
      },
    });
    // bb records lastRejectedProtocolVersion for the UI badge.
    const latest = await orchestrator().getLatestSessionForHost();
    expect(latest).toBeNull();
  });
});

describe("WS attach handshake (bb §2.1 三件套)", () => {
  it("rejects attach before open — open comes first, then WS attach", async () => {
    const outcome = await orchestrator().attachSocket({
      sessionId: "hses_missing",
      hostId: "host-A",
    });
    expect(outcome).toEqual({
      kind: "rejected",
      closeCode: 1008,
      reason: "inactive-session",
    });
  });

  it("rejects a wrong WS subprotocol (bb-host-daemon.v1 discipline)", async () => {
    const opened = await open();
    if (opened.kind !== "opened") throw new Error("open failed");
    const outcome = await orchestrator().attachSocket({
      sessionId: opened.session.id,
      hostId: "host-A",
      wsSubprotocol: "wrong-protocol.v9",
    });
    expect(outcome).toEqual({
      kind: "rejected",
      closeCode: 1008,
      reason: "unsupported-protocol",
    });
    // The correct subprotocol attaches.
    const good = await orchestrator().attachSocket({
      sessionId: opened.session.id,
      hostId: "host-A",
      wsSubprotocol: DAEMON_WS_SUBPROTOCOL,
    });
    expect(good.kind).toBe("attached");
  });

  it("rejects a session belonging to another host (bb sessionId ownership)", async () => {
    const opened = await open();
    if (opened.kind !== "opened") throw new Error("open failed");
    const outcome = await orchestrator().attachSocket({
      sessionId: opened.session.id,
      hostId: "host-B",
    });
    expect(outcome).toEqual({
      kind: "rejected",
      closeCode: 1008,
      reason: "unauthorized-session",
    });
  });
});

describe("replace on re-open (bb §2.1 + session-owner-side-effects)", () => {
  it("same-instance reopen closes only the superseded socket, no session-close frame", async () => {
    const orch = orchestrator();
    const first = await open();
    if (first.kind !== "opened") throw new Error("open failed");
    await orch.attachSocket({ sessionId: first.session.id, hostId: "host-A" });

    const second = await open({ instanceId: "inst-1" });
    expect(second.kind).toBe("opened");
    if (second.kind !== "opened") throw new Error("open failed");
    expect(second.previousSessionId).toBe(first.session.id);
    expect(second.replacedDisposition).toBe("socket-only");

    const oldSession = await orch.getSession({ sessionId: first.session.id });
    expect(oldSession).toMatchObject({
      status: "closed",
      closeReason: "replaced",
      socketAttached: false,
    });
    expect(await orch.drainDaemonOutbox()).toEqual([]);
  });

  it("different-instance reopen sends session-close replaced to the daemon", async () => {
    const orch = orchestrator();
    const first = await open();
    if (first.kind !== "opened") throw new Error("open failed");
    await orch.attachSocket({ sessionId: first.session.id, hostId: "host-A" });

    const second = await open({ instanceId: "inst-2" });
    if (second.kind !== "opened") throw new Error("open failed");
    expect(second.replacedDisposition).toBe("session-close");

    const frames = await orch.drainDaemonOutbox();
    expect(frames).toEqual([{ type: "session-close", reason: "replaced" }]);
  });
});

describe("heartbeat and lease (bb §2.1)", () => {
  it("renews the lease to max(now + leaseTimeoutMs, previousExpiry + 1)", async () => {
    const orch = orchestrator();
    const opened = await open({ leaseTimeoutMs: 300 });
    if (opened.kind !== "opened") throw new Error("open failed");
    const sessionId = opened.session.id;
    const expiry1 = opened.session.leaseExpiresAt;

    const renewed = await orch.heartbeat({ sessionId });
    expect(renewed).toEqual({ kind: "renewed", leaseExpiresAt: expect.any(Number) });
    if (renewed.kind !== "renewed") return;
    // Second renewal inside the same window: now+300 wins over expiry1+1.
    expect(renewed.leaseExpiresAt).toBeGreaterThanOrEqual(expiry1);

    // Any valid daemon message renews too — heartbeat is not privileged.
    const viaMessage = await orch.recordDaemonMessage({ sessionId });
    expect(viaMessage.kind).toBe("renewed");
  });

  it("closes expired sessions with reason 'expired' via the alarm sweep", async () => {
    const orch = orchestrator();
    const opened = await open({ leaseTimeoutMs: 0 });
    if (opened.kind !== "opened") throw new Error("open failed");
    // Forces the alarm if pending; a fire between scheduling and here still
    // leaves the session closed — the close is what matters.
    await runDurableObjectAlarm(alarmStubFor());
    const session = await orch.getSession({ sessionId: opened.session.id });
    expect(session).toMatchObject({ status: "closed", closeReason: "expired" });
  });

  it("answers messages on an expired session with inactive (close 1008 path)", async () => {
    const orch = orchestrator();
    const opened = await open({ leaseTimeoutMs: 0 });
    if (opened.kind !== "opened") throw new Error("open failed");
    const receipt = await orch.recordDaemonMessage({
      sessionId: opened.session.id,
    });
    expect(receipt).toEqual({ kind: "inactive" });
  });
});

describe("disconnect grace (bb §4.3)", () => {
  it("closes the session immediately on socket drop and schedules the grace", async () => {
    const orch = orchestrator();
    const opened = await open({ leaseTimeoutMs: 60_000 });
    if (opened.kind !== "opened") throw new Error("open failed");
    await orch.attachSocket({ sessionId: opened.session.id, hostId: "host-A" });

    // A long window: miniflare delivers alarms in real time, so a short
    // grace would race the background sweep this assertion forbids.
    const detached = await orch.detachSocket({
      sessionId: opened.session.id,
      graceMs: 60_000,
    });
    expect(detached.closed).toBe(true);
    expect(detached.graceDeadlineAt).toBeGreaterThan(Date.now());

    const session = await orch.getSession({ sessionId: opened.session.id });
    expect(session).toMatchObject({
      status: "closed",
      closeReason: "daemon-disconnect",
      socketAttached: false,
    });
    // No disposition yet — the grace window is open.
    expect(await orch.listDisconnectDispositions()).toEqual([]);
  });

  it("records the grace disposition once when no reconnect happens", async () => {
    const orch = orchestrator();
    const opened = await open({ leaseTimeoutMs: 60_000 });
    if (opened.kind !== "opened") throw new Error("open failed");
    await orch.attachSocket({ sessionId: opened.session.id, hostId: "host-A" });
    await orch.detachSocket({ sessionId: opened.session.id, graceMs: 0 });

    await runDurableObjectAlarm(alarmStubFor());
    const dispositions = await orch.listDisconnectDispositions();
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]).toMatchObject({
      sessionId: opened.session.id,
      hostId: "host-A",
      kind: "daemon-disconnect-grace-completed",
    });

    // A second alarm run must not duplicate the disposition.
    await runDurableObjectAlarm(alarmStubFor());
    expect(await orch.listDisconnectDispositions()).toHaveLength(1);
  });

  it("skips the grace disposition when the host reconnected (any live socket)", async () => {
    const orch = orchestrator();
    const first = await open({ leaseTimeoutMs: 60_000 });
    if (first.kind !== "opened") throw new Error("open failed");
    await orch.attachSocket({ sessionId: first.session.id, hostId: "host-A" });
    await orch.detachSocket({ sessionId: first.session.id, graceMs: 60_000 });

    // Reconnect: new session open + attach inside the grace window (bb cancels
    // the pending disconnect and hasDaemonForHost then answers true).
    const second = await open({ leaseTimeoutMs: 60_000, instanceId: "inst-9" });
    if (second.kind !== "opened") throw new Error("reopen failed");
    await orch.attachSocket({ sessionId: second.session.id, hostId: "host-A" });

    await runDurableObjectAlarm(alarmStubFor());
    expect(await orch.listDisconnectDispositions()).toEqual([]);
  });
});
