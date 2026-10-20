-- W6 db campaign T2 (#594): the control-plane seeds for the drizzle-era
-- schema. This is the ONE sanctioned handwritten file under drizzle/ — every
-- DDL byte is drizzle-kit generated from src/db/schema.ts (#594 acceptance);
-- seeds are data, and the #591 ruling lands them as a ledger-tracked custom
-- migration. `wrangler d1 migrations apply DB_V2 --remote` records it in
-- d1_migrations and never replays it.
--
-- Values are verbatim the legacy replay chain's seeds (its 0001 proj_personal
-- + 0004 cloud row — the chain was deleted with the T9 contract shrink,
-- #601): the greenfield database restarts the same invariants, and the
-- display strings stay the property of the later reader-cutover tickets to
-- change.
--
-- proj_personal: bb requires the personal singleton to exist (the sidebar
-- bootstrap 500s otherwise). OR IGNORE rides projects_personal_singleton_idx
-- (partial unique index on kind='personal'): first apply seeds, any re-run is
-- absorbed before it can ever duplicate.
INSERT OR IGNORE INTO projects (id, kind, name, git_remote_url, sort_key, deleted_at, created_at, updated_at)
VALUES ('proj_personal', 'personal', 'Personal', NULL, 'V', NULL, strftime('%s','now') * 1000, strftime('%s','now') * 1000);

-- cloud placeholder host (#386): the virtual carrier row — born
-- destroyed-impossible (the API refuses DELETE on it), never enrolls and
-- never heartbeats. OR IGNORE rides the hosts primary key.
INSERT OR IGNORE INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at,
                             last_seen_at, last_rejected_protocol_version, created_at, updated_at)
VALUES ('cloud', 'Cloud（虚拟·W6 前不可执行）', 'placeholder', NULL, 'full', NULL,
        NULL, NULL, strftime('%s','now') * 1000, strftime('%s','now') * 1000);
