-- Owner, 2026-11-03: the demand model's lead time (days from ordering to goods on the shelf) and service level are settings, not constants
-- (products/demandModel.js, products/demandSettings.js; Settings -> App configuration). Defaults = what the model used so far: 45 days, 95 %.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS demand_lead_time_days integer NOT NULL DEFAULT 45
  CHECK (demand_lead_time_days BETWEEN 1 AND 365);
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS demand_service_level_pct integer NOT NULL DEFAULT 95
  CHECK (demand_service_level_pct BETWEEN 50 AND 99);
