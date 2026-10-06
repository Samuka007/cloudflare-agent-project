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
  /**
   * Per-host command journal + session mirror (#27). Bound in the composed
   * deployment (#31): when present, the control plane's WRITE verbs
   * (create/send/stop) route through the journal's provider lane instead of
   * touching the agent DO directly.
   */
  ORCHESTRATOR?: DurableObjectNamespace;
  /** Provider session registry (#28); pairs with ORCHESTRATOR above. */
  MANAGER?: DurableObjectNamespace;
  /** Per-machine daemon service DO (#30) — the agent DO's execution seam. */
  DAEMON_SERVICE?: DurableObjectNamespace;
  /**
   * Edge-shield auth-hash cache (#36) for the composed daemon face. The DO
   * mirror is the authority; this is a pure cache. Optional: env-key-only
   * deployments run without it.
   */
  readonly DAEMON_EDGE_KV?: KVNamespace;
  /** Edge-shield tunables (#36); unset = named-constant defaults. */
  readonly DAEMON_NEGATIVE_CACHE_MS?: string;
  readonly DAEMON_RATE_LIMIT_CAPACITY?: string;
  readonly DAEMON_RATE_LIMIT_REFILL_PER_SEC?: string;
  /** Static SPA bundle (bb apps/app dist). */
  ASSETS: Fetcher;
  /**
   * R2 bucket backing the project attachment family
   * `attachment/<projectId>/<sha256><ext>` (#316). Optional like
   * provider-app's BLOBS (#29 precedent); upload/copy/content answer 500
   * with an explicit message when it is absent.
   */
  readonly BLOBS?: R2Bucket;

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

  // --- composition vars (#31, #377) -------------------------------------------

  /**
   * Daemon-service front credentials (daemon client enroll/hostKey). Set as
   * staging secrets; the hookup literals are the local-dev fallback.
   */
  readonly ENROLL_KEY?: string;
  readonly DAEMON_HOST_KEY?: string;
  /**
   * #377: optional explicit harness host pin. Unset = the cloud placeholder
   * (no deployment machine is fabricated); only a deliberate deployment that
   * really runs a machine under this name should set it.
   */
  readonly DAEMON_MACHINE_ID?: string;
  /**
   * Relay harness (#28 three keys): read by the manager and the composed
   * agent DO's per-isolate runtime registration.
   */
  readonly MODEL_RELAY_BASE_URL_ANTHROPIC?: string;
  readonly MODEL_RELAY_API_KEY?: string;
  readonly MODEL_RELAY_MODEL?: string;
  readonly MODEL_RELAY_MAX_TOKENS?: string;
  readonly MODEL_RELAY_THINKING_BUDGET_TOKENS?: string;
  /**
   * A4 image-input capability declaration (#319, 1/true/on). Read by the
   * execution-options projection (routes/system.ts) and the provider-app
   * harness — the same deployment var both faces must agree on.
   */
  readonly MODEL_RELAY_IMAGE_INPUT?: string;
  /**
   * #350 catalog declaration (public, zero-secret JSON —
   * packages/agent-do/src/provider-catalog.ts): providers × models ×
   * capabilities the deployment bought, projected into
   * GET /system/execution-options, the provider-projections catalog row and
   * the project execution defaults — one resolution, shared with the
   * provider-app harness. Strict decode: a shape violation degrades the
   * read faces to the env-only synthesis and reports decodeError; secrets
   * have no field in this schema (keys stay in their own env/secret slots).
   */
  readonly MODEL_RELAY_CATALOG?: string;
  /** `accept-edits` | `auto` | `full` (default `full`). */
  readonly HARNESS_PERMISSION_MODE?: string;
  /**
   * web_search engine chain + engine credentials (#144), read by the composed
   * AgentDO at construction (packages/agent-do/src/agent-do.ts). #266's
   * provider projection reads the SAME deployment var — the endpoint projects
   * chain order and credential-gate booleans only, never the secret values.
   */
  readonly AGENT_DO_WEB_SEARCH?: string;
}
