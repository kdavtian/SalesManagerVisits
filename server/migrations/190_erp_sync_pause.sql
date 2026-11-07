-- Owner, 2026-11-07: admin can pause the Excel sync with a switch. While paused the app refuses the bot's syncs (nothing in the app changes);
-- the next sync after the switch is back on brings everything up to date, since every sync carries the whole workbook.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS erp_sync_paused boolean NOT NULL DEFAULT false;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS erp_sync_paused_at timestamptz;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS erp_sync_paused_by integer REFERENCES users(id) ON DELETE SET NULL;
