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
