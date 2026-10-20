import journal from "../drizzle/meta/_journal.json";
import baselineSql from "../drizzle/0000_w6_control_plane_baseline.sql";
import seedSql from "../drizzle/0001_control_plane_seed.sql";

/**
 * The drizzle ledger apply, test-side (#594).
 *
 * Production applies `drizzle/` with `wrangler d1 migrations apply DB_V2
 * --remote` (scripts/deploy-staging.sh deploy hook); miniflare tests cannot
 * invoke the wrangler CLI, so this module replays the same semantics against
 * the rig's second local D1 (`env.DB_V2` from wrangler.jsonc) — the shape
 * wrangler 4.x gives the ledger table, the skip-by-name gate, and one
 * apply-once ledger row per migration. The REAL wrangler path is verified
 * against staging by the deploy chain itself; this harness exists so the
 * fresh-apply / re-apply-no-op / ledger-count contract is pinned in CI on
 * every push.
 *
 * Drift guard: the journal (drizzle-kit's own record) is the authority for
 * the file set and order; the static import list must match it exactly or
 * module load throws — the 0011-unregistered-file failure mode of the legacy
 * replay chain cannot recur silently here.
 */

/** wrangler 4.x d1 migrations table (src/d1/migrations/helpers.ts). */
export const D1_MIGRATIONS_TABLE = "d1_migrations";

/** The statically imported migration set, in the journal's apply order. The
 * load-time guard below makes a list/journal divergence (either direction,
 * order included) a hard error — the legacy chain's 0011-unregistered-file
 * drift cannot recur silently. */
const MIGRATIONS_IN_JOURNAL_ORDER: readonly { tag: string; sql: string }[] = [
  { tag: "0000_w6_control_plane_baseline", sql: baselineSql },
  { tag: "0001_control_plane_seed", sql: seedSql },
];

const journalTags = journal.entries.map((entry) => entry.tag);
const importedTags = MIGRATIONS_IN_JOURNAL_ORDER.map((migration) => migration.tag);
if (journalTags.join("\n") !== importedTags.join("\n")) {
  throw new Error(
    `drizzle journal tags [${journalTags.join(", ")}] diverge from the statically imported migrations [${importedTags.join(", ")}] — regenerate with drizzle-kit (pnpm --filter @cap/server-worker db:generate) and keep test/migrations-ledger.ts in lockstep (the #594 ledger test drift guard)`,
  );
}

/** Splits a drizzle migration file into its statements. */
export function splitDrizzleStatements(file: string): string[] {
  return file
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export interface LedgerApplyResult {
  /** Migration tags this call actually applied, in journal order. */
  applied: string[];
  /** Migration tags skipped because the ledger already records them. */
  skipped: number;
}

/**
 * Applies every pending drizzle migration to `db`, exactly once per tag —
 * the wrangler `d1 migrations apply` gate. Pending files run statement by
 * statement, then the ledger row lands; a failed statement aborts before the
 * row is written, so the migration retries on the next call.
 */
export async function applyD1Migrations(db: D1Database): Promise<LedgerApplyResult> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS "${D1_MIGRATIONS_TABLE}" (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      );`,
    )
    .run();

  const ledgerRows = await db
    .prepare(`SELECT name FROM "${D1_MIGRATIONS_TABLE}" ORDER BY id`)
    .all<{ name: string | null }>();
  const appliedNames = ledgerRows.results
    .map((row) => row.name)
    .filter((name): name is string => name !== null);

  const applied: string[] = [];
  let skipped = 0;
  for (const migration of MIGRATIONS_IN_JOURNAL_ORDER) {
    if (appliedNames.includes(migration.tag)) {
      skipped += 1;
      continue;
    }
    for (const statement of splitDrizzleStatements(migration.sql)) {
      await db.prepare(statement).run();
    }
    await db
      .prepare(`INSERT INTO "${D1_MIGRATIONS_TABLE}" (name) VALUES (?)`)
      .bind(migration.tag)
      .run();
    applied.push(migration.tag);
  }
  return { applied, skipped };
}
