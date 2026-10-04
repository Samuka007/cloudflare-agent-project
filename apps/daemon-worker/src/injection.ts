/**
 * In-process injection for the HostOrchestratorDO's execution handlers (same
 * pattern as packages/agent-do `injection.ts`). The DO is constructed by the
 * runtime, so its collaborators arrive via this registry instead of
 * constructor arguments; L1 tests (shared isolate) install fakes per test.
 */

import type { ProviderAdapter } from "./provider-adapter.js";
import type { MachineCommandDispatcher } from "./seam/machine-dispatch.js";

let providerAdapter: ProviderAdapter | undefined;
let machineDispatcher: MachineCommandDispatcher | undefined;

export function setProviderAdapter(adapter: ProviderAdapter): void {
  providerAdapter = adapter;
}

export function getProviderAdapter(): ProviderAdapter {
  if (providerAdapter === undefined) {
    throw new Error("no provider adapter installed — call setProviderAdapter() first");
  }
  return providerAdapter;
}

export function setMachineDispatcher(dispatcher: MachineCommandDispatcher): void {
  machineDispatcher = dispatcher;
}

export function getMachineDispatcher(): MachineCommandDispatcher {
  if (machineDispatcher === undefined) {
    throw new Error("no machine dispatcher installed — call setMachineDispatcher() first");
  }
  return machineDispatcher;
}

/** Test seam: drop all collaborators (shared-isolate suites reset per test). */
export function clearOrchestratorInjection(): void {
  providerAdapter = undefined;
  machineDispatcher = undefined;
}
