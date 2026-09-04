-- Publish-code revocation.
--
-- Carved out of Wallflower's migration 0012, which created these two tables alongside the
-- abuse-report table. The reports half does not exist here; these two do, and they are not
-- optional — verifyPublishCode() reads BOTH on every publish attempt, so a database without
-- them fails every go-live with a SQL error rather than a refusal.
--
-- Codes are stateless: each one carries its own not-before, expiry and batch, sealed with an
-- HMAC, so issuing one writes nothing down and there is no per-person row to correlate against
-- broadcast_events. These two tables are the ONLY exception, and both are identity-free by
-- construction: a cohort number, or the hash of a code someone presented.

-- Revoke an entire issuance cohort at once. Cheap, and it says nothing about who holds what —
-- a batch number records that some codes were minted around the same time, and no more.
CREATE TABLE IF NOT EXISTS revoked_batches (
  batch INTEGER PRIMARY KEY,
  revoked_at TEXT DEFAULT (datetime('now')),
  note TEXT
);

-- Revoke ONE code without learning whose it is. The operator pastes the code, we store its
-- hash: enough to refuse that exact code forever, useless for identifying its holder, and
-- not reversible into the code itself if this table leaks.
CREATE TABLE IF NOT EXISTS revoked_codes (
  code_hash TEXT PRIMARY KEY,
  revoked_at TEXT DEFAULT (datetime('now')),
  note TEXT
);
