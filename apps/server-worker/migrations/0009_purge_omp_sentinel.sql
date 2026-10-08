-- #508: net-delete every control-plane row referencing the retired synthetic
-- relay provider id "omp" (user ruling 2026-10-08: no tombstones, no legacy
-- markers — sentinel-era threads and their reference rows are DELETED, never
-- rewritten, and the id keeps NO reserved seat on any write face anymore;
-- see docs/adr/0001-test-rig-composition-root-split.md's first execution).
--
-- Coverage (schema audit over migrations/0001-0008): provider_id columns
-- exist on threads (0001), pending_interactions (0001 — provenance echo, so
-- its rows purge independently of their thread), and image_source (0005).
-- image_source.provider_id points at a provider_configs row id and no such
-- row exists (the CRUD/import faces never accepted the id), so it needs no
-- statement; provider_configs gets a defensive sweep for the same reason.
--
-- The predicate is PERMANENT by the #295 replay contract: every deploy
-- replays this file, so the id cannot quietly re-materialize in the control
-- plane. If a future deployment ever deliberately reuses the id, retire this
-- file explicitly — that is a product ruling, not a migration edit.
--
-- The purged thread ids' per-thread AgentDO journals become unreachable
-- archives (no D1 row routes to them; thr_ ids are random and never
-- recycled): every addressable surface is clean after this file. The
-- face-driven half of the purge (live thread-deleted broadcasts before the
-- deploy) is scripts/purge-omp-threads.mjs.
--
-- #295: the staging deploy chain replays every migrations/*.sql on EVERY
-- deploy (scripts/deploy-staging.sh), against any DB state from bare to
-- fully-migrated. Every statement here MUST stay idempotent: these are
-- predicate DELETEs — a replay over an already-purged DB deletes nothing.

DELETE FROM pending_interactions WHERE provider_id = 'omp';

DELETE FROM thread_tabs
 WHERE thread_id IN (SELECT id FROM threads WHERE provider_id = 'omp');

DELETE FROM threads WHERE provider_id = 'omp';

DELETE FROM provider_configs WHERE id = 'omp';
