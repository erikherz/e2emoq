-- 0008_encryption_mandatory.sql
-- Relay-blind E2E media encryption is now MANDATORY for every stream. The go-live path
-- (POST /api/stats/broadcast) always mints a per-broadcast content key regardless of
-- streams.encrypted, so this column is no longer authoritative — it is retained for
-- history only. Flip any existing opt-out rows to 1 so the data matches the invariant.
UPDATE streams SET encrypted = 1 WHERE encrypted = 0;
