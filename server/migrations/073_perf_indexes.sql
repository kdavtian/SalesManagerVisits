-- Indexes for query shapes that grew without one, found by code inspection
-- of the routes actually running them (no production query-plan access in
-- this environment, so no EXPLAIN ANALYZE numbers to cite -- these are the
-- WHERE/JOIN/ORDER BY columns with no supporting index today).

-- customers.js GET / orders every list (filtered or not) by name; the
-- search filter itself is a leading-wildcard ILIKE ('%term%'), which a
-- plain btree can't help with, but the ORDER BY benefits from every call.
CREATE INDEX customers_name_idx ON customers (name);

-- customers.js's findDuplicateCustomer bounding-box check (see
-- DUPLICATE_CUSTOMER_RADIUS_METERS) filters on both columns together on
-- every customer create/update.
CREATE INDEX customers_lat_lng_idx ON customers (lat, lng);

-- reports.js's brand-availability list filters out NULLs then sorts by
-- customer and recency -- partial index skips the (majority) checkins that
-- never set a brand_status.
CREATE INDEX checkins_brand_status_idx ON checkins (customer_id, timestamp DESC) WHERE brand_status IS NOT NULL;

-- orders.js GET / (the paginated main list) and GET /recorded-list both
-- sort by one of these; status/customer/user already have their own
-- indexes (see 022_perf_indexes.sql) but not paired with the sort column.
CREATE INDEX orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX orders_status_recorded_updated_idx ON orders (status, recorded, updated_at DESC);

-- payments.js's custody columns (current_holder_name join, findLikelyDuplicate)
-- are looked up unconditionally on every list/detail read; 059's partial
-- index only covers the common "no pending handoff" case, not lookups that
-- include mid-handoff rows.
CREATE INDEX payments_current_holder_all_idx ON payments (current_holder_id);
