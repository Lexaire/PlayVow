-- Strips fields and tables that should not appear in publicly-released
-- snapshots of the Playvow database. Run against a COPY of the DB (e.g., a
-- fresh sqlite3 .backup output, or a downloaded operational backup), never
-- the live replica.
--
-- Usage:
--   sqlite3 /path/to/copy.db < infra/public-snapshot-sanitize.sql
--
-- The schema is preserved (DELETE not DROP) so a successor or fork can
-- populate the same shape from scratch. VACUUM at the end rewrites every
-- page, so the published file's free space contains zeros — not the deleted
-- plaintext recoverable with a hex editor.
--
-- What gets stripped and why:
--   1. group_secrets    — encrypted SteamGifts session cookies. Removing the
--                         whole table contents; even ciphertext + timestamps
--                         is information we don't need to hand out.
--   2. audit_log        — moderator activity (actor + action + target +
--                         payload). Internal moderation context; not
--                         appropriate for public release even though
--                         user-visible data on Playvow is public.
--   3. wins.mod_notes   — free-text notes moderators write about individual
--                         wins. Same reasoning as audit_log.
--
-- The sanity-check queries at the end MUST all print 0. If any of them prints
-- a non-zero count, the sanitize step didn't fire and the file should NOT be
-- published. Eyeball the output before continuing.

BEGIN;

DELETE FROM group_secrets;
DELETE FROM audit_log;
UPDATE wins SET mod_notes = NULL WHERE mod_notes IS NOT NULL;

COMMIT;

-- VACUUM cannot run inside a transaction. Compacts the DB and rewrites every
-- page; deleted bytes are gone from the on-disk artifact, not just unlinked.
VACUUM;

-- Sanity checks. Each MUST print 0. Anything else means the sanitize is
-- incomplete and the snapshot is unsafe to publish.
SELECT 'group_secrets rows (must be 0)', COUNT(*) FROM group_secrets;
SELECT 'audit_log rows (must be 0)', COUNT(*) FROM audit_log;
SELECT 'wins with non-null mod_notes (must be 0)', COUNT(*) FROM wins WHERE mod_notes IS NOT NULL;

-- Quick row-count summary so you can eyeball that the data you DID want kept
-- looks reasonable (counts roughly matching what the live site shows).
SELECT 'groups', COUNT(*) FROM groups;
SELECT 'users', COUNT(*) FROM users;
SELECT 'steam_apps', COUNT(*) FROM steam_apps;
SELECT 'steam_subs', COUNT(*) FROM steam_subs;
SELECT 'giveaways', COUNT(*) FROM giveaways;
SELECT 'wins', COUNT(*) FROM wins;
SELECT 'win_observations', COUNT(*) FROM win_observations;
SELECT 'steam_achievements', COUNT(*) FROM steam_achievements;
SELECT 'achievement_events', COUNT(*) FROM achievement_events;
