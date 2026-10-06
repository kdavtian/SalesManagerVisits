-- Owner decision: every customer is visited every 7 days by default.
-- Sets the new-customer default (column default + the admin setting) to 7 and
-- moves EVERY existing customer to 7 days. The previous per-customer values
-- are kept in customer_visit_frequency_backup_088 so this can be reversed:
--   UPDATE customers c SET visit_frequency_days = b.old_days
--   FROM customer_visit_frequency_backup_088 b WHERE b.customer_id = c.id;
CREATE TABLE IF NOT EXISTS customer_visit_frequency_backup_088 (
  customer_id INTEGER PRIMARY KEY,
  old_days INTEGER NOT NULL,
  backed_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO customer_visit_frequency_backup_088 (customer_id, old_days)
SELECT id, visit_frequency_days FROM customers
ON CONFLICT (customer_id) DO NOTHING;

ALTER TABLE customers ALTER COLUMN visit_frequency_days SET DEFAULT 7;
ALTER TABLE app_settings ALTER COLUMN default_visit_frequency_days SET DEFAULT 7;

UPDATE customers SET visit_frequency_days = 7 WHERE visit_frequency_days <> 7;
UPDATE app_settings SET default_visit_frequency_days = 7;
