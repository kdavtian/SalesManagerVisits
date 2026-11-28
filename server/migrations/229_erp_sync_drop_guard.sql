-- Improvement plan 0.5 (owner, 2026-11-28): an empty or half-saved Excel file must not wipe the debts. A sync whose customers, debtors, order
-- lines, cash lines or products drop sharply against the last good sync is refused (erp/erpSyncGuard.js). These columns remember the last
-- refusal (shown in System health) and the admin's one-time "Accept the next sync" window that lets a real change through.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS erp_sync_refused_at timestamptz;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS erp_sync_refused_reason text;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS erp_sync_accept_until timestamptz;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS erp_sync_accept_by integer REFERENCES users(id) ON DELETE SET NULL;

-- Improvement plan 0.9: a dollar row in the Excel Cashflow sheet with no AMD amount and no rate. The refresh now uses the nearest known rate;
-- a row with no rate anywhere is kept but flagged here (its AMD amount is 0 until the accountant types the rate).
ALTER TABLE cash_entries ADD COLUMN IF NOT EXISTS fx_missing boolean NOT NULL DEFAULT false;
ALTER TABLE cash_syncs ADD COLUMN IF NOT EXISTS rows_rate_filled integer NOT NULL DEFAULT 0;
ALTER TABLE cash_syncs ADD COLUMN IF NOT EXISTS rows_no_rate integer NOT NULL DEFAULT 0;
