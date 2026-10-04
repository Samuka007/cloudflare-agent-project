import type { Env } from "./env.js";

export type { Env };
export type HonoBindings = Env;
export interface AppEnv {
  Bindings: HonoBindings;
}
