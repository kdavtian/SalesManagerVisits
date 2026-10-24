-- Potential level: "Very high" is gone (owner, 2026-10-24: "Completely remove Very high potential type. Keep only 4").
-- Prospects that were Very high (5) become High (4); the history keeps its rows with the same mapping, and the column accepts 1-4 only.
UPDATE customers SET potential_level = 4 WHERE potential_level = 5;
UPDATE customer_potential_history SET old_level = 4 WHERE old_level = 5;
UPDATE customer_potential_history SET new_level = 4 WHERE new_level = 5;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_potential_level_check;
ALTER TABLE customers ADD CONSTRAINT customers_potential_level_check CHECK (potential_level BETWEEN 1 AND 4);
