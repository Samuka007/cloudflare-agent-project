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
  Variables: { accessPrincipalId?: string };
}
