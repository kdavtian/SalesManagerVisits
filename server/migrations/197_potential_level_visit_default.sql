-- Owner, 2026-11-10: "I have set low potential but the visit is still 7 days." The default frequency of a customer followed the MOST frequent of its
-- type defaults (migration 162), so a potential customer of the SM channel (7 days) stayed at 7 whatever its potential level said ("No
-- potential" 60 days). For a POTENTIAL customer the level is the more specific fact: when the level has a default, that default wins; without
-- one (level not assessed, or no default saved for it) the channel's default applies as before. Other tiers keep the most-frequent rule.
CREATE OR REPLACE FUNCTION customer_default_visit_days(p_channel TEXT, p_tier TEXT, p_level SMALLINT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    CASE WHEN p_tier = 'potential' THEN
      COALESCE(
        NULLIF(s.m ->> ('potential_' || COALESCE(p_level, 0)), '')::int,
        NULLIF(s.m ->> (CASE WHEN p_channel ILIKE 'SM%' THEN 'sm' ELSE lower(p_channel) END), '')::int
      )
    ELSE
      LEAST(
        NULLIF(s.m ->> (CASE WHEN p_channel ILIKE 'SM%' THEN 'sm' ELSE lower(p_channel) END), '')::int,
        NULLIF(s.m ->> p_tier, '')::int
      )
    END,
    s.d
  )
  FROM (SELECT visit_frequency_by_type AS m, default_visit_frequency_days AS d FROM app_settings WHERE id = 1) s
$$;

-- Customers that follow the defaults (nobody set their number by hand) are re-computed now; the trigger of migration 162 does the maths.
UPDATE customers SET visit_frequency_days = visit_frequency_days
WHERE NOT visit_frequency_manual AND customer_tier = 'potential'
  AND visit_frequency_days IS DISTINCT FROM customer_default_visit_days(sales_channel, customer_tier, potential_level);
