import { AgentDO } from "@cap/agent-do";
import { ManagerDo, type ManagerDoBindings } from "./manager-do.js";

/**
 * Wrangler main (ticket #28). The worker hosts only Durable Objects — the
 * manager registry and the per-thread agent DOs it spawns. All orchestration
 * arrives through the MANAGER / AGENT_DO bindings (or the in-process adapter
 * the daemon installs), so the fetch handler has no routes.
 *
 * `AgentDO` must be exported from the deployed entry for its DO namespace
 * binding to resolve; the relay/daemon injection happens manager-side
 * (`ensureAgentRuntime`) with the live env, so no module-scope wiring is
 * needed here.
 */

export interface Env extends ManagerDoBindings {
  /** R2 bucket for oversize agent event payloads (agent DO binding). */
  BLOBS?: R2Bucket;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("cap-provider-app: DO-only worker", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { AgentDO, ManagerDo };
