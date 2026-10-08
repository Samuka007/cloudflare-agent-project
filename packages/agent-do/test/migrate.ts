import { env } from "cloudflare:workers";
import controlPlaneSql from "../../../apps/server-worker/migrations/0001_control_plane.sql";
import environmentsSql from "../../../apps/server-worker/migrations/0002_environments.sql";
import providerConfigsSql from "../../../apps/server-worker/migrations/0003_provider_configs.sql";
import cloudPlaceholderHostSql from "../../../apps/server-worker/migrations/0004_cloud_placeholder_host.sql";
// #508: pure data purge (no schema) — registered to keep the replay set
// honest; a no-op over the rig D1, which never stores omp threads rows.
import purgeOmpSentinelSql from "../../../apps/server-worker/migrations/0009_purge_omp_sentinel.sql";

/**
 * The agent-do rig binds `DB` in the composed deployment's shape (wrangler.jsonc
 * #238), and the control-plane schema is owned by apps/server-worker
 * (migrations/0001_control_plane.sql header) — the rig replays those same files
 * verbatim so its D1 carries the schema the composed worker's `DB` has. #375:
 * without this, every terminal turn's control-plane settlement
 * (settleControlPlaneRowAfterTerminalTurn) died on `no such table: threads`.
 */

/** The migration files, in apply order. Mirrors apps/server-worker/test/migrate.ts:
 * the deploy chain replays the whole `migrations/*.sql` directory per deploy
 * (#295, scripts/deploy-staging.sh); this pins the same set explicitly so a new
 * file must be registered in BOTH helpers. */
export const MIGRATION_FILES: string[] = [
  controlPlaneSql,
  environmentsSql,
  providerConfigsSql,
  cloudPlaceholderHostSql,
  purgeOmpSentinelSql,
];

/** Statement splitter shared with the deploy replay: one statement per `;\n`
 * boundary, comment lines stripped. */
export function splitMigrationStatements(file: string): string[] {
  return file
    .split(/;\s*\n/)
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

/** The rig worker's bindings (test seam: `env` from cloudflare:workers is
 * untyped here — same posture as host-path-override.test.ts's RigWorkerEnv). */
interface RigWorkerEnv {
  DB: D1Database;
}

const rigEnv = env as RigWorkerEnv;

/**
 * Replays the control-plane D1 migrations — the same full-replay-every-deploy
 * semantics scripts/deploy-staging.sh runs against staging (#295); migration
 * files are idempotent by contract (0001 header), so replay over an
 * already-migrated DB is a clean no-op. Unmemoized: a suite that drops a
 * table mid-run (host-path-override's registry-failure test) re-invokes it
 * to restore the schema exactly.
 */
export async function replayMigrations(): Promise<void> {
  for (const file of MIGRATION_FILES) {
    for (const statement of splitMigrationStatements(file)) {
      await rigEnv.DB.prepare(statement).run();
    }
  }
}

let applied: Promise<void> | null = null;

/** replayMigrations once per worker context. Invoked lazily from the shared
 * test helpers (NOT vitest setupFiles — those run in their own storage scope,
 * so migrations applied there are invisible to tests). */
export function ensureMigrations(): Promise<void> {
  applied ??= replayMigrations();
  return applied;
}
