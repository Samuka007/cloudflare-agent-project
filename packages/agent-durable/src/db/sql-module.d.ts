/**
 * SQL text imports (vitest plugin miniflare modulesRules Text rule and the
 * wrangler Text build rule) — the drizzle-kit generated journal DDL replayed
 * by src/db/bootstrap.ts.
 */
declare module "*.sql" {
  const content: string;
  export default content;
}
