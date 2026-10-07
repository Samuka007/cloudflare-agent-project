import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { newThreadId } from "@cap/protocol";
import type { AgentDO } from "../src/agent-do.js";
import type { AgentEventType, AnyAgentEvent } from "../src/fsm-events.js";
import { clearAgentRuntimes, setAgentRuntime } from "../src/injection.js";
import { SYNTHETIC_RELAY_PROVIDER_ID, type RelaySelection } from "../src/provider-catalog.js";
import type { ModelProvider } from "../src/provider.js";
import { MockModelProvider, type MockTurn } from "../src/testing/mock-provider.js";
import { mockAgentRuntime } from "../src/testing/mock-runtime.js";
import type { TestDaemonServiceStub } from "../src/testing/test-daemon-do.js";
import { ensureMigrations } from "./migrate.js";

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
  /** Journaled create-time execution selection (#351; ask derives its
   * interaction providerId from it — #434). */
  execution?: RelaySelection;
  /** #326: booleans ride too (autoCompactionEnabled gate flips). */
  watchdog?: Record<string, number | boolean>;
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

/** Re-exported for the rig test files (they register runtimes directly). */
export { mockAgentRuntime };

export async function createRig(options: RigOptions = {}): Promise<Rig> {
  // The rig DB carries the composed deployment's control-plane schema
  // (test/migrate.ts) — terminal turns settle `threads` rows for real
  // instead of dying on `no such table` (#375). Idempotent replay: cheap
  // after the first rig in the worker context.
  await ensureMigrations();
  const threadId = options.threadId ?? newThreadId();
  const provider = options.provider ?? new MockModelProvider(options.turns ?? [{ deltas: ["ok"] }]);
  setAgentRuntime(threadId, mockAgentRuntime(provider));
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
  // #496: the DO never materializes a selection — a rig without an explicit
  // one pins the mock's single row at create (the send face refuses a
  // pinless thread with the named selection_missing error).
  const created = await stubFor().createThread({
    threadId,
    title: "rig",
    machineId: threadId,
    execution:
      options.execution ?? { providerId: SYNTHETIC_RELAY_PROVIDER_ID, model: "mock-model" },
  });
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
          const { promise, resolve } = Promise.withResolvers<undefined>();
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

/**
 * Real-model smoke wait for the tool-call phase's only two live outcomes: a
 * `tool.call` row, or a terminal row for the turn — a provider-side stream
 * break seals `turn.failed` mid-call and NO tool.call ever arrives (#375), so
 * a bare tool.call poll would burn its whole budget and die as a content-free
 * `'no' ≠ 'yes'`. This surfaces the journal's failure evidence instead, and
 * the longer budget covers real-model first-call TTFB (seconds to tens of
 * seconds through the relay) that the rig's 20s mock-oriented default
 * pinches. Returns the tool.call row.
 */
export async function waitForToolCallOrTerminal(rig: Rig, turnId: string): Promise<AnyAgentEvent> {
  let snapshot = await rig.events();
  let timedOut = false;
  let pollError: unknown;
  try {
    await expect
      .poll(
        async () => {
          snapshot = await rig.events();
          return snapshot.some((event) => event.type === "tool.call") ||
            snapshot.some(
              (event) =>
                (event.type === "turn.completed" ||
                  event.type === "turn.failed" ||
                  event.type === "turn.cancelled") &&
                event.data.turnId === turnId,
            )
            ? "yes"
            : "no";
        },
        { timeout: 60_000, interval: 100 },
      )
      .toBe("yes");
  } catch (error) {
    timedOut = true;
    pollError = error;
  }
  const toolCall = snapshot.find((event) => event.type === "tool.call");
  if (toolCall !== undefined) return toolCall;
  // No tool.call: the turn settled terminal (or the budget died) — the
  // journal holds the why (model.call_failed/turn.failed rows); surface it.
  const evidence = snapshot
    .filter(
      (event) =>
        event.type === "model.call_failed" ||
        event.type === "turn.failed" ||
        event.type === "turn.cancelled",
    )
    .map((event) => `${event.type}: ${JSON.stringify(event.data)}`)
    .join("; ");
  const detail =
    `turn ${turnId} ${timedOut ? "outlived the tool-call budget" : "settled"} without a ` +
    `tool.call — journal evidence: ${evidence === "" ? "none" : evidence}`;
  if (pollError !== undefined) throw new Error(detail, { cause: pollError });
  throw new Error(detail);
}

/** Types of all events as a compact list (assertion helper). */
export function typeList(events: readonly AnyAgentEvent[]): AgentEventType[] {
  return events.map((event) => event.type);
}
