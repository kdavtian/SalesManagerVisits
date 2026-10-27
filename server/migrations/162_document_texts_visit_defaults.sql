-- Owner, 2026-10-27:
--  1. The texts the customer reads before signing (orders received / payment / both) and the warning printed on every blank are
--     editable in Settings > Sales & customers. NULL / missing keys = the built-in texts (server/src/documentTexts.js).
--  2. A default visit frequency per customer type (channel CVO, PCO, OEM, SM, CAS, KF; potential level; competitor; Bronze, Silver,
--     Gold), "by default, but can be changed by specific customer". customers.visit_frequency_days stays the one number the whole app
--     reads; it now follows the type defaults unless someone set this customer's frequency by hand (visit_frequency_manual).
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS document_texts JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS visit_frequency_by_type JSONB NOT NULL DEFAULT '{}';

ALTER TABLE customers ADD COLUMN IF NOT EXISTS visit_frequency_manual BOOLEAN NOT NULL DEFAULT false;
-- A customer whose frequency differs from today's default was set by hand (or by a saved route plan set): it keeps its number.
UPDATE customers SET visit_frequency_manual = true
WHERE visit_frequency_days <> COALESCE((SELECT default_visit_frequency_days FROM app_settings WHERE id = 1), 7);

-- The default for one customer: the MOST frequent (fewest days) of the type defaults that apply to it -- its channel (every "SM ..."
-- channel is SM), its tier (Bronze / Silver / Gold / Competitor) or, for a potential customer, its potential level -- else the general default.
CREATE OR REPLACE FUNCTION customer_default_visit_days(p_channel TEXT, p_tier TEXT, p_level SMALLINT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    LEAST(
      NULLIF(s.m ->> (CASE WHEN p_channel ILIKE 'SM%' THEN 'sm' ELSE lower(p_channel) END), '')::int,
      NULLIF(s.m ->> (CASE WHEN p_tier = 'potential' THEN 'potential_' || COALESCE(p_level, 0) ELSE p_tier END), '')::int
    ),
    s.d
  )
  FROM (SELECT visit_frequency_by_type AS m, default_visit_frequency_days AS d FROM app_settings WHERE id = 1) s
$$;

-- Every write path (the edit sheet, edit requests, route plan sets, the ERP sync's tier change, potential assessment) goes through here:
--  - the frequency itself changed in the statement (and the flag was not touched) -> set by hand, kept;
--  - otherwise a customer that follows the defaults gets its type's default.
-- Setting visit_frequency_manual = false brings a customer back to its default.
CREATE OR REPLACE FUNCTION customers_visit_frequency_default() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.visit_frequency_days IS DISTINCT FROM OLD.visit_frequency_days
     AND NEW.visit_frequency_manual IS NOT DISTINCT FROM OLD.visit_frequency_manual THEN
    NEW.visit_frequency_manual := true;
  ELSIF NOT NEW.visit_frequency_manual THEN
    NEW.visit_frequency_days := COALESCE(customer_default_visit_days(NEW.sales_channel, NEW.customer_tier, NEW.potential_level), NEW.visit_frequency_days);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS customers_visit_frequency_default ON customers;
CREATE TRIGGER customers_visit_frequency_default
  BEFORE INSERT OR UPDATE OF sales_channel, customer_tier, potential_level, visit_frequency_days, visit_frequency_manual ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_visit_frequency_default();
