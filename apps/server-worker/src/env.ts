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
   * SEC-W5-001 (#397): explicit local-dev marker — the only way a deployment
   * without the Access credential pair serves /api/v1/* and /ws (#505: gate
   * state derives from ACCESS_TEAM_DOMAIN/ACCESS_AUD presence; an absent pair
   * locks the control plane). For the L1 rig and `wrangler dev` only; never
   * ship the marker in wrangler configs.
   */
  readonly ACCESS_LOCAL_DEV?: string;
  /**
   * e.g. "https://myteam.cloudflareaccess.com" — JWKS source. Presence (with
   * ACCESS_AUD) arms the gate (#505); absence locks the control plane.
   */
  readonly ACCESS_TEAM_DOMAIN?: string;
  /**
   * Access application AUD claim. Presence (with ACCESS_TEAM_DOMAIN) arms
   * the gate (#505); absence locks the control plane.
   */
  readonly ACCESS_AUD?: string;
  /** Version banner for /system/version (bb appVersion.currentVersion). */
  readonly SERVER_VERSION?: string;

  // --- composition vars (#31, #377) -------------------------------------------

  /**
   * Daemon-service front credentials (daemon client enroll/hostKey). Required
   * for the daemon face: unset/empty = every daemon-face request fails closed
   * (#398/SEC-W5-002 — the repo-public POC literals are gone). Set with
   * `wrangler secret put`, or via the staging deploy's secrets-file pass-through
   * (scripts/deploy-staging.sh).
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
   * #362 AES-GCM master key for the provider_configs.api_key_enc column
   * (the user-configurable provider panel). Worker SECRET in deployment
   * (`wrangler secret put PROVIDER_CONFIG_MASTER_KEY`); unset = rows with
   * stored keys cannot decrypt (mock-first degradation, loader warning) and
   * key-bearing writes are refused (422 master_key_missing).
   */
  readonly PROVIDER_CONFIG_MASTER_KEY?: string;
  /** `accept-edits` | `auto` | `full` (default `full`). */
  readonly HARNESS_PERMISSION_MODE?: string;
}
