-- Region/Subregion for filtering and visit planning. Own customers.* fields
-- (not ERP-derived) so every customer has them, ERP-linked or not; the ERP
-- sync only fills them in when empty, so a rep's manual correction sticks.
ALTER TABLE customers ADD COLUMN region TEXT;
ALTER TABLE customers ADD COLUMN subregion TEXT;
