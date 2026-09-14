-- Client-generated idempotency keys for check-ins and orders, same pattern
-- migration 046 already established for payments (payments.client_ref):
-- the offline queue (client/public/js/offlineQueue.js) retries a queued
-- submission on every network failure, but a "failure" there can mean the
-- request actually reached the server and succeeded -- only the response
-- was lost (connection dropped mid-response, tab closed before it was
-- processed). Without an idempotency key, that retry creates a second,
-- duplicate check-in/order for the same field visit. The queue now sends
-- the same client-generated ref on every attempt for a given queued entry;
-- these unique indexes let the create endpoints recognize a retry and
-- return the original record instead of inserting a duplicate.
ALTER TABLE checkins ADD COLUMN client_ref TEXT;
CREATE UNIQUE INDEX checkins_user_id_client_ref_idx ON checkins (user_id, client_ref) WHERE client_ref IS NOT NULL;

ALTER TABLE orders ADD COLUMN client_ref TEXT;
CREATE UNIQUE INDEX orders_user_id_client_ref_idx ON orders (user_id, client_ref) WHERE client_ref IS NOT NULL;
