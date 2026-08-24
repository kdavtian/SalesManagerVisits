-- The only existing timestamp index is composite (user_id, timestamp),
-- which a query with no user_id filter (points leaderboard, dashboard
-- org-wide totals) can't use for its date-range scan. This is a plain
-- index on timestamp alone for exactly those queries.
CREATE INDEX idx_checkins_timestamp ON checkins (timestamp DESC);

-- The Orders page filters by status; without this, that filter is a
-- sequential scan once order volume grows past a trivial size.
CREATE INDEX idx_orders_status ON orders (status);
