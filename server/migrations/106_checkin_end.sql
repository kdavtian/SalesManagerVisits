-- "End visit": the rep taps it when leaving the customer, so visit length can be shown
-- and averaged (weekly scorecard). NULL = not ended (most older check-ins).
ALTER TABLE checkins ADD COLUMN ended_at TIMESTAMPTZ;
