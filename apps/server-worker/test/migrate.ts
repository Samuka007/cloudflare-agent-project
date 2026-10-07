import { env } from "cloudflare:workers";
import controlPlaneSql from "../migrations/0001_control_plane.sql";
import environmentsSql from "../migrations/0002_environments.sql";
import providerConfigsSql from "../migrations/0003_provider_configs.sql";
import cloudPlaceholderHostSql from "../migrations/0004_cloud_placeholder_host.sql";
import projectSourcesHostUniqueSql from "../migrations/0005_project_sources_host_unique.sql";
import imageSourceSql from "../migrations/0005_image_source.sql";
import webSearchSql from "../migrations/0006_web_search.sql";
import orphanHostReferencesSql from "../migrations/0006_orphan_host_references.sql";
import toolCapabilitiesSql from "../migrations/0007_tool_capabilities.sql";
import originAllowlistSql from "../migrations/0008_origin_allowlist.sql";

/** The migration files, in apply order. The deploy chain replays the whole
 * `migrations/*.sql` directory per deploy (#295, scripts/deploy-staging.sh);
 * tests pin the same set explicitly so a new file must be registered here. */
export const MIGRATION_FILES: string[] = [
  controlPlaneSql,
  environmentsSql,
  providerConfigsSql,
  cloudPlaceholderHostSql,
  projectSourcesHostUniqueSql,
  imageSourceSql,
  webSearchSql,
  orphanHostReferencesSql,
  toolCapabilitiesSql,
  originAllowlistSql,
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

/**
 * Replays the control-plane D1 migrations once per worker context — the same
 * full-replay-every-deploy semantics scripts/deploy-staging.sh runs against
 * staging (#295); migration files are idempotent by contract (0001 header),
 * so replay over an already-migrated DB is a clean no-op. Invoked lazily from
 * the shared test helpers (NOT vitest setupFiles — those run in their own
 * storage scope, so migrations applied there are invisible to tests).
 * Miniflare 5 removed the per-binding `migrations` option the old
 * pool-workers pattern relied on.
 */
let applied: Promise<void> | null = null;

export function ensureMigrations(): Promise<void> {
  applied ??= (async () => {
    for (const file of MIGRATION_FILES) {
      for (const statement of splitMigrationStatements(file)) {
        await env.DB.prepare(statement).run();
      }
    }
  })();
  return applied;
}
