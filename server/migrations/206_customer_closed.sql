-- Close a customer instead of deleting it (owner, 2026-11-15: "Kotayk yuxman ket3" closed, its payments block the delete).
-- A closed customer leaves field work (lists, map, visit plans, route plans, reminders, new orders / visits) but keeps its history,
-- payments and debt; it can be reopened. NULL closed_at = open.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS close_reason TEXT;
CREATE INDEX IF NOT EXISTS customers_closed_idx ON customers (closed_at) WHERE closed_at IS NOT NULL;
