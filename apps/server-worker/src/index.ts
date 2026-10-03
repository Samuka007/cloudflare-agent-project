import {
  AgentDO,
  setAgentRuntime,
  type AgentDoBindings,
} from "@cap/agent-do";
import { DaemonServiceDO, daemonServiceWorker, type WorkerEnv as DaemonServiceWorkerEnv } from "@cap/daemon-service";
import { HostOrchestratorDO, setProviderAdapter } from "@cap/daemon-worker";
import {
  ManagerDo,
  createEdgeAgentAdapter,
  relayProviderFrom,
  resolveHarness,
  type HarnessEnv,
  type ManagerDoBindings,
} from "@cap/provider-app";
import { createApp } from "./app.js";
import { NotificationHubDO } from "./ws/hub.js";
import { LeaseStoreDO } from "./leases/lease-do.js";
import type { Env } from "./env.js";

/**
 * Composed deployment entry (#31, wrangler.jsonc mains this file): the bb SPA
 * (Workers Assets) → server control plane (#26) → daemon-worker command
 * journal (#27) → provider-app adapter + manager registry (#28) → per-thread
 * agent DO (#29) → per-machine daemon service DO (#30) → daemon client.
 *
 * DO exports: every class the composed binding graph reaches. The two
 * composed wrappers below exist because workerd runs each DO in an isolate
 * whose module globals are separate from the entry fetch handler's —
 * per-request registration would miss them. They self-register their
 * collaborators from the constructor env instead, so every isolate resolves
 * the same deterministic configuration.
 */

export { NotificationHubDO, LeaseStoreDO, ManagerDo, DaemonServiceDO };

/**
 * The per-thread agent DO with per-isolate relay registration: the manager's
 * ensureAgentRuntime covers the manager's own isolate; this covers every
 * isolate that hosts an agent DO (turn drivers resolve the provider through
 * the module-global injection registry, agent-do/src/injection.ts).
 */
export class ComposedAgentDO extends AgentDO {
  constructor(ctx: DurableObjectState, env: AgentDoBindings) {
    super(ctx, env);
    setAgentRuntime("*", {
      provider: relayProviderFrom(resolveHarness(env as AgentDoBindings & HarnessEnv)),
    });
  }
}

/**
 * The per-host orchestrator with in-isolate adapter installation: the
 * provider lane resolves its adapter through the daemon-worker injection
 * registry, so the install must happen in the DO's own isolate.
 */
export class ComposedHostOrchestratorDO extends HostOrchestratorDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env as unknown as ConstructorParameters<typeof HostOrchestratorDO>[1]);
    setProviderAdapter(createEdgeAgentAdapter(env as Env & ManagerDoBindings & { MANAGER: DurableObjectNamespace }));
  }
}

/** Route prefixes owned by the daemon-service front (#34) — never SPA/API. */
const DAEMON_ROUTE_PREFIXES = ["/enroll", "/session/open", "/agent/", "/agent-sink/"];

function isDaemonFace(request: Request, path: string): boolean {
  if (DAEMON_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) {
    return true;
  }
  // /ws is the SPA realtime hub AND the daemon client attach point: the
  // client always presents its Bearer hostKey on the upgrade (browser
  // WebSockets cannot set headers, so the hub upgrade never carries one).
  return path === "/ws" && request.headers.has("authorization");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (isDaemonFace(request, path)) {
      const serviceEnv: DaemonServiceWorkerEnv = {
        DAEMON_SERVICE: env.DAEMON_SERVICE!,
        AGENT_DO: env.AGENT_DO,
        ENROLL_KEY: env.ENROLL_KEY ?? "[REDACTED-staging-secret]",
        DAEMON_HOST_KEY: env.DAEMON_HOST_KEY ?? "[REDACTED-staging-secret]",
        DAEMON_HOST_ID: env.DAEMON_HOST_ID,
        DAEMON_MACHINE_ID: env.DAEMON_MACHINE_ID,
      };
      return daemonServiceWorker.fetch(request, serviceEnv);
    }
    const app = createApp(env);
    return app.fetch(request, env, ctx);
  },

  /**
   * bb ran a 10s in-process sweep (start-server.ts:225-228); the Workers
   * equivalent is Cron Triggers as a backstop plus DO alarms for per-item
   * timing. The cron pings the lease store; daemon session sweeps ride DO
   * alarms (#27/#30).
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const id = env.LEASES.idFromName("leases");
        const stub = env.LEASES.get(id) as DurableObjectStub & {
          evictExpired(): Promise<{ evicted: number }>;
        };
        await stub.evictExpired();
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
