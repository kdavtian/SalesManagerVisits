-- AI check of photographed order blanks (owner, 2026-10-26): an On/Off switch in App configuration (OFF by default) and a monthly spending cap.
-- The result of a check lives on customer_files (ai_status / ai_result / ai_checked_at, added in migration 156).
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS ai_blank_check_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_blank_check_monthly_cap_usd NUMERIC(8, 2) NOT NULL DEFAULT 10;
