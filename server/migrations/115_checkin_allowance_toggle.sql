-- The Check-in allowance (how close a sales manager must stand to a customer's pin) gets an On/Off switch in
-- Settings > App configuration (owner, 2026-10-13). Off = nobody is refused for distance; the check-in still
-- records the distance and whether it was within the meters, so visits keep their location verification.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS checkin_allowance_enabled BOOLEAN NOT NULL DEFAULT true;
