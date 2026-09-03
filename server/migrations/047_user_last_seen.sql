-- Lets an admin see when a staff member last actually used the app, and
-- from what (app version + a raw User-Agent for lightweight device info) --
-- refreshed automatically on authenticated requests (see requireAuth in
-- middleware/auth.js), not something the user has to manually report.
ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN last_seen_app_version TEXT;
ALTER TABLE users ADD COLUMN last_seen_user_agent TEXT;
