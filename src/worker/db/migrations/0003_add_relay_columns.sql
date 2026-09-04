-- Broadcast→relay routing: record which tinymoq relay a broadcast was assigned to.
-- The Cloudflare Worker is the authoritative broadcast→relay:port directory; the
-- tinymoq autoscaler allocates the port via GET /assign. Viewers read this row to
-- co-locate on the same relay island as the publisher.
ALTER TABLE broadcast_events ADD COLUMN relay_host TEXT;
ALTER TABLE broadcast_events ADD COLUMN relay_port INTEGER;
