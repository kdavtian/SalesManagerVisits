-- Admin-editable leaderboard incentive text, replacing the hardcoded
-- "Top scorer wins a bonus" string. NULL means "use the built-in default".
ALTER TABLE app_settings ADD COLUMN incentive_message TEXT;
