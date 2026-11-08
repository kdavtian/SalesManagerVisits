-- One request card for every approval (owner, 2026-11-08): a denial always carries a short written reason, which the person who asked
-- receives in their push. Four kinds had nowhere to keep it (payments, returns, performance plans and bonus claims already do).
-- Customer edit requests used to write the reviewer's note over the requester's own note: the reason now has its own column.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS approval_reason TEXT;
ALTER TABLE customer_edit_requests ADD COLUMN IF NOT EXISTS review_reason TEXT;
ALTER TABLE cash_entry_requests ADD COLUMN IF NOT EXISTS decision_reason TEXT;
ALTER TABLE visit_plans ADD COLUMN IF NOT EXISTS review_reason TEXT;
-- "The first one who decides closes it for the others": the other approvers' unread notifications of that request are marked read by url.
CREATE INDEX IF NOT EXISTS notifications_unread_url_idx ON notifications (url) WHERE read_at IS NULL;
