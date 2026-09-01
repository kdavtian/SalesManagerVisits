-- Month-close snapshot: freezes each channel's final KPI numbers for a
-- closed plan so the History screen never drifts if underlying actuals
-- (sales_performance, checkins, etc.) are corrected or re-synced later.
-- Once a month is closed its numbers are historical record, not a live
-- query -- see GET /plans/:id/dashboard, which reads from here instead of
-- the live actuals path when the plan's status is 'closed'.
CREATE TABLE perf_plan_closed_snapshot (
  id                    SERIAL PRIMARY KEY,
  plan_id               INTEGER NOT NULL REFERENCES perf_plans(id) ON DELETE CASCADE,
  channel_id            INTEGER NOT NULL REFERENCES sales_channels(id),
  channel_code          TEXT NOT NULL,
  channel_name          TEXT NOT NULL,
  sales_target_amd      NUMERIC NOT NULL,
  sales_actual_amd      NUMERIC NOT NULL,
  collection_target_amd NUMERIC NOT NULL,
  collection_actual_amd NUMERIC NOT NULL,
  new_customers_target  INTEGER NOT NULL,
  new_customers_actual  INTEGER NOT NULL,
  brand_actuals         JSONB NOT NULL DEFAULT '[]',
  UNIQUE (plan_id, channel_id)
);

ALTER TABLE perf_plans ADD COLUMN closed_by INTEGER REFERENCES users(id);
ALTER TABLE perf_plans ADD COLUMN closed_at TIMESTAMPTZ;
