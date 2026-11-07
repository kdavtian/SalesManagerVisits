-- Owner, 2026-11-07: the Gold tier now pays the SILVER list; a Gold customer's own prices are its special prices
-- (customer_product_prices). The Gold prices from the Excel column "Price T3 Gold" were negotiated for ERP customer
-- 10001 (Garage Masters Mall), so they are recorded once as that customer's special prices, keeping every price it
-- pays today. A special price someone already set for 10001 is kept (DO NOTHING); products without a Gold price get none.
-- Safe to run again; a database without customer 10001 inserts nothing.
INSERT INTO customer_product_prices (customer_id, product_id, price_amd, set_by, updated_at)
SELECT c.id, p.id, round(p.gold_price_amd), NULL, now()
  FROM customers c
  JOIN products p ON p.gold_price_amd > 0
 WHERE c.erp_customer_id = '10001'
ON CONFLICT (customer_id, product_id) DO NOTHING;
