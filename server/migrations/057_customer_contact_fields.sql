-- Informational contact fields shown alongside the social profiles on the
-- customer detail header (see 048_customer_social_profiles.sql). These are
-- not verified/authenticated addresses -- they exist so a rep can tap
-- through to the customer's mailbox or site, the same way the Instagram and
-- Facebook links already work.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT;
