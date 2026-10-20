import { DurableAgentDO, type DurableAgentEnv, type DurableAgentRuntime } from "@cap/agent-durable";
import {
  DaemonServiceDO,
  daemonServiceWorker,
  requireDaemonCredentials,
  type WorkerEnv as DaemonServiceWorkerEnv,
} from "@cap/daemon-service";
import { createApp } from "./app";
import { updateHostRow, upsertAttachedHost } from "./db/hosts";
import { projectAttachmentReader } from "./services/attachment-pickup";
import { NotificationHubDO } from "./ws/hub";
import { LeaseStoreDO } from "./leases/lease-do";
import type { Env } from "./env";
import { createDurableRuntime } from "./durable-runtime";

/**
 * Composed deployment entry: the bb SPA (Workers Assets) → server control
 * plane → daemon-service DO → pi-durable agent DO → daemon client. There is
 * exactly one agent runtime; the legacy AgentDO/manager/orchestrator graph is
 * deleted.
 */

export { NotificationHubDO, LeaseStoreDO, DaemonServiceDO };

// Deployment-transition scaffolding (two-step #590 retirement): unbound inert
// stubs keeping the dormant legacy classes exportable until the v3
// deleted_classes migration lands. Removed together with v3 restoration —
// see legacy-do-stubs.ts. Never bind these.
export { ComposedAgentDO, ComposedHostOrchestratorDO, ManagerDo } from "./legacy-do-stubs";

/**
 * The per-thread pi-durable agent. The production subclass supplies the D1
 * provider catalog + daemon-host tool registry; the base owns the pi Harness,
 * journal, and alarm.
 */
export class ComposedDurableAgentDO extends DurableAgentDO {
  protected override createRuntime(
    env: DurableAgentEnv,
    ctx: DurableObjectState,
  ): Promise<DurableAgentRuntime> {
    return createDurableRuntime(env as unknown as Env, ctx);
  }
}

/** Route prefixes owned by the daemon-service front (#34) — never SPA/API.
 * /internal/session/ is the #318 attachment pickup family (bb /internal/*). */
const DAEMON_ROUTE_PREFIXES = [
  "/enroll",
  "/session/open",
  "/agent/",
  "/agent-sink/",
  "/internal/session/",
];

function isDaemonFace(request: Request, path: string): boolean {
  if (DAEMON_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) {
    return true;
  }
  // /ws is the SPA realtime hub AND the daemon client attach point: the
  // client always presents its Bearer hostKey on the upgrade (browser
  // WebSockets cannot set headers, so the hub upgrade never carries one).
  return path === "/ws" && request.headers.has("authorization");
}

function requireDaemonService(env: Env): DurableObjectNamespace {
  if (env.DAEMON_SERVICE === undefined) {
    throw new Error("DAEMON_SERVICE binding is required to serve the daemon face");
  }
  return env.DAEMON_SERVICE;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (isDaemonFace(request, path)) {
      // #398/SEC-W5-002: no repo-public fallback — a deployment without its
      // daemon secrets fails closed on the daemon face.
      const { enrollKey, hostKey } = requireDaemonCredentials(env);
      const serviceEnv: DaemonServiceWorkerEnv = {
        DAEMON_SERVICE: requireDaemonService(env),
        AGENT_DO: env.AGENT_DO,
        // #195 S3: the rejection path consumes the retry-update flag and
        // broadcasts host-disconnected through the hub.
        HUB: env.HUB,
        ENROLL_KEY: enrollKey,
        DAEMON_HOST_KEY: hostKey,
        DAEMON_EDGE_KV: env.DAEMON_EDGE_KV,
        // #49: daemon attach → control-plane host registry (the /hosts face);
        // #195 S3: protocol rejections stamp last_rejected_protocol_version.
        onDaemonAttach: (hostId, info) => upsertAttachedHost(env, hostId, info),
        onDaemonProtocolReject: async (hostId, protocolVersion) => {
          await updateHostRow(env, hostId, { lastRejectedProtocolVersion: protocolVersion });
        },
        // #318: the pickup route's thread→project cross-check + R2 read.
        readProjectAttachment: projectAttachmentReader(env),
      };
      return daemonServiceWorker.fetch(request, serviceEnv);
    }
    const app = createApp(env);
    return app.fetch(request, env, ctx);
  },

  /**
   * bb ran a 10s in-process sweep; the Workers equivalent is Cron Triggers as
   * a backstop plus DO alarms for per-item timing. The cron pings the lease
   * store; daemon session sweeps ride DO alarms.
   */
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
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
