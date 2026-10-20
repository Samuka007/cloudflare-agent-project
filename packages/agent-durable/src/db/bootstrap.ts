import { sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import generatedDdl from "../../drizzle/0000_amusing_anthem.sql";
import { events } from "./schema";

/**
 * Idempotently puts the journal schema in place on the DO's SQLite database.
 *
 * Every DDL byte is drizzle-kit generated (`pnpm --filter @cap/agent-durable
 * db:generate`) and statically imported above — a Durable Object cannot read
 * its migration folder at runtime, so the generated text is replayed directly
 * instead (the same constraint that shaped the #594 ledger apply on the test
 * rig).
 *
 * A DO constructor reruns on every activation (hibernation wake, eviction,
 * deploy), so replay must be cheap and re-entrant: the probe is a drizzle-built
 * `limit 1` select — if it answers, the single-migration schema is already
 * applied and nothing executes. Only a fresh database (or a pre-drizzle DO
 * interrupted mid-constructor before its old `CREATE TABLE IF NOT EXISTS`
 * landed) falls through to the replay. If the table exists but the probe
 * failed for another reason, the replay fails loudly on the same statement —
 * never silently.
 *
 * Pre-drizzle DOs keep their old-shape `events` table (inline `UNIQUE` auto
 * index instead of `events_id_unique`); the constraint semantics are identical
 * and no data migration is needed. A future second migration reconciling the
 * shapes must account for both.
 */
export function ensureJournalSchema(db: DrizzleSqliteDODatabase): void {
  try {
    db.select({ seq: events.seq }).from(events).limit(1).all();
    return;
  } catch {
    // Fresh database — apply drizzle-kit's generated DDL below.
  }
  for (const statement of generatedDdl
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    db.run(sql.raw(statement));
  }
}
