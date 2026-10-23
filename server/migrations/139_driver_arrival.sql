-- Driver arrival (owner, 2026-10-23): the app notices that the delivery driver reached the customer. Admin picks what happens
-- (off / offer a one-tap "Delivered" / deliver automatically) and the radius + dwell time; the stop remembers when the driver arrived.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS delivery_arrival JSONB;
ALTER TABLE route_stops ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE route_stops ADD COLUMN IF NOT EXISTS arrival_distance_m INTEGER;
ALTER TABLE route_stops ADD COLUMN IF NOT EXISTS completed_by_arrival TEXT CHECK (completed_by_arrival IN ('auto', 'one_tap'));
