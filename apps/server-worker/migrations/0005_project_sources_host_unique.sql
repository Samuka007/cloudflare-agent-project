-- #445: the add-source face creates one source per (project, host) — bb's
-- project_sources_project_host_idx UNIQUE constraint (packages/db schema,
-- projectSourceHostConflict backstop, routes/projects.ts:510-524). The M0
-- port created the table without the index (0001); this closes the gap.
--
-- #295: the staging deploy chain replays every migrations/*.sql on EVERY
-- deploy (scripts/deploy-staging.sh). Every statement MUST stay idempotent,
-- and the unique index creation must not fail on pre-existing duplicate
-- (project_id, host_id) rows — the guarded DELETE keeps the earliest row of
-- each pair (bb's createProjectSource would have demoted/kept the first
-- inserted row; the later duplicates are the anomaly), then the index lands.

DELETE FROM project_sources
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM project_sources GROUP BY project_id, host_id
);

CREATE UNIQUE INDEX IF NOT EXISTS project_sources_project_host_idx
  ON project_sources (project_id, host_id);
