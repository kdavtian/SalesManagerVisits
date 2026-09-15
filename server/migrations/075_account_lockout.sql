-- Account lockout after repeated failed logins (improvement list 8.4).
-- express-rate-limit on POST /login (see auth.js's loginLimiter) is
-- IP-scoped -- it catches one attacker hammering many accounts from one
-- IP, but not a targeted brute force against one specific account spread
-- across many IPs. This is the per-account complement to that.
ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TIMESTAMPTZ;
