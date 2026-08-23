-- Lets us revoke an existing session cookie without waiting for its 30-day
-- JWT expiry: bump token_version on password reset, and a deleted user's
-- row simply won't be found on lookup.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;
