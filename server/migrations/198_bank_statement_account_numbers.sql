-- Bank statements, owner 2026-11-11 (the Evoca statement): a statement names its own account (number, holder, currency, period, balances), so the
-- app can pick the Cashflow account by itself and refuse a file that belongs to another account. The number is remembered on the account the first
-- time a statement is imported into it.
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS account_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS cash_accounts_account_number_uq ON cash_accounts (account_number) WHERE account_number IS NOT NULL;

-- What the statement says about each operation: its kind (Evoca "ԳՏ": TRF transfer, FEE commission, MSC other) and the other side's account number
-- (a transfer to or from one of our own accounts is not income or expense -- the category rules read it).
ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS type_code TEXT, ADD COLUMN IF NOT EXISTS counterparty_account TEXT;

-- The header block of the imported file and the result of checking the lines against its own totals (kept as the audit trail of the import).
ALTER TABLE bank_imports ADD COLUMN IF NOT EXISTS statement_meta JSONB;
