-- The check-in radius becomes the "Check-in allowance": how close (meters) a sales manager must be to a
-- customer's pin to be allowed to check in at all (management roles are not limited). Default 300 m
-- (owner, 2026-10-13). The old default 200 is moved to 300; a value an admin set on purpose is kept.
ALTER TABLE app_settings ALTER COLUMN checkin_radius_meters SET DEFAULT 300;
UPDATE app_settings SET checkin_radius_meters = 300 WHERE checkin_radius_meters = 200;
