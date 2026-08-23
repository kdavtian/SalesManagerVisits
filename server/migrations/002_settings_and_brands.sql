CREATE TABLE app_settings (
  id                     INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  checkin_radius_meters  INTEGER NOT NULL DEFAULT 200
);

INSERT INTO app_settings (id, checkin_radius_meters) VALUES (1, 200);

ALTER TABLE checkins ADD COLUMN brands_found TEXT[];
