import type { Env } from "./env.js";

export type { Env };
export type HonoBindings = Env;
export interface AppEnv {
  Bindings: HonoBindings;
  /**
   * SEC-W5-003 probe-face rate limiting: the verified Access identity set by
   * the gate (middleware/access.ts) when ACCESS_CHECK_ENABLED is on; unset
   * otherwise (consumers fall back to client IP).
   */
  Variables: {
    accessPrincipalId?: string;
    /**
     * #506: the Origin guard's per-request D1 allowlist read, stashed so the
     * CORS leg shares the same query; unset when the request carries no
     * Origin header (curl/CLI/SDK) or the guard did not run.
     */
    originAllowlist?: ReadonlySet<string>;
  };
}
