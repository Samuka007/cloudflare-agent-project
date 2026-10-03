/**
 * SQL text imports (vitest plugin miniflare modulesRules Text rule).
 */
declare module "*.sql" {
  const content: string;
  export default content;
}
