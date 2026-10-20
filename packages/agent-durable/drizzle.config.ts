import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the durable DO journal schema (W6 db campaign
 * T10/#602).
 *
 * `drizzle-kit generate` diffs src/db/schema.ts against drizzle/meta/ and
 * appends a ledger migration to drizzle/. Output is committed; unlike the
 * server-worker D1 ledger (applied by `wrangler d1 migrations apply`), a
 * Durable Object cannot read its migration folder at runtime, so
 * src/db/bootstrap.ts statically imports the generated .sql text and replays
 * it on first journal use (drizzle-kit owns every DDL byte; same convention
 * as the #594 control-plane schema).
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
