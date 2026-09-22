-- Adds "operations_director" to the users.role CHECK constraint -- a new
-- role with identical permissions to "ceo" throughout the app (see
-- server/src/roles.js, which treats the two as equivalent everywhere).
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'ceo', 'operations_director', 'sales_manager', 'sales_director', 'warehouse_manager', 'delivery_manager', 'accountant'));
