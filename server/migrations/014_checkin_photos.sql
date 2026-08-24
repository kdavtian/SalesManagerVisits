-- Multiple photos per check-in. checkins.photo_path is kept (existing rows
-- keep working through the old single-photo endpoint) but new check-ins
-- write only into this table.
CREATE TABLE checkin_photos (
  id SERIAL PRIMARY KEY,
  checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  photo_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX checkin_photos_checkin_id_idx ON checkin_photos (checkin_id);

-- Backfill existing single-photo check-ins so "does this visit have a
-- photo" logic (points) only has to look in one place.
INSERT INTO checkin_photos (checkin_id, photo_path)
SELECT id, photo_path FROM checkins WHERE photo_path IS NOT NULL;
