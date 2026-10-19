-- Purge every control-plane row for a legacy (`thr_`) thread. The legacy
-- AgentDO is deleted and its DO storage is removed by the wrangler
-- `deleted_classes` migration; a surviving `thr_` row would only point at a
-- journal that no longer exists. Pi-durable threads use the `dthr_` prefix
-- and are deliberately left untouched.
--
-- Idempotent by the #295 replay contract: predicate DELETEs over an already
-- purged DB delete nothing.

DELETE FROM pending_interactions
 WHERE thread_id LIKE 'thr\_%' ESCAPE '\';

DELETE FROM thread_tabs
 WHERE thread_id LIKE 'thr\_%' ESCAPE '\';

-- New durable threads may have forked from a legacy parent/source; detach
-- those references before the parent rows disappear.
UPDATE threads
   SET parent_thread_id = NULL
 WHERE parent_thread_id LIKE 'thr\_%' ESCAPE '\';

UPDATE threads
   SET source_thread_id = NULL
 WHERE source_thread_id LIKE 'thr\_%' ESCAPE '\';

DELETE FROM threads
 WHERE id LIKE 'thr\_%' ESCAPE '\';
