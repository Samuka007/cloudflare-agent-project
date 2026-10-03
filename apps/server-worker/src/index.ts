import { AgentDO } from "@cap/agent-do";
import { createApp } from "./app.js";
import { NotificationHubDO } from "./ws/hub.js";
import { LeaseStoreDO } from "./leases/lease-do.js";
import type { Env } from "./env.js";

/**
 * Worker entry (bb apps/server/src/start-server.ts assembly root).
 * Durable object exports: the control-plane DOs (hub, leases) and the
 * per-thread agent DO owned by #29 (binding AGENT_DO).
 */
export { NotificationHubDO, LeaseStoreDO, AgentDO };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = createApp(env);
    return app.fetch(request, env, ctx);
  },

  /**
   * bb ran a 10s in-process sweep (start-server.ts:225-228); the Workers
   * equivalent is Cron Triggers as a backstop plus DO alarms for per-item
   * timing. The cron pings the lease store; daemon session sweeps arrive
   * with #30.
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
