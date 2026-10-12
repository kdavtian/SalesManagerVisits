-- "Check-in for everyone" customers: every rep can find and check in there regardless of
-- assignment (the Castrol Office, ERP id 10000 -- reps check in at the office first thing in
-- the morning). Such a customer is not a sales visit: it never counts as a visit in the
-- weekly scorecard or the strawberry visit bonus, and is never "overdue" / planned.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS checkin_for_all BOOLEAN NOT NULL DEFAULT false;

UPDATE customers SET checkin_for_all = true
WHERE erp_customer_id = '10000' OR name ILIKE '%castrol office%';
