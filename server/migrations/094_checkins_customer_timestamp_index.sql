-- Last visit / visited-today lookups per customer (customer lists, map, debt
-- balances) probe the check-ins of ONE customer, newest first. With only
-- single-column indexes PostgreSQL walked the global timestamp index instead.
CREATE INDEX IF NOT EXISTS idx_checkins_customer_timestamp ON checkins (customer_id, "timestamp" DESC);
