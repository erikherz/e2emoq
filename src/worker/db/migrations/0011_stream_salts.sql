-- Rotatable HKDF salts, and the kill switch built on them.
--
-- The salt is PUBLIC — it is an HKDF input, not a secret, and is handed to publisher and
-- viewers alike. Its value is that rotating it changes the derived content key for everyone
-- who derives afterwards, without the share link changing and without anyone here ever
-- holding the link secret.
--
-- This is the only moderation lever available to an operator who cannot see content. In
-- response to an abuse report or a legal demand we can terminate a stream; we still cannot
-- watch it, and we cannot tell anyone what it contained.
--
-- The row with stream_id '*' is global: its salt is mixed into every derivation, so rotating
-- that one re-keys every stream at once.
CREATE TABLE IF NOT EXISTS stream_salts (
  stream_id TEXT PRIMARY KEY,        -- '*' = the global row
  salt TEXT NOT NULL,                -- public HKDF salt (base64url)
  rotated_at TEXT DEFAULT (datetime('now')),
  -- When set the stream is terminated: no publish token is issued and no viewer token is
  -- minted. Existing connections survive until their relay token expires.
  killed_at TEXT,
  -- Free-text operator note (why it was killed). Never shown to viewers.
  note TEXT
);

-- Seed the global row. Rotating this value is the "kill everything" switch.
INSERT OR IGNORE INTO stream_salts (stream_id, salt) VALUES ('*', 'genesis');
