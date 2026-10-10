-- The Excel sync now also records changes of the tier prices (bronze / silver /
-- gold) in the price history, and tells the sales team when prices change.
ALTER TABLE product_price_history DROP CONSTRAINT product_price_history_price_type_check;
ALTER TABLE product_price_history
  ADD CONSTRAINT product_price_history_price_type_check
  CHECK (price_type IN ('standard', 'retail', 'special', 'bronze', 'silver', 'gold'));
