-- Rename the generic field-rep role to match how the business actually
-- refers to it ("Sales Manager"), add a CEO role for leadership-level
-- read access, and let a user carry a free-text position/territory (e.g.
-- "SM Davtashen") -- mainly meaningful for sales managers, but not
-- restricted to them at the DB level.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'ceo', 'sales_manager', 'sales_director', 'warehouse_manager', 'delivery_manager', 'manager'));

UPDATE users SET role = 'sales_manager' WHERE role = 'manager';

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'ceo', 'sales_manager', 'sales_director', 'warehouse_manager', 'delivery_manager'));

ALTER TABLE users ADD COLUMN position TEXT;
ALTER TABLE users ADD COLUMN avatar_path TEXT;

-- Default visit_frequency_days applied to newly-created customers; admin
-- can still override per customer as before.
ALTER TABLE app_settings ADD COLUMN default_visit_frequency_days INTEGER NOT NULL DEFAULT 14;
