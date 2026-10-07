-- #468: staging orphan sweep for the binding default. A destroyed (or
-- registry-removed) host left project_sources rows naming it — the port's
-- project-level binding default (project_sources.is_default feeds the
-- omitted-environment resolution, thread-binding.ts) — so creating a thread
-- without an environment died with 404 host_not_found on the dead machine.
--
-- Environments rows are deliberately NOT swept: the #445 data-hygiene ruling
-- keeps tombstoned-host rows resolvable by id (existing threads stay
-- readable and answer host_offline, #436 posture) while the list face hides
-- them (db/environments.ts listEnvironmentRows).
--
-- bb declares the source cascade in the schema itself — projectSources.hostId
-- references hosts.id ON DELETE CASCADE (packages/db schema.ts:450-483;
-- schema.test.ts:344-346 pins sources vanishing with their host). The port
-- tombstones hosts instead of hard-deleting (routes/hosts.ts soft destroy),
-- so the FK never fires; the delete face now cascades live rows, and this
-- migration backfills rows that were already dangling.
--
-- Sweep predicate matches the work faces: a host is a binding target only
-- while a NON-destroyed hosts row exists. The statement is idempotent
-- (plain conditional DELETE), per the #295 replay contract.

DELETE FROM project_sources
WHERE host_id NOT IN (SELECT id FROM hosts WHERE destroyed_at IS NULL);
