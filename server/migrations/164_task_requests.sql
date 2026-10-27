-- A "request" (Խնդրանք) instead of a task (owner, 2026-10-27): the accountant and the financial director ask the sales director for
-- something. It works exactly like a task -- checklist, deadline, done / cancelled -- only its name differs, so the sales director sees
-- it is a colleague's request, not an order from above.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_request BOOLEAN NOT NULL DEFAULT false;
