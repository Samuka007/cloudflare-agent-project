-- #386: the cloud placeholder is a REAL hosts row. #377 deliberately kept the
-- deployment-default binding (CLOUD_PLACEHOLDER_HOST_ID = 'cloud') rowless —
-- any lone row is primary-protected (bb resolvePrimaryHostId,
-- services/hosts/primary-host.ts:70-76), which anchored the un-deletable
-- machine on the last REAL host instead (observed: lxc-stg-01 remove refused
-- "this machine runs bb and can not be removed"). The user ruling (2026-10-06)
-- re-anchors bb's "must have one machine" invariant on a virtual placeholder:
-- this row is born destroyed-impossible (the API refuses DELETE on it), never
-- connects and never heartbeats (enroll/session-open reserve the id), and W6
-- promotes the same row to the real cloud carrier.
-- OR IGNORE rides the primary key: first deploy seeds, replays no-op (same
-- idempotency contract as 0001's proj_personal seed).
INSERT OR IGNORE INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at,
                             last_seen_at, last_rejected_protocol_version, created_at, updated_at)
VALUES ('cloud', 'Cloud（虚拟·W6 前不可执行）', 'placeholder', NULL, 'full', NULL,
        NULL, NULL, strftime('%s','now') * 1000, strftime('%s','now') * 1000);
