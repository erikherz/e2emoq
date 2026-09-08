-- Video messages: a viewer records a short clip and the broadcaster may put it on screen.
--
-- `sealed` is a BLOB this service cannot read. The client encrypts it under a key derived from
-- the share link's `#k=` fragment (deriveMessageKey in src/crypto/media-crypto.ts), so what
-- lands here is `[nonce][AES-GCM ciphertext]` and nothing more. Same property as link_enc in
-- 0017, and worth repeating in the schema: there is no column here that could be read into a
-- video, and no key on this side to try.
--
-- Size is capped in the Worker rather than by the column, because D1 rejects an oversized row
-- with an error the client cannot act on. A refusal that says "too long, record a shorter one"
-- has to happen before the insert.
--
-- These are EPHEMERAL by design. They are deleted when the broadcast ends, and swept by the
-- existing hourly cron for anything a missed end-beacon left behind. A message outliving the
-- broadcast it was sent to would be a stranger's face sitting in a database for no reason.
--
-- messages_enabled is OFF by default and deliberately so. Accepting video from anyone holding
-- the link makes the broadcaster's inbox an unsolicited-content surface, which is the classic
-- abuse vector, and this product has no reporting path. A broadcaster opts in per stream.
CREATE TABLE IF NOT EXISTS stream_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id    TEXT NOT NULL,
  sealed       BLOB NOT NULL,
  bytes        INTEGER NOT NULL,
  mime         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  shown_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_stream_messages_stream
  ON stream_messages (stream_id, created_at);

ALTER TABLE streams ADD COLUMN messages_enabled INTEGER NOT NULL DEFAULT 0;
