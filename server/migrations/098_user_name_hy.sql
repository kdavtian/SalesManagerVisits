-- Full name in Armenian, printed on the order blank ("Մենեջեր՝ Արտակ Հայրապետյան").
-- Optional; the blank falls back to users.name when it is empty.
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_hy TEXT;
