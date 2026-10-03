
/**
 * Worker bindings. `AgentDO` is owned by ticket #29 (packages/agent-do);
 * this control plane only programs against the seam in `src/seam/agent-do.ts`.
 */
export interface Env {
  /** Control-plane tables (threads, projects, sections, hosts, settings). */
  DB: D1Database;
  /** Public WS fan-out + event waiters + disconnect grace. */
  HUB: DurableObjectNamespace;
  /** Preview/file leases with alarm-based TTL eviction (bb previewLeases). */
  LEASES: DurableObjectNamespace;
  /** Per-thread event log + turn state (ticket #29). */
  AGENT_DO: DurableObjectNamespace;
  /** Static SPA bundle (bb apps/app dist). */
  ASSETS: Fetcher;

  // --- vars -----------------------------------------------------------------

  /**
   * Cloudflare Access gate. Staging flag (ruling: config-gated until the
   * staging Worker fronts real Access): "true" enforces JWT validation on
   * /api/v1/* and /ws; anything else leaves the gate open (L1/local).
   */
  readonly ACCESS_CHECK_ENABLED?: string;
  /** e.g. "https://myteam.cloudflareaccess.com" — JWKS source. */
  readonly ACCESS_TEAM_DOMAIN?: string;
  /** Access application AUD claim. */
  readonly ACCESS_AUD?: string;
  /** Extra browser origins the Origin guard / CORS accept (comma-separated). */
  readonly APP_EXTRA_ORIGINS?: string;
  /** Version banner for /system/version (bb appVersion.currentVersion). */
  readonly SERVER_VERSION?: string;
  /** bb config.dataDir analogue; the Worker has no fs — surface value only. */
  readonly DATA_DIR?: string;
  /** bb config.hostDaemonPort analogue; null when unset. */
  readonly HOST_DAEMON_PORT?: string;
}
