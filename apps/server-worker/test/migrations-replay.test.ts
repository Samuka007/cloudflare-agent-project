import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_FILES, ensureMigrations, splitMigrationStatements } from "./migrate.js";
import orphanHostReferencesSql from "../migrations/0006_orphan_host_references.sql";

/**
 * #295 deploy-chain contract: scripts/deploy-staging.sh replays EVERY
 * migrations/*.sql on every deploy, against any DB state (bare →
 * fully-migrated; the pre-#295 staging baseline had 0001 hand-applied). This
 * pins the idempotency property the deploy relies on: a full replay over an
 * already-migrated DB must succeed and must not touch existing rows — no
 * duplicate seed, no dropped/recreated table losing data.
 */
beforeAll(ensureMigrations);

afterAll(async () => {
  // The shared worker runs one D1 for the whole suite (isolate:false): the
  // probe rows must not leak onto later faces — /hosts parses `type` against
  // the persistent|placeholder enum, so an uncleaned row 500s the face.
  await env.DB.prepare("DELETE FROM environments WHERE id = 'env_replay_probe'").run();
  await env.DB.prepare("DELETE FROM hosts WHERE id = 'host_replay_probe'").run();
  await env.DB.prepare("DELETE FROM project_sources WHERE id LIKE 'src468_%'").run();
  await env.DB.prepare("DELETE FROM hosts WHERE id LIKE 'host468_%'").run();
});

describe("migration replay idempotency (#295)", () => {
  it("replays every migration file over a migrated DB without error or data loss", async () => {
    await env.DB.prepare(
      // A face-valid type: the row is a live probe against the replay, and
      // the shared-worker discipline keeps every row face-parseable.
      "INSERT INTO hosts (id, name, type, created_at, updated_at) VALUES ('host_replay_probe', 'replay-probe', 'persistent', 1, 1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO environments (id, project_id, host_id, workspace_provision_type, created_at, updated_at) VALUES ('env_replay_probe', 'proj_personal', 'host_replay_probe', 'git', 1, 1)",
    ).run();

    for (const file of MIGRATION_FILES) {
      for (const statement of splitMigrationStatements(file)) {
        await env.DB.prepare(statement).run();
      }
    }

    const personal = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM projects WHERE id = 'proj_personal'",
    ).first();
    expect(Number(personal?.n)).toBe(1);
    const probe = await env.DB.prepare(
      "SELECT id FROM environments WHERE id = 'env_replay_probe'",
    ).first();
    expect(probe?.id).toBe("env_replay_probe");
  });

  it("0006 sweeps project_sources dangling on a missing or tombstoned host (#468)", async () => {
    // The replay test above already ran the full set over the live probe
    // rows (host_replay_probe/env_replay_probe survive: #445 keeps
    // environments id-resolvable and 0006 touches sources only). This pins
    // the 0006 predicate itself against all three host shapes.
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at, last_seen_at, last_rejected_protocol_version, created_at, updated_at) VALUES ('host468_live', '468-live', 'persistent', NULL, 'full', NULL, ?, NULL, ?, ?)",
    )
      .bind(now, now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at, last_seen_at, last_rejected_protocol_version, created_at, updated_at) VALUES ('host468_dead', '468-dead', 'persistent', NULL, 'full', ?, NULL, NULL, ?, ?)",
    )
      .bind(now, now, now)
      .run();
    const sourceColumns =
      "id, project_id, is_default, type, host_id, path, created_at, updated_at";
    const sourceShape = "'local_path', ?, '/repo/468', 1, 1";
    await env.DB.prepare(
      `INSERT INTO project_sources (${sourceColumns}) VALUES ('src468_live', 'proj_personal', 0, ${sourceShape})`,
    )
      .bind("host468_live")
      .run();
    await env.DB.prepare(
      `INSERT INTO project_sources (${sourceColumns}) VALUES ('src468_dead', 'proj_personal', 0, ${sourceShape})`,
    )
      .bind("host468_dead")
      .run();
    await env.DB.prepare(
      `INSERT INTO project_sources (${sourceColumns}) VALUES ('src468_missing', 'proj_personal', 0, ${sourceShape})`,
    )
      .bind("host468_missing")
      .run();

    for (const statement of splitMigrationStatements(orphanHostReferencesSql)) {
      await env.DB.prepare(statement).run();
    }

    const surviving = await env.DB.prepare(
      "SELECT id FROM project_sources WHERE id LIKE 'src468_%'",
    ).all();
    expect(surviving.results.map((row) => row.id)).toEqual(["src468_live"]);
  });
});
