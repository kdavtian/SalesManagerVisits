-- A document request's message remembers WHICH request it told (orders.accounting_requested_at), so the app decides from the order's own
-- state whether the accounting group still has to be told "create the document" -- a request whose message was lost (a restart right
-- after the tap) is posted by the minute job, and a request asked again is said again (owner 2026-11-27, orders/orderGroupPost.js).
ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ;
-- Only requests asked from this deploy on are posted: the job must not post "create" for documents already made before the feature.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS document_request_since TIMESTAMPTZ NOT NULL DEFAULT now();
