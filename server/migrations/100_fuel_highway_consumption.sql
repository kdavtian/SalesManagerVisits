-- Separate highway consumption: fuel_l_per_100km stays the CITY figure (stop-and-go
-- in Yerevan); on the open road the same car burns noticeably less.
ALTER TABLE users ADD COLUMN IF NOT EXISTS fuel_highway_l_per_100km NUMERIC(5, 2);
