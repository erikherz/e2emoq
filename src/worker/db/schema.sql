-- Users table for OAuth authentication
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for fast provider ID lookups during OAuth
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- Broadcast events - logged when a user starts broadcasting
--
-- Deliberately holds nothing that could decrypt a stream or locate a person. Content keys
-- are derived in the browser from the share link's #k= fragment and never reach this
-- database; geolocation is never collected. Both were removed in migration 0010.
CREATE TABLE IF NOT EXISTS broadcast_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  stream_id TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  -- Assigned relay (broadcast→relay routing directory)
  relay_host TEXT,
  relay_port INTEGER,
  -- Ed25519 public key (base64url) that claimed this stream id, minted per broadcast in the
  -- broadcaster's browser. Binds the name to its owner while the broadcast is live so nobody
  -- else can publish over it. Public, fresh each time, and identifies no one.
  publisher_pubkey TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Fast lookup of the live row for a name (the ownership check on every go-live).
CREATE INDEX IF NOT EXISTS idx_broadcast_events_live_stream
  ON broadcast_events(stream_id, ended_at);

CREATE INDEX IF NOT EXISTS idx_broadcast_events_user_id ON broadcast_events(user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_stream_id ON broadcast_events(stream_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_started_at ON broadcast_events(started_at);

-- Watch events - one row per viewing SESSION, never per person.
--
-- A viewer's location is never resolved or stored; only that someone watched, and for how
-- long. Geolocation columns were removed in migration 0010.
--
-- Nothing in this table is stable across sessions — no IP, no IP hash, no cookie, no
-- fingerprint. Two rows cannot be shown to be the same human, on one stream or across
-- streams. Audience SIZE and DURATION are answerable here; audience IDENTITY is not, and
-- adding any column that would make it answerable is the one change this table must never
-- take. See migration 0014.
CREATE TABLE IF NOT EXISTS watch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  stream_id TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  -- Heartbeat watermark; the reaper closes silent sessions AT this value, not at reap time.
  last_seen_at TEXT,
  -- SHA-256 of the opaque per-session token. Stored hashed, held in page memory only, never
  -- reused across streams — it authorises heartbeat/end, it does not identify.
  session_hash TEXT,
  -- 'client' | 'reaped'
  end_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_watch_events_open
  ON watch_events(ended_at, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_watch_events_stream_ended
  ON watch_events(stream_id, ended_at);

CREATE INDEX IF NOT EXISTS idx_watch_events_user_id ON watch_events(user_id);
CREATE INDEX IF NOT EXISTS idx_watch_events_stream_id ON watch_events(stream_id);
CREATE INDEX IF NOT EXISTS idx_watch_events_started_at ON watch_events(started_at);

-- Stream settings - stores per-stream configuration
CREATE TABLE IF NOT EXISTS streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  require_auth INTEGER DEFAULT 0,
  -- Broadcaster-supplied HTML overlay rendered over the player.
  overlay_html TEXT DEFAULT '',
  -- Relay-blind E2E media encryption. MANDATORY for every stream (AES-GCM payload):
  -- the go-live path always mints a content key regardless of this column, which is
  -- retained for history but no longer authoritative. Defaults to 1 for honesty.
  encrypted INTEGER DEFAULT 1,
  -- Live chat opt-in (1 = chat enabled; messages flow via the ChatRoom Durable Object).
  chat_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_streams_stream_id ON streams(stream_id);
CREATE INDEX IF NOT EXISTS idx_streams_user_id ON streams(user_id);

-- Broadcaster allow list (default-deny): a user may broadcast ONLY if there is a
-- row here for their email with status='allowed'. No row, or status='suspended',
-- means broadcasting is blocked. Managed from the /cleardata admin page.
CREATE TABLE IF NOT EXISTS broadcaster_access (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'allowed', -- 'allowed' | 'suspended'
  note TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Seed the site owner so default-deny never locks them out.
-- Placeholder, deliberately not a real address. This repository is public, and seeding a
-- live one would publish which account holds admission — a different disclosure from a
-- contact address. An operator running their own copy should put theirs here.
--
-- Inert on this deployment in any case: the allow-list check returns true unconditionally
-- while OAuth is off (see the OAUTH-DISABLED block in src/worker/index.ts), so nothing
-- consults this row. Admission is the publish code.
INSERT OR IGNORE INTO broadcaster_access (email, status) VALUES ('owner@example.com', 'allowed');

-- OAUTH-DISABLED: seed the anonymous stand-in user (id=1) that the Worker returns for
-- every request while OAuth is off, so broadcast/stream rows have a valid user_id.
INSERT OR IGNORE INTO users (id, email, name) VALUES (1, 'anonymous@e2emoq.com', 'Anonymous');
