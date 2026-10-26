-- Owner, 2026-10-26: the visit outcomes "No order" and "Complaint" are gone; every record that had one is now "Other".
-- The order of the remaining values in a visit is kept, and "other" appears once even when a visit had both.
UPDATE checkins
SET outcomes = ARRAY(
  SELECT value FROM (
    SELECT CASE WHEN o IN ('no_order', 'complaint') THEN 'other' ELSE o END AS value, min(ord) AS first_pos
    FROM unnest(outcomes) WITH ORDINALITY AS u(o, ord)
    GROUP BY 1
  ) merged
  ORDER BY first_pos
)
WHERE outcomes && ARRAY['no_order', 'complaint'];

UPDATE checkins SET outcome = 'other' WHERE outcome IN ('no_order', 'complaint');

-- A photo taken at a check-in is either a visit photo or the photo of the signed order blank ("Products delivered").
-- Order blanks are listed under Files > Documents of the customer; order_ids says which delivered orders it covers.
ALTER TABLE checkin_photos
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'order_blank')),
  ADD COLUMN IF NOT EXISTS order_ids integer[] NOT NULL DEFAULT '{}';
