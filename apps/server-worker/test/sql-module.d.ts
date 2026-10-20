/**
 * SQL text imports (vitest plugin miniflare modulesRules Text rule) and the
 * drizzle ledger journal (#594) — a JSON module inlined by the bundler.
 */
declare module "*.sql" {
  const content: string;
  export default content;
}

declare module "*/_journal.json" {
  interface DrizzleJournalEntry {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }
  const journal: {
    version: string;
    dialect: string;
    entries: DrizzleJournalEntry[];
  };
  export default journal;
}
