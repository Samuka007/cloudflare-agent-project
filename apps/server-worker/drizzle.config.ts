import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the control-plane D1 schema (#594, W6 db campaign).
 *
 * `drizzle-kit generate` diffs src/db/schema.ts against drizzle/meta/ and
 * appends a ledger migration to drizzle/. Output is committed and applied by
 * `wrangler d1 migrations apply DB_V2 --remote` (CI deploy hook,
 * scripts/deploy-staging.sh) — the ledger table d1_migrations is the only
 * apply record; nothing replays.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
