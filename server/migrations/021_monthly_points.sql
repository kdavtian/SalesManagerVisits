-- A permanent record of each month's point standings, closed out on demand
-- by an admin (there's no scheduler in this app to do it automatically).
-- user_name is a snapshot, and user_id can go NULL rather than cascade-delete
-- the whole row -- a rep leaving the company shouldn't erase the bonus
-- record of a month they actually won.
CREATE TABLE monthly_points_closeouts (
  id SERIAL PRIMARY KEY,
  month DATE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL,
  total_points INTEGER NOT NULL,
  visit_points INTEGER NOT NULL,
  photo_points INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (month, user_id)
);
