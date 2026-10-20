/**
 * Worker bindings. `AGENT_DO` is the pi-durable agent; this control plane
 * programs against the seam in `src/seam/agent-do.ts`.
 */
export interface Env {
  /**
   * T7 #599: the ControlPlane typed RPC face — the self service binding to
   * this worker's `control_plane` named entrypoint (public traffic cannot
   * reach a named entrypoint; the binding IS the capability). Consumed by
   * the daemon-service DO's liveness projection, whose direct D1 write
   * (HOSTS_DB) it retires. Optional: standalone rigs omit it and the
   * projection skips, exactly the old absent-HOSTS_DB posture.
   */
  readonly CONTROL_PLANE?: Fetcher;

  /**
   * The control plane (db campaign #591, closed by T9 #601): the
   * repositories' sole database — the legacy `DB` binding retired with the
   * old layer; the legacy database itself is torn down by the deploy chain.
   */
  DB_V2: D1Database;
  /** Public WS fan-out + event waiters + disconnect grace. */
  HUB: DurableObjectNamespace;
  /** Preview/file leases with alarm-based TTL eviction (bb previewLeases). */
  LEASES: DurableObjectNamespace;
  /** Per-thread pi-durable agent (one DO per thread). */
  AGENT_DO: DurableObjectNamespace;
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
  //
  // #500: the former deployment-channel scalars (relay base/key/model/budget/
  // window/image-input, the machine pin, the permission mode) are DELETED —
  // the D1 provider_configs rows and the permission_mode seat are the 正本,
  // and zero env scalars remain on the provider path.

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
   * #362 AES-GCM master key for the provider_configs.api_key_enc column
   * (the user-configurable provider panel). Worker SECRET in deployment
   * (`wrangler secret put PROVIDER_CONFIG_MASTER_KEY`); unset = rows with
   * stored keys cannot decrypt (mock-first degradation, loader warning) and
   * key-bearing writes are refused (422 master_key_missing).
   */
  readonly PROVIDER_CONFIG_MASTER_KEY?: string;
}
