import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The derived journal's `events` table (#575, drizzle-ized in W6 db campaign
 * T10/#602) — the adapter-side event log owned by the durable DO.
 *
 * Column names are the historical snake_case physical shape: pre-drizzle DOs
 * wrote these exact columns, so the definition must stay byte-compatible with
 * what `journal.ts` used to hand-write (seq INTEGER PRIMARY KEY, id TEXT NOT
 * NULL UNIQUE, type/data TEXT NOT NULL, created_at INTEGER NOT NULL). drizzle-kit
 * owns every DDL byte (`pnpm --filter @cap/agent-durable db:generate` →
 * `drizzle/`); never hand-edit the generated files.
 */
export const events = sqliteTable("events", {
  seq: integer("seq").primaryKey(),
  id: text("id").notNull().unique(),
  type: text("type").notNull(),
  data: text("data").notNull(),
  createdAt: integer("created_at").notNull(),
});
