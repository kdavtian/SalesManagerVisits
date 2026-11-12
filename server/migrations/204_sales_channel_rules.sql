-- Sales directions editable in the admin panel (owner, 2026-11-12: "let me add a new sales direction on the admin panel"). Until now the rules
-- of a direction were lists of names in the code (which directions are not visited, chased by phone, pay no commission, have their own route
-- plan, their own cash book ...), so a direction added to this table got none of them. Every rule is now a column of the direction; the seed
-- below reproduces today's behaviour exactly, except OEM no longer gets overdue-visit reminders (owner, 2026-11-12: same as CVO/PCO).
ALTER TABLE sales_channels
  -- 'field': the reps visit its customers (due dates, plans, overdue); 'no_visit': served without field visits (key accounts, distributors)
  ADD COLUMN IF NOT EXISTS visit_mode TEXT NOT NULL DEFAULT 'field' CHECK (visit_mode IN ('field', 'no_visit')),
  -- how Vaghinak chases its debts and reorders: a visit task, a phone-call task, or not at all
  ADD COLUMN IF NOT EXISTS debt_mode TEXT NOT NULL DEFAULT 'visit' CHECK (debt_mode IN ('visit', 'call', 'none')),
  -- its customers are planned as a separate route plan of the person (not inside their main plan)
  ADD COLUMN IF NOT EXISTS separate_plan BOOLEAN NOT NULL DEFAULT false,
  -- the Excel Cashflow "Source" of a cash payment collected in it (empty = the central "Cash")
  ADD COLUMN IF NOT EXISTS cash_source TEXT,
  -- commission in the cost model: 'rep' = director + the direction's sales manager, 'trade' = director only, 'none' = no commission
  ADD COLUMN IF NOT EXISTS commission_kind TEXT NOT NULL DEFAULT 'trade' CHECK (commission_kind IN ('rep', 'trade', 'none')),
  -- which "default visit frequency by type" row it follows (Settings > Visit frequency): sm, cvo, pco, oem, cas, kf
  ADD COLUMN IF NOT EXISTS visit_type_key TEXT NOT NULL DEFAULT 'sm',
  -- a new customer placed on the map takes the region's suggested manager from Routes Distribution
  ADD COLUMN IF NOT EXISTS route_autofill BOOLEAN NOT NULL DEFAULT true,
  -- left out of the Sales Director's report (the CEO bot)
  ADD COLUMN IF NOT EXISTS director_report_excluded BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- the channels as they behave today (the lists in customers.js, debtCollectionTasks.js, planScopes.js, cashSheets.js, costModel.js,
-- addCustomer.js, markers.js, the visit-frequency function of migration 197, and the bot's EXCLUDED_CHANNELS)
UPDATE sales_channels SET visit_mode = 'no_visit' WHERE code IN ('KF', 'CAS', 'CVO', 'PCO', 'OEM');
UPDATE sales_channels SET debt_mode = 'none' WHERE code IN ('KF', 'CAS');
UPDATE sales_channels SET debt_mode = 'call' WHERE code IN ('SM B2B', 'CVO', 'PCO', 'OEM');
UPDATE sales_channels SET separate_plan = true WHERE code = 'SM B2B';
UPDATE sales_channels SET cash_source = 'Cash YVN' WHERE code = 'SM YVN';
UPDATE sales_channels SET cash_source = 'Cash DVT' WHERE code = 'SM Davtashen';
UPDATE sales_channels SET cash_source = 'Cash Shirak' WHERE code = 'SM Shirak';
UPDATE sales_channels SET commission_kind = CASE WHEN code IN ('KF', 'CAS') THEN 'none' WHEN code ~ '^SM(\s|$)' THEN 'rep' ELSE 'trade' END;
UPDATE sales_channels SET visit_type_key = CASE WHEN code ILIKE 'SM%' THEN 'sm' ELSE lower(code) END;
UPDATE sales_channels SET route_autofill = false WHERE code IN ('CVO', 'PCO', 'OEM');
UPDATE sales_channels SET director_report_excluded = true WHERE code IN ('KF', 'CAS');

-- A direction's code is how the Excel names it ("Sales Rep" / "Assigned To"): compared without case, it must be unique.
CREATE UNIQUE INDEX IF NOT EXISTS sales_channels_code_lower_idx ON sales_channels (lower(code));

-- The default visit frequency follows the direction's own type row (a new direction picks one); a code not in the table keeps the old guess.
CREATE OR REPLACE FUNCTION customer_channel_visit_key(p_channel TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT visit_type_key FROM sales_channels WHERE code = p_channel),
    CASE WHEN p_channel ILIKE 'SM%' THEN 'sm' ELSE lower(p_channel) END
  )
$$;

CREATE OR REPLACE FUNCTION customer_default_visit_days(p_channel TEXT, p_tier TEXT, p_level SMALLINT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    CASE WHEN p_tier = 'potential' THEN
      COALESCE(
        NULLIF(s.m ->> ('potential_' || COALESCE(p_level, 0)), '')::int,
        NULLIF(s.m ->> customer_channel_visit_key(p_channel), '')::int
      )
    ELSE
      LEAST(
        NULLIF(s.m ->> customer_channel_visit_key(p_channel), '')::int,
        NULLIF(s.m ->> p_tier, '')::int
      )
    END,
    s.d
  )
  FROM (SELECT visit_frequency_by_type AS m, default_visit_frequency_days AS d FROM app_settings WHERE id = 1) s
$$;
