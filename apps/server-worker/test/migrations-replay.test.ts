import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_FILES, ensureMigrations, splitMigrationStatements } from "./migrate.js";
import orphanHostReferencesSql from "../migrations/0006_orphan_host_references.sql";
import purgeOmpSentinelSql from "../migrations/0009_purge_omp_sentinel.sql";

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
  // The #508 pin's non-omp survivor (its omp siblings the migration deletes).
  await env.DB.prepare("DELETE FROM threads WHERE id = 'thr_rig_replay_probe'").run();
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

  it("0009 net-deletes the omp sentinel's reference rows and spares the rest (#508)", async () => {
    // The replay above already ran the full set over the live probes. This
    // pins the #508 predicate itself: threads carrying the retired id go,
    // with their tabs and provenance echo; any other provider's rows stay.
    const now = Date.now();
    const threadShape =
      "INSERT INTO threads (id, project_id, provider_id, status, latest_attention_at, created_at, updated_at)";
    await env.DB.prepare(`${threadShape} VALUES ('thr_omp_replay_probe', 'proj_personal', 'omp', 'starting', ?, ?, ?)`)
      .bind(now, now, now)
      .run();
    await env.DB.prepare(`${threadShape} VALUES ('thr_rig_replay_probe', 'proj_personal', 'rig', 'starting', ?, ?, ?)`)
      .bind(now, now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO thread_tabs (thread_id, tabs_json, revision, updated_at) VALUES ('thr_omp_replay_probe', '[]', 0, ?)",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      "INSERT INTO pending_interactions (id, thread_id, provider_id, status, payload, created_at, updated_at) VALUES ('pi_omp_replay_probe', 'thr_omp_replay_probe', 'omp', 'pending', '{}', ?, ?)",
    )
      .bind(now, now)
      .run();

    for (const statement of splitMigrationStatements(purgeOmpSentinelSql)) {
      await env.DB.prepare(statement).run();
    }

    const ompThread = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM threads WHERE id = 'thr_omp_replay_probe'",
    ).first();
    expect(Number(ompThread?.n)).toBe(0);
    const ompTabs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM thread_tabs WHERE thread_id = 'thr_omp_replay_probe'",
    ).first();
    expect(Number(ompTabs?.n)).toBe(0);
    const ompInteraction = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pending_interactions WHERE id = 'pi_omp_replay_probe'",
    ).first();
    expect(Number(ompInteraction?.n)).toBe(0);
    const rigThread = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM threads WHERE id = 'thr_rig_replay_probe'",
    ).first();
    expect(Number(rigThread?.n)).toBe(1);
  });
});
