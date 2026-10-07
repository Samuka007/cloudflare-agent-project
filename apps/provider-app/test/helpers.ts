import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  clearAgentRuntimes,
  type AgentEventRecord,
  type AgentEventType,
  setAgentRuntime,
  type AgentDO,
} from "@cap/agent-do";
import { MockModelProvider, mockAgentRuntime, type MockTurn } from "@cap/agent-do/testing";
import type {
  AdapterCommandOutcome,
  ProviderExecutionContext,
} from "../../daemon-worker/src/provider-adapter.js";
import type {
  RuntimeThreadExecutionOptions,
  RuntimePermissionPolicy,
} from "../../daemon-worker/src/provider-types.js";
import { EdgeAgentProviderAdapter } from "../src/adapter.js";
import type { ManagerFacade } from "../src/adapter.js";
import { ManagerDo } from "../src/manager-do.js";
import type { HarnessEnv } from "../src/harness.js";
import { resolveHarness } from "../src/harness.js";

/**
 * L1 rig (ticket #28): the manager DO under unique names per test, the real
 * AgentDO class bound as AGENT_DO, and the edge-agent adapter delegating to
 * manager stubs — wired exactly like the composed deployment.
 */

// The vitest ProvidedEnv type doesn't declare the wrangler bindings; the
// worker env is fixed by wrangler.jsonc, so one named cast covers the module.
const bindings = env as { MANAGER: DurableObjectNamespace; AGENT_DO: DurableObjectNamespace };
const managerNs = bindings.MANAGER;
const agentNs = bindings.AGENT_DO;

export function managerStubByName(name: string): DurableObjectStub<ManagerDo> {
  return managerNs.get(managerNs.idFromName(name)) as unknown as DurableObjectStub<ManagerDo>;
}

export function freshManagerName(): string {
  return `mgr-${crypto.randomUUID()}`;
}

export function agentStubByName(name: string): DurableObjectStub<AgentDO> {
  return agentNs.get(agentNs.idFromName(name)) as unknown as DurableObjectStub<AgentDO>;
}

export function adapterFor(
  manager: ManagerFacade,
  harnessEnv: HarnessEnv = {},
): EdgeAgentProviderAdapter {
  return new EdgeAgentProviderAdapter(manager, resolveHarness(harnessEnv));
}

export function managerFacadeByName(name: string): ManagerFacade {
  // tsc and eslint's type program disagree on this assignment: checking the
  // raw RPC stub against ManagerFacade exceeds TS's instantiation depth
  // (TS2589), while eslint's no-unnecessary-type-assertion calls the same
  // cast redundant. Keep the cast; suppress the false positive.
  const stub = managerStubByName(name);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TS2589 without it; see above
  return stub as unknown as ManagerFacade;
}

/** Exact-key mock above the manager's `*` fallback — returns the provider. */
export function registerMock(
  threadId: string,
  turns: MockTurn[] = [{ deltas: ["ok"] }],
): MockModelProvider {
  const provider = new MockModelProvider(turns);
  setAgentRuntime(threadId, mockAgentRuntime(provider));
  return provider;
}

/** bb-shaped execution options with a full permission policy. */
export function executionOptions(
  overrides?: Partial<
    Pick<
      RuntimeThreadExecutionOptions,
      "model" | "reasoningLevel" | "serviceTier" | "permissionMode"
    >
  >,
): RuntimeThreadExecutionOptions {
  const mode = overrides?.permissionMode ?? "full";
  const policy: RuntimePermissionPolicy =
    mode === "accept-edits"
      ? {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "deny",
        }
      : mode === "auto"
        ? {
            permissionMode: "auto",
            permissionScope: "workspace",
            approvalReviewer: "automatic",
            permissionEscalation: "deny",
          }
        : {
            permissionMode: "full",
            permissionScope: "full",
            approvalReviewer: null,
            permissionEscalation: null,
          };
  return {
    model: overrides?.model ?? "glm-5.3",
    serviceTier: overrides?.serviceTier ?? "default",
    reasoningLevel: overrides?.reasoningLevel ?? "none",
    workflowsEnabled: false,
    ...policy,
  };
}

export function executionContext(
  options: RuntimeThreadExecutionOptions = executionOptions(),
): ProviderExecutionContext {
  return { ...options, claudeCodeMockCliTraffic: { enabled: false, endpoint: "" } };
}

export function expectOk(outcome: AdapterCommandOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    throw new Error(`expected ok outcome, got ${outcome.errorCode}: ${outcome.errorMessage}`);
  }
  return outcome.result as Record<string, unknown>;
}

/** Runtime-narrowed string field off a successful result payload. */
export function stringField(result: Record<string, unknown>, key: string): string {
  const value = result[key];
  if (typeof value !== "string") {
    throw new Error(`expected result field "${key}" to be a string, got ${typeof value}`);
  }
  return value;
}

/**
 * Discriminated agent event union — the default-generic AgentEventRecord is
 * NOT discriminated (type collapses to the union), so rebuild the mapped
 * union exactly as fsm-events defines AnyAgentEvent.
 */
export type AgentEvent = {
  [T in AgentEventType]: AgentEventRecord<T>;
}[AgentEventType];

export function assertFailure(outcome: AdapterCommandOutcome, errorCode: string): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error(`expected ${errorCode} failure`);
  expect(outcome.errorCode).toBe(errorCode);
}

/** Events of the thread's agent DO (DO name = threadId, #31 convention). */
export async function eventsOf(threadId: string): Promise<AgentEvent[]> {
  const result = await agentStubByName(threadId).getEvents({});
  return result.events;
}

/** Poll until the agent DO reports a terminal event for the turn. */
export async function waitTurnComplete(threadId: string, turnId: string): Promise<AgentEvent[]> {
  let snapshot: AgentEvent[] = [];
  await expect
    .poll(
      async () => {
        snapshot = await eventsOf(threadId);
        return snapshot.some(
          (event) =>
            (event.type === "turn.completed" ||
              event.type === "turn.failed" ||
              event.type === "turn.cancelled") &&
            event.data.turnId === turnId,
        )
          ? "yes"
          : "no";
      },
      { timeout: 20_000, interval: 100 },
    )
    .toBe("yes");
  return snapshot;
}

/**
 * `abortAllDurableObjects()` poisons stub references for a short window; the
 * next attempt must land on the fresh incarnation (agent-do rig pattern).
 */
export async function afterAbort<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === 3) throw error;
      const { promise, resolve } = Promise.withResolvers<undefined>();
      setTimeout(resolve, 250);
      await promise;
    }
  }
  throw new Error("unreachable");
}

/** Tests register agent runtimes globally; drop them between files/tests. */
export function resetRuntime(): void {
  clearAgentRuntimes();
}
