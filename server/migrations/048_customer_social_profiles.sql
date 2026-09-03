ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS instagram_username TEXT,
  ADD COLUMN IF NOT EXISTS facebook_url TEXT;
