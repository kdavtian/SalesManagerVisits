-- Who currently owns a customer for routing/visibility purposes -- distinct
-- from created_by (an immutable audit fact: who originally added the
-- customer). assigned_manager_id starts out equal to created_by (the rep
-- who found it is the natural first owner) but, unlike created_by, a
-- director/ceo/admin can reassign it later without rewriting history.
ALTER TABLE customers ADD COLUMN assigned_manager_id INTEGER REFERENCES users(id);
UPDATE customers SET assigned_manager_id = created_by WHERE assigned_manager_id IS NULL;

-- Sales channel (PVO/CVO/OEM) -- a separate dimension from category (which
-- describes the storefront type, e.g. shop/workshop). Free text rather than
-- a CHECK constraint so a future channel doesn't need a migration to add.
ALTER TABLE customers ADD COLUMN sales_channel TEXT;

CREATE INDEX idx_customers_assigned_manager_id ON customers (assigned_manager_id);
