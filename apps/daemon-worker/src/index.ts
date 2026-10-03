import { HostOrchestratorDO } from "./host-orchestrator-do.js";
import { setProviderAdapter } from "./injection.js";

/**
 * The daemon worker hosts only Durable Objects in M0 — every orchestration
 * surface is reached through the ORCHESTRATOR binding, so the fetch handler
 * has no routes. The HTTP face (if any) arrives with the daemon client (#34).
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("cap-daemon-worker: DO-only worker", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { HostOrchestratorDO, setProviderAdapter };
export type {
  AdapterCommand,
  AdapterCommandOutcome,
  ProviderExecutionContext,
} from "./provider-adapter.js";
