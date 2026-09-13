-- Emergency Disconnect ("lockdown"): when enabled, every request except
-- login/logout and the lift-lockdown endpoint is rejected app-wide (see
-- middleware/lockdown.js), and every user's token_version is bumped so
-- every previously-issued session cookie (admins included) stops working
-- immediately, forcing a fresh login even to lift it.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS lockdown_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS lockdown_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS lockdown_at TIMESTAMPTZ;

-- Admin on/off switch for the calculator disguise (see bootGate.js /
-- calculatorLock.js). Defaults to false (normal app boot) -- the disguise
-- only kicks in once an admin turns it on via Settings.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS calculator_mode_enabled BOOLEAN NOT NULL DEFAULT false;
