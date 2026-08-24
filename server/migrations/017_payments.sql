ALTER TABLE checkins ADD COLUMN amount_collected_amd NUMERIC;

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'ceo', 'sales_manager', 'sales_director', 'warehouse_manager', 'delivery_manager', 'accountant'));
