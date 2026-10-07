/// <reference types="@cloudflare/vitest-plugin/types" />

/** Injected by vitest.config.ts `define` from the gitignored `.dev.vars`. */
declare const __RELAY_ENV__: Record<string, string | undefined>;

/** Migration files import as text (test/migrate.ts rig D1 replay). */
declare module "*.sql" {
  const content: string;
  export default content;
}
