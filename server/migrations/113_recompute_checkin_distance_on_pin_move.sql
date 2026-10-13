-- When a customer's pin moves, every saved check-in at that customer is measured again against the NEW pin:
-- distance_meters and within_range ("Location verified" / "Location mismatch") follow the pin, so visits
-- made at the real shop stop showing "mismatch" after the pin was corrected. Same haversine as
-- server/src/utils/geo.js; the limit is the Check-in allowance setting.
-- (Bonus GPS evidence rows stay as they were: they are the record of what was decided at the time.)
CREATE OR REPLACE FUNCTION checkins_recompute_for_pin() RETURNS TRIGGER AS $$
DECLARE
  allowance INTEGER;
BEGIN
  SELECT checkin_radius_meters INTO allowance FROM app_settings WHERE id = 1;
  allowance := COALESCE(allowance, 300);
  UPDATE checkins ch
     SET distance_meters = d.dist,
         within_range = d.dist <= allowance
    FROM (
      SELECT id,
             2 * 6371000 * asin(sqrt(
               sin(radians(NEW.lat - lat) / 2) ^ 2 +
               cos(radians(lat)) * cos(radians(NEW.lat)) * sin(radians(NEW.lng - lng) / 2) ^ 2
             )) AS dist
        FROM checkins
       WHERE customer_id = NEW.id
    ) d
   WHERE ch.id = d.id
     AND (ch.distance_meters IS DISTINCT FROM d.dist OR ch.within_range IS DISTINCT FROM (d.dist <= allowance));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_pin_recompute_checkins ON customers;
CREATE TRIGGER customers_pin_recompute_checkins
  AFTER UPDATE OF lat, lng ON customers
  FOR EACH ROW
  WHEN (OLD.lat IS DISTINCT FROM NEW.lat OR OLD.lng IS DISTINCT FROM NEW.lng)
  EXECUTE FUNCTION checkins_recompute_for_pin();

-- Pins that were already corrected before this migration (approved pin edit requests): measure their check-ins
-- once against the current pin, so the history is right too.
UPDATE checkins ch
   SET distance_meters = d.dist,
       within_range = d.dist <= COALESCE((SELECT checkin_radius_meters FROM app_settings WHERE id = 1), 300)
  FROM (
    SELECT k.id,
           2 * 6371000 * asin(sqrt(
             sin(radians(c.lat - k.lat) / 2) ^ 2 +
             cos(radians(k.lat)) * cos(radians(c.lat)) * sin(radians(c.lng - k.lng) / 2) ^ 2
           )) AS dist
      FROM checkins k
      JOIN customers c ON c.id = k.customer_id
     WHERE c.id IN (SELECT DISTINCT customer_id FROM customer_edit_requests WHERE status = 'approved' AND changes ? 'lat')
  ) d
 WHERE ch.id = d.id;
