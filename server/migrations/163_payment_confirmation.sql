-- How the customer confirmed a payment collected at a visit (owner, 2026-10-27): signed on the rep's phone, a photo of a paper slip
-- (or of the signed paper order blank of a delivery at the same visit), or nothing -- the rep may still save it, after a warning, and
-- those payments are found with the Payments filter. NULL = not collected at a visit (entered on the Payments screen, a driver's cash).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS customer_confirmation TEXT
  CHECK (customer_confirmation IN ('signed', 'photo', 'none'));
CREATE INDEX IF NOT EXISTS payments_unconfirmed_idx ON payments (payment_date DESC) WHERE customer_confirmation = 'none';

-- Payments of visits made before this release, from what the visit kept.
UPDATE payments p SET customer_confirmation = CASE
    WHEN EXISTS (SELECT 1 FROM customer_signatures s WHERE s.checkin_id = substring(p.client_ref FROM 9)::int) THEN 'signed'
    WHEN EXISTS (SELECT 1 FROM customer_files f WHERE f.checkin_id = substring(p.client_ref FROM 9)::int AND f.kind = 'order_blank') THEN 'photo'
    ELSE 'none'
  END
WHERE p.client_ref ~ '^checkin-[0-9]+$' AND p.customer_confirmation IS NULL;
