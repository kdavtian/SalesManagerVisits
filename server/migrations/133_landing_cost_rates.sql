-- Landing-cost rates the owner can change in App configuration (2026-10-20): freight, declared transport, customs duty,
-- ecology, excise, import VAT, clearance. Only the values that differ from the built-in ones (client costModel.js
-- COST_RATES_DEFAULT) are stored, so a rate nobody touched keeps following the code's default. The USD rate stays in
-- landing_usd_rate.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS landing_cost_rates JSONB NOT NULL DEFAULT '{}'::jsonb;
