-- How many days the stock should last AFTER a purchase arrives (owner, 2026-11-25: smart purchase suggestions, "customizable"). It was the
-- demand model's fixed review period (demandModel.js MODEL.reviewDays = 45); the "low" badge, To order and the purchase suggestions all read
-- this setting now, so they agree on one horizon: lead time + cover days (+ safety stock).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS demand_cover_days integer NOT NULL DEFAULT 45
  CHECK (demand_cover_days BETWEEN 1 AND 365);
