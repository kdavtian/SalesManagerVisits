-- A customer's KAD OS install signs in to KAD Motors with its own account, whose role is "customer" (owner, 2026-10-21): it has no staff rights at
-- all (partner_only: only /api/partner/*), is created from Settings -> KAD OS -> Customer accounts, and is kept out of the Team list.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'ceo', 'operations_director', 'sales_manager', 'sales_director', 'warehouse_manager', 'delivery_manager', 'accountant', 'customer'));
