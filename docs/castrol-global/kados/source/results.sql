-- READ-ONLY query behind slides 2 and 10 and the one-pager results row. Run on the production droplet:
--   cd /opt/field-visits && docker compose exec -T db psql -U fieldvisits -d fieldvisits -f - < results.sql
-- Monthly: GPS-verified rep visits (customer+day), outlets visited, reps, buying customers, orders, sales and cash collected (AMD).
WITH m AS (SELECT generate_series(date '2026-03-01', date_trunc('month', now())::date, interval '1 month')::date AS month),
v AS (SELECT date_trunc('month', c.timestamp AT TIME ZONE 'Asia/Yerevan')::date AS month, count(DISTINCT (c.customer_id, (c.timestamp AT TIME ZONE 'Asia/Yerevan')::date)) AS visits, count(DISTINCT c.customer_id) AS customers_visited, count(DISTINCT c.user_id) AS reps FROM checkins c JOIN users u ON u.id = c.user_id AND u.role = 'sales_manager' JOIN customers cu ON cu.id = c.customer_id AND NOT coalesce(cu.checkin_for_all, false) GROUP BY 1),
o AS (SELECT date_trunc('month', order_date)::date AS month, count(DISTINCT erp_customer_id) AS buyers, count(DISTINCT order_id) AS orders, round(sum(revenue_amd)) AS sales_amd FROM erp_order_lines WHERE erp_customer_id <> '10000' GROUP BY 1),
p AS (SELECT date_trunc('month', cashflow_date)::date AS month, round(sum(amount_amd)) AS collected_amd FROM erp_cashflow_lines GROUP BY 1)
SELECT m.month, v.visits, v.customers_visited, v.reps, o.buyers, o.orders, o.sales_amd, p.collected_amd FROM m LEFT JOIN v USING (month) LEFT JOIN o USING (month) LEFT JOIN p USING (month) ORDER BY 1;
-- Shelf: each shop's latest Castrol audit.
WITH last AS (SELECT DISTINCT ON (customer_id) customer_id, brand_status -> 'castrol' AS v FROM checkins WHERE jsonb_typeof(brand_status -> 'castrol') = 'array' AND jsonb_array_length(brand_status -> 'castrol') > 0 ORDER BY customer_id, timestamp DESC)
SELECT count(*) AS shops_audited, count(*) FILTER (WHERE v ?| array['available','full_range']) AS with_castrol, count(*) FILTER (WHERE v ? 'full_range') AS full_range FROM last;
-- USD rate set in KAD OS.
SELECT rate AS usd_rate, set_at FROM fx_rates ORDER BY set_at DESC LIMIT 1;
