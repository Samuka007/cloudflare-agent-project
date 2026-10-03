import { AgentDO, type AgentDoBindings } from "./agent-do.js";
import { TestDaemonServiceDO } from "./testing/test-daemon-do.js";
import { DaemonServiceDO, daemonServiceWorker, type WorkerEnv } from "@cap/daemon-service";

/**
 * Wrangler mains. `AgentDO` must be exported from the deployed entry; the
 * fake `TestDaemonServiceDO` serves this package's own L1 rig, and the REAL
 * `DaemonServiceDO` (#30) is exported for the composed deployment — the
 * hookup rig binds it as `DAEMON_SERVICE`.
 */
export { AgentDO, TestDaemonServiceDO, DaemonServiceDO };

/** Route prefixes served by the landed daemon-service worker (#30). */
const DAEMON_ROUTE_PREFIXES = ["/health", "/enroll", "/session/open", "/ws", "/agent/"];

/**
 * Composed dev/integration worker: the agent DO seam plus the daemon-service
 * HTTP front (enroll → session/open → WS), which forwards into the
 * per-machine DaemonServiceDO. Production decomposition (agent worker vs
 * daemon worker) is the cutover ticket's shape; this composition is what the
 * full-chain hookup smoke runs against.
 */
export default {
  async fetch(
    request: Request,
    env: AgentDoBindings & Partial<WorkerEnv>,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (DAEMON_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) {
      const serviceEnv: WorkerEnv = {
        DAEMON_SERVICE: env.DAEMON_SERVICE!,
        AGENT_DO: env.AGENT_DO!,
        ENROLL_KEY: env.ENROLL_KEY ?? "poc-dev-enroll-key",
        DAEMON_HOST_KEY: env.DAEMON_HOST_KEY ?? "poc-dev-host-key",
        DAEMON_HOST_ID: env.DAEMON_HOST_ID,
        DAEMON_MACHINE_ID: env.DAEMON_MACHINE_ID,
      };
      return daemonServiceWorker.fetch(request, serviceEnv);
    }
    return new Response("agent-do: DO-only worker (bind AGENT_DO)", { status: 404 });
  },
} satisfies ExportedHandler<AgentDoBindings & Partial<WorkerEnv>>;
