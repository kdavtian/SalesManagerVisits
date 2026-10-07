-- Company legal name and legal address (from the state register, found by TIN).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS legal_address TEXT;
