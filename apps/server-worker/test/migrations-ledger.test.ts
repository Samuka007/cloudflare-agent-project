import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import journal from "../drizzle/meta/_journal.json";
import { applyD1Migrations, D1_MIGRATIONS_TABLE, type LedgerApplyResult } from "./migrations-ledger";

/**
 * #594 ledger-migration contract: the drizzle-era control plane
 * (src/db/schema.ts → drizzle/, applied by the CI deploy hook —
 * `wrangler d1 migrations apply DB_V2 --remote`) replaces the legacy
 * replay-everything chain's test pin. Three properties the deploy relies on:
 *
 * 1. a FRESH database takes the full migration set in one green pass;
 * 2. a second apply is a tracked NO-OP — the ledger (d1_migrations) gates by
 *    name, so replays can neither re-run DDL nor duplicate seeds;
 * 3. the ledger count equals the journal count — the apply record is the
 *    single source of what has run (the legacy chain's 0011-unregistered-file
 *    drift is structurally impossible here: the journal and the files ship
 *    together, and test/migrations-ledger.ts cross-checks them at load).
 *
 * Runs against the rig's second local D1 (env.DB_V2) — deliberately NOT
 * env.DB, which the legacy suites migrate with the old 14-file replay (the
 * two schema generations share nine table names and must never mix).
 */

const db = env.DB_V2;
let firstApply: LedgerApplyResult;

beforeAll(async () => {
  firstApply = await applyD1Migrations(db);
});

describe("drizzle ledger migrations (#594)", () => {
  it("applies the full migration set to a fresh D1 in one green pass", async () => {
    expect(firstApply.applied).toEqual(journal.entries.map((entry) => entry.tag));
    expect(firstApply.skipped).toBe(0);

    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    const names = tables.results.map((row) => row.name);
    for (const table of [
      "d1_migrations",
      "projects",
      "project_sources",
      "hosts",
      "thread_sections",
      "threads",
      "thread_tabs",
      "environments",
      "provider_configs",
      "settings_app",
      "settings_agent",
      "system_experiments",
    ]) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it("counts the ledger equal to the journal (#591: the ledger is the only apply record)", async () => {
    const ledger = await db
      .prepare(`SELECT COUNT(*) AS n FROM "${D1_MIGRATIONS_TABLE}"`)
      .first<{ n: number }>();
    expect(Number(ledger?.n)).toBe(journal.entries.length);
  });

  it("seeds the personal project singleton and the cloud placeholder host", async () => {
    const personal = await db
      .prepare("SELECT id, kind, name FROM projects WHERE kind = 'personal'")
      .all<{ id: string; kind: string; name: string }>();
    expect(personal.results).toEqual([
      { id: "proj_personal", kind: "personal", name: "Personal" },
    ]);

    const cloud = await db
      .prepare("SELECT id, type, max_permission_mode FROM hosts WHERE type = 'placeholder'")
      .all<{ id: string; type: string; max_permission_mode: string }>();
    expect(cloud.results).toEqual([
      { id: "cloud", type: "placeholder", max_permission_mode: "full" },
    ]);
  });

  it("pins the settings singleton CHECK constraints (A-item of the #593 ruling)", async () => {
    await db
      .prepare("INSERT INTO settings_app (id, updated_at) VALUES ('app', 1)")
      .run();
    await db
      .prepare("INSERT INTO settings_agent (id, updated_at) VALUES ('agent', 1)")
      .run();
    await expect(
      db.prepare("INSERT INTO settings_app (id, updated_at) VALUES ('other', 1)").run(),
    ).rejects.toThrow();
    await expect(
      db.prepare("INSERT INTO settings_agent (id, updated_at) VALUES ('other', 1)").run(),
    ).rejects.toThrow();
  });

  it("rejects a second personal-kind project (the seed's partial-unique anchor)", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO projects (id, kind, name, created_at, updated_at) VALUES ('proj_personal_impostor', 'personal', 'Impostor', 1, 1)",
        )
        .run(),
    ).rejects.toThrow();
  });

  it("re-apply is a tracked no-op: no DDL re-runs, no seed duplicates, data survives", async () => {
    await db
      .prepare(
        "INSERT INTO threads (id, project_id, provider_id, latest_attention_at, created_at, updated_at) VALUES ('thr_ledger_noop_probe', 'proj_personal', 'prov_x', 1, 1, 1)",
      )
      .run();

    const secondApply = await applyD1Migrations(db);
    expect(secondApply.applied).toEqual([]);
    expect(secondApply.skipped).toBe(journal.entries.length);

    const ledger = await db
      .prepare(`SELECT COUNT(*) AS n FROM "${D1_MIGRATIONS_TABLE}"`)
      .first<{ n: number }>();
    expect(Number(ledger?.n)).toBe(journal.entries.length);

    const probe = await db
      .prepare("SELECT id FROM threads WHERE id = 'thr_ledger_noop_probe'")
      .first<{ id: string }>();
    expect(probe?.id).toBe("thr_ledger_noop_probe");

    const personalCount = await db
      .prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'proj_personal'")
      .first<{ n: number }>();
    expect(Number(personalCount?.n)).toBe(1);
  });
});
