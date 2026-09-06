-- Links a pod_records row to the payments row it produced, for the
-- accountant's "Create payment record" action on the Recorded (POD)
-- screen (see routes/delivery.js's POST /pod-records/:id/create-payment).
-- Nullable/1:1-ish, same convention as orders.checkin_id -- most pod_records
-- rows will never have a payment created from them (accountant hasn't
-- tapped the button, or amount_collected_amd is 0/null), and ON DELETE SET
-- NULL means a payment being deleted elsewhere never blocks deleting a
-- pod_records row.
ALTER TABLE pod_records ADD COLUMN payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL;
