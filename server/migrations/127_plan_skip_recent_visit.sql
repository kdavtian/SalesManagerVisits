-- Owner, 2026-10-18: a customer a rep visited yesterday must not be on today's route plan again (Artak visited 10121
-- on 16/10 and the recurring Friday plan still showed it on 17/10). Recurring-rule plans now leave out a customer
-- whose last field visit was 1..N days before the plan date; the next planned date is the next route day after that.
-- N lives in App configuration (0 = off).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS plan_skip_recent_visit_days integer NOT NULL DEFAULT 4
  CHECK (plan_skip_recent_visit_days BETWEEN 0 AND 60);
