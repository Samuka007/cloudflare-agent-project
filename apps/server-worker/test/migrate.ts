import { env } from "cloudflare:workers";
import { applyD1Migrations } from "./migrations-ledger";

/**
 * Replays the control-plane D1 migrations once per worker context. Invoked
 * lazily from the shared test helpers (NOT vitest setupFiles — those run in
 * their own storage scope, so migrations applied there are invisible to
 * tests). Miniflare 5 removed the per-binding `migrations` option the old
 * pool-workers pattern relied on.
 *
 * T9 (#601): the legacy 14-file replay chain (`migrations/*.sql` + the
 * hand-written db layer) is retired with the contract shrink — the drizzle
 * ledger is the only migration apparatus left. The apply is idempotent: one
 * d1_migrations row per tag, replays are skips; the ledger test pins the
 * fresh-apply / re-apply-no-op / ledger-count contract, and the load-time
 * journal guard in migrations-ledger.ts makes a file-set drift (the old
 * 0011-unregistered-file failure mode) a hard error instead of silent.
 */
let applied: Promise<void> | null = null;

export function ensureMigrations(): Promise<void> {
  applied ??= applyD1Migrations(env.DB_V2).then(() => undefined);
  return applied;
}
