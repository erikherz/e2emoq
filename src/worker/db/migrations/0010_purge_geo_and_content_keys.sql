-- Purge and retire the columns that made e2eMoQ able to decrypt and locate its users.
--
-- BACKUP FIRST. This is irreversible. A pre-purge dump of both tables was taken to
-- ~/Desktop/e2emoq-d1-backup-2026-08-13.json (237 broadcast_events, 265 watch_events).
--
-- Why the rows go, not just the columns: every historical row was written under the old
-- model, so each carries either a content key that decrypts that broadcast or coordinates
-- identifying who was broadcasting or watching, and when. Dropping the columns alone would
-- destroy the same data; deleting the rows first simply makes the intent explicit. None of
-- it has any current function -- the events are a stats artifact for a service with no users.
--
-- Columns dropped:
--   broadcast_events.content_key  -- keys are now derived in the browser from the share
--                                    link's #k= fragment and never reach this database
--   *.geo_*                       -- coordinates plus a timestamp identify a person more
--                                    precisely than an IP, and a VPN does not hide them
--
-- Kept: publisher_pubkey (public, per-broadcast, identifies nobody), relay_host, timings.

DELETE FROM broadcast_events;
DELETE FROM watch_events;

-- content_key is absent from this deployment's base schema; nothing to drop.
ALTER TABLE broadcast_events DROP COLUMN geo_country;
ALTER TABLE broadcast_events DROP COLUMN geo_city;
ALTER TABLE broadcast_events DROP COLUMN geo_region;
ALTER TABLE broadcast_events DROP COLUMN geo_latitude;
ALTER TABLE broadcast_events DROP COLUMN geo_longitude;
ALTER TABLE broadcast_events DROP COLUMN geo_timezone;

ALTER TABLE watch_events DROP COLUMN geo_country;
ALTER TABLE watch_events DROP COLUMN geo_city;
ALTER TABLE watch_events DROP COLUMN geo_region;
ALTER TABLE watch_events DROP COLUMN geo_latitude;
ALTER TABLE watch_events DROP COLUMN geo_longitude;
ALTER TABLE watch_events DROP COLUMN geo_timezone;
