-- How often each customer usually orders (median days between order days over the last ~13 months),
-- computed from the synced Excel order history. Refreshed on every ERP sync (orderRhythm.js); powers the
-- "Reorder due" chip on the customer list / card / map without a heavy query per request.
CREATE TABLE IF NOT EXISTS customer_order_rhythm (
  erp_customer_id TEXT PRIMARY KEY,
  last_order_date DATE NOT NULL,
  order_days INTEGER NOT NULL,
  median_gap_days INTEGER,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill so the chip works right after deploy, before the next sync.
WITH days AS (
  SELECT erp_customer_id, order_date FROM erp_order_lines
  WHERE order_date >= (now() AT TIME ZONE 'Asia/Yerevan')::date - 400 AND erp_customer_id <> '10000' AND COALESCE(revenue_amd, 0) > 0
  GROUP BY erp_customer_id, order_date
), gaps AS (
  SELECT erp_customer_id, order_date, order_date - LAG(order_date) OVER (PARTITION BY erp_customer_id ORDER BY order_date) AS gap FROM days
)
INSERT INTO customer_order_rhythm (erp_customer_id, last_order_date, order_days, median_gap_days)
SELECT erp_customer_id, MAX(order_date), COUNT(*)::int,
       CASE WHEN COUNT(gap) >= 3 THEN ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::int END
FROM gaps GROUP BY erp_customer_id
ON CONFLICT (erp_customer_id) DO NOTHING;
