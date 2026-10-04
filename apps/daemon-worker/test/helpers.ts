import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type {
  AdapterCommand,
  AdapterCommandOutcome,
  AdapterCommandType,
} from "../src/provider-adapter.js";
import type {
  CommandDispatchOutcome,
  CommandSettleOutcome,
  DaemonMessageReceipt,
  DisconnectDisposition,
  HostDaemonCommandAttemptRow,
  HostDaemonCommandRow,
  HostDaemonSessionRow,
  SessionOpenOutcome,
  SocketAttachOutcome,
} from "../src/host-orchestrator-do.js";
import type { DaemonServerMessage, HostDaemonSessionOpenRequest } from "../src/session-contract.js";
import type { DaemonWatchSet, WatchSetApplyArgs } from "../src/watch-set.js";
import { setMachineDispatcher, setProviderAdapter } from "../src/injection.js";
import { FakeMachineDispatcher, FakeProviderAdapter } from "../src/testing/fake-provider.js";
import { DAEMON_PROTOCOL_VERSION } from "../src/constants.js";

/**
 * L1 fixtures: one orchestrator DO per unique name; the injection registry is
 * global to the shared isolate, so every test installs fresh fakes before
 * each test (`installFakes`).
 *
 * The stub is typed structurally — the same convention as
 * apps/server-worker's lease-do suite. Every entry point crosses the real DO
 * RPC boundary, so even sync class methods resolve through Promises here.
 */
export interface OrchestratorStub {
  openSession(
    args: HostDaemonSessionOpenRequest & {
      heartbeatIntervalMs?: number;
      leaseTimeoutMs?: number;
    },
  ): Promise<SessionOpenOutcome>;
  ensureHost(args: {
    hostId: string;
  }): Promise<{ kind: "bound"; hostId: string } | { kind: "host_mismatch"; boundHostId: string }>;
  attachSocket(args: {
    sessionId: string;
    hostId: string;
    wsSubprotocol?: string;
  }): Promise<SocketAttachOutcome>;
  detachSocket(args: {
    sessionId: string;
    graceMs?: number;
  }): Promise<{ closed: boolean; graceDeadlineAt: number | null }>;
  recordDaemonMessage(args: { sessionId: string }): Promise<DaemonMessageReceipt>;
  heartbeat(args: { sessionId: string }): Promise<DaemonMessageReceipt>;
  getSession(args: { sessionId: string }): Promise<HostDaemonSessionRow | null>;
  getLatestSessionForHost(): Promise<HostDaemonSessionRow | null>;
  listSessions(): Promise<HostDaemonSessionRow[]>;
  listDisconnectDispositions(): Promise<DisconnectDisposition[]>;
  enqueueCommand(args: {
    type: AdapterCommandType;
    command: AdapterCommand;
    threadId?: string;
  }): Promise<{ commandId: string; cursor: number }>;
  dispatchCommand(args: {
    commandId: string;
    timeoutMs?: number;
    route?: "provider" | "machine";
  }): Promise<CommandDispatchOutcome>;
  settleCommand(args: {
    commandId: string;
    attemptId: string;
    outcome: AdapterCommandOutcome;
  }): Promise<CommandSettleOutcome>;
  retryCommand(args: { commandId: string }): Promise<{
    queued: boolean;
    state: HostDaemonCommandRow["state"] | null;
    retryCount: number | null;
  }>;
  getCommand(args: { commandId: string }): Promise<HostDaemonCommandRow | null>;
  listCommands(): Promise<HostDaemonCommandRow[]>;
  listAttempts(args: { commandId: string }): Promise<HostDaemonCommandAttemptRow[]>;
  applyWatchInterests(args: WatchSetApplyArgs): Promise<{ emitted: boolean; generation: number }>;
  reconcileWatchSet(): Promise<DaemonWatchSet>;
  drainDaemonOutbox(): Promise<DaemonServerMessage[]>;
}

export interface InstalledFakes {
  provider: FakeProviderAdapter;
  machine: FakeMachineDispatcher;
}

/**
 * DO storage persists for the whole test file, so two tests sharing one DO
 * name see each other's rows. Default the DO identity to the current test's
 * full name — one fresh orchestrator per test; pass an explicit name only to
 * deliberately share state.
 */
function testScopedName(name?: string): string {
  return name ?? `test:${String(expect.getState().currentTestName)}`;
}

export function orchestratorFor(name?: string): OrchestratorStub {
  // tsc and eslint's type program disagree on this assignment: checking the
  // raw RPC stub against OrchestratorStub exceeds TS's instantiation depth
  // (TS2589), while eslint's no-unnecessary-type-assertion calls the same
  // cast redundant. Keep the cast; suppress the false positive.
  const stub = env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName(testScopedName(name)));
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TS2589 without it; see above
  return stub as unknown as OrchestratorStub;
}

/**
 * The raw RPC stub, typed for `runDurableObjectAlarm` — the structural stub
 * above deliberately cannot name workers-types' branded envelope.
 */
export function alarmStubFor(name?: string): Parameters<typeof runDurableObjectAlarm>[0] {
  return env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName(testScopedName(name)));
}

export function installFakes(): InstalledFakes {
  const provider = new FakeProviderAdapter();
  const machine = new FakeMachineDispatcher();
  setProviderAdapter(provider);
  setMachineDispatcher(machine);
  return { provider, machine };
}

/** bb session-open request with M0-required fields filled. */
export function openRequest(
  overrides?: Partial<HostDaemonSessionOpenRequest> & {
    leaseTimeoutMs?: number;
    heartbeatIntervalMs?: number;
  },
): HostDaemonSessionOpenRequest & {
  leaseTimeoutMs?: number;
  heartbeatIntervalMs?: number;
} {
  return {
    hostId: "host-A",
    instanceId: "inst-1",
    hostName: "Host A",
    hostType: "linux",
    hasMachineCredential: false,
    platform: "linux",
    dataDir: "/data",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    activeThreads: [],
    ...overrides,
  };
}
