import { env } from "cloudflare:workers";
import controlPlaneSql from "../migrations/0001_control_plane.sql";

/**
 * Applies the control-plane D1 migrations once per worker context. Invoked
 * lazily from the shared test helpers (NOT vitest setupFiles — those run in
 * their own storage scope, so migrations applied there are invisible to
 * tests). Miniflare 5 removed the per-binding `migrations` option the old
 * pool-workers pattern relied on.
 */
let applied: Promise<void> | null = null;

export function ensureMigrations(): Promise<void> {
  applied ??= (async () => {
    const probe = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
    ).first();
    if (probe !== null) {
      return;
    }
    const statements = controlPlaneSql
      .split(/;\s*\n/)
      .map((statement) =>
        statement
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await env.DB.prepare(statement).run();
    }
  })();
  return applied;
}
