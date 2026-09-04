-- Publisher identity for a broadcast: the Ed25519 public key (base64url, raw 32 bytes) that
-- claimed this stream id. Minted in the broadcaster's browser per broadcast; the private half
-- never leaves it.
--
-- This binds a name to a key for the LIFETIME OF THE BROADCAST only. While a row is live
-- (ended_at IS NULL) a claim on the same stream id must be signed by the matching key, which
-- is what stops a stranger publishing over a stream whose share link they have seen. Once the
-- broadcast ends the name is free again, so a lost key strands nothing.
--
-- A public key is not identifying: it is fresh per broadcast and links to no person.
ALTER TABLE broadcast_events ADD COLUMN publisher_pubkey TEXT;

CREATE INDEX IF NOT EXISTS idx_broadcast_events_live_stream
  ON broadcast_events(stream_id, ended_at);
