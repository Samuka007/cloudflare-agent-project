import { env } from "cloudflare:test";
import { expect } from "vitest";
import { newThreadId } from "@cap/protocol";
import type { AgentDO } from "../src/agent-do.js";
import type { AgentEventType, AnyAgentEvent } from "../src/fsm-events.js";
import { clearAgentRuntimes, setAgentRuntime } from "../src/injection.js";
import type { ModelProvider } from "../src/provider.js";
import { MockModelProvider, type MockTurn } from "../src/testing/mock-provider.js";
import type { TestDaemonServiceStub } from "../src/testing/test-daemon-do.js";

/**
 * Test rig: one agent DO (per-thread) + the reference fake daemon-service DO,
 * wired exactly like production (service DO carries the AGENT_DO binding and
 * pushes updates from its own I/O context).
 */

export interface RigOptions {
  turns?: MockTurn[];
  /** Overrides the mock (real-model smoke registers its relay client). */
  provider?: ModelProvider;
  threadId?: string;
  watchdog?: Record<string, number>;
}

export interface Rig {
  threadId: string;
  stub: DurableObjectStub<AgentDO>;
  provider: ModelProvider;
  /**
   * Mock-specific surface (billing probes); only valid when the rig runs
   * the default mock — a real-provider rig throws here by construction.
   */
  mock(): MockModelProvider;
  service: DurableObjectStub<TestDaemonServiceStub>;
  events(): Promise<AnyAgentEvent[]>;
  of(type: AgentEventType): Promise<AnyAgentEvent[]>;
  waitFor(predicate: (events: AnyAgentEvent[]) => boolean): Promise<AnyAgentEvent[]>;
  waitTurnComplete(turnId: string): Promise<AnyAgentEvent[]>;
  /** ops that must survive a hard kill get retried once after revival */
  afterAbort<T>(operation: () => Promise<T>): Promise<T>;
}

const agentNamespace = (env as { AGENT_DO: DurableObjectNamespace }).AGENT_DO;
const serviceNamespace = (env as { DAEMON_SERVICE: DurableObjectNamespace }).DAEMON_SERVICE;

export async function createRig(options: RigOptions = {}): Promise<Rig> {
  const threadId = options.threadId ?? newThreadId();
  const provider = options.provider ?? new MockModelProvider(options.turns ?? [{ deltas: ["ok"] }]);
  setAgentRuntime(threadId, { provider });
  /**
   * Stub factories, re-resolved on every access: `abortAllDurableObjects()`
   * poisons existing stub references permanently, so post-abort calls must go
   * through a fresh `namespace.get()` aimed at the revived incarnation.
   */
  const stubFor = (): DurableObjectStub<AgentDO> =>
    agentNamespace.get(agentNamespace.idFromName(threadId)) as DurableObjectStub<AgentDO>;
  const serviceFor = (): DurableObjectStub<TestDaemonServiceStub> =>
    serviceNamespace.get(
      serviceNamespace.idFromName(threadId),
    ) as unknown as DurableObjectStub<TestDaemonServiceStub>;
  // machineId = threadId: the fake service DO stays per-thread-named (the
  // rig's service stubs resolve by threadId), matching the per-machine real
  // seam's naming rule — the DO name is the machineId either way.
  const created = await stubFor().createThread({ threadId, title: "rig", machineId: threadId });
  expect(created.duplicated).toBe(false);
  if (options.watchdog !== undefined) {
    await stubFor().configureWatchdog(options.watchdog);
  }
  const events = async (): Promise<AnyAgentEvent[]> => {
    const response = await stubFor().getEvents({});
    return response.events;
  };
  const waitFor = async (
    predicate: (snapshot: AnyAgentEvent[]) => boolean,
  ): Promise<AnyAgentEvent[]> => {
    let snapshot = await events();
    await expect
      .poll(
        async () => {
          snapshot = await events();
          return predicate(snapshot) ? "yes" : "no";
        },
        { timeout: 20_000, interval: 100 },
      )
      .toBe("yes");
    return snapshot;
  };
  const rig: Rig = {
    threadId,
    get stub() {
      return stubFor();
    },
    provider,
    mock: () => {
      if (!(provider instanceof MockModelProvider)) {
        throw new Error("this rig was created with a non-mock provider");
      }
      return provider;
    },
    get service() {
      return serviceFor();
    },
    events,
    of: async (type) => (await events()).filter((event) => event.type === type),
    waitFor,
    waitTurnComplete: (turnId) =>
      waitFor((all) =>
        all.some(
          (event) =>
            (event.type === "turn.completed" ||
              event.type === "turn.failed" ||
              event.type === "turn.cancelled") &&
            event.data.turnId === turnId,
        ),
      ),
    afterAbort: async (operation) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return await operation();
        } catch (error) {
          if (attempt === 3) throw error;
          // abortAllDurableObjects poisons calls for a short window; the next
          // attempt lands on the fresh incarnation.
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 250);
          await promise;
        }
      }
      throw new Error("unreachable");
    },
  };
  return rig;
}

/** Tests register runtimes globally; drop them so files stay independent. */
export function resetRuntime(): void {
  clearAgentRuntimes();
}

/** Types of all events as a compact list (assertion helper). */
export function typeList(events: readonly AnyAgentEvent[]): AgentEventType[] {
  return events.map((event) => event.type);
}
