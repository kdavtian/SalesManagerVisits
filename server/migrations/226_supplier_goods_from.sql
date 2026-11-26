-- A transporter is not the supplier (owner, 2026-11-26: "Sole Trans is the transporter. Real company: Castrol"). The Excel Purchase_IN and
-- the app's purchases write the invoice under the transporter that brought the goods; the smart purchase suggestions group the products
-- by the company the goods really come from. suppliers.goods_from = that company's name (NULL = the supplier itself).
-- Additive: the invoices keep the name they were written with.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS goods_from TEXT;

INSERT INTO suppliers (name, brands) SELECT 'Castrol', 'Castrol'
 WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = 'castrol');
-- the transporter is in the list even when only the Excel has used it so far
INSERT INTO suppliers (name) SELECT 'Sole Trans'
 WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = 'sole trans');
UPDATE suppliers SET goods_from = 'Castrol'
 WHERE lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = 'sole trans' AND goods_from IS NULL;
