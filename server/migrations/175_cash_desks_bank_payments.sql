-- Payments, redesigned -- release 2 (owner, 2026-11-02): cash desks and bank payments.
--
-- Cash desks: a cash desk is a cash account (the Excel "Source", e.g. "Office desk", "SM YVN desk") and may have SEVERAL holders (the office
-- desk: both accountants and the CEO). Admin adds and edits desks; every sales rep automatically gets a desk of his own, so the cash he
-- collects lands on it. A renamed desk keeps its old name as an Excel alias, so the next Excel refresh still lands on the same desk.
--
-- Bank payments: card payments go through the bank too. The accountant records a bank payment by hand or uploads the bank statement
-- (bank_statement_lines, already deduplicated by line hash); a credit line whose payer is recognised (TIN, a payer confirmed before, an
-- exact customer name) becomes a customer payment automatically, or confirms the payment typed by hand. Everything the app cannot decide
-- waits in "Unspecified". The same money is never recorded twice: a payment holds at most one statement line and a line at most one payment.

-- 1. Several holders per desk (the single holder_user_id of release 1 is copied in and no longer read).
CREATE TABLE cash_desk_holders (
  account_id  INTEGER NOT NULL REFERENCES cash_accounts(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX cash_desk_holders_user_idx ON cash_desk_holders (user_id);
INSERT INTO cash_desk_holders (account_id, user_id)
  SELECT id, holder_user_id FROM cash_accounts WHERE holder_user_id IS NOT NULL
  ON CONFLICT DO NOTHING;

-- 2. Old names of a renamed account: the Excel import still finds the account by them.
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS excel_aliases TEXT[] NOT NULL DEFAULT '{}';
-- The rep a desk was made for automatically (so it is not made twice and its name can follow the person).
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS auto_for_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- 3. A bank payment and the statement line that proves it (one each way).
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS bank_line_id INTEGER REFERENCES bank_statement_lines(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_payments_bank_line_uq ON customer_payments (bank_line_id) WHERE bank_line_id IS NOT NULL;
-- How the customer of a bank payment was found: tin | learned | name | hand (picked by the accountant) | typed (recorded by hand)
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS payer_match TEXT;

-- 4. What the payments side decided about a statement line (the Cashflow side keeps its own `status`):
--   NULL         not a customer payment candidate (money out, USD, before the cutover, not a bank account) or not looked at yet
--   recorded     a customer payment holds it (customer_payments.bank_line_id)
--   unspecified  waits for the accountant: unknown payer, or it looks like a second copy of a line already recorded
--   not_customer the accountant said: not a customer payment (own transfer, loan, card settlement ...)
--   duplicate    the accountant said: the same money as a line already recorded
ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS pay_state TEXT CHECK (pay_state IN ('recorded', 'unspecified', 'not_customer', 'duplicate'));
ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS pay_reason TEXT CHECK (pay_reason IN ('unknown_payer', 'possible_copy', 'ambiguous'));
ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS pay_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL; -- the customer found / suggested
ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS pay_copy_of INTEGER REFERENCES bank_statement_lines(id) ON DELETE SET NULL;
ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS pay_checked_at TIMESTAMPTZ;
ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS pay_decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS bank_statement_lines_pay_todo_idx ON bank_statement_lines (line_date) WHERE pay_state = 'unspecified';
CREATE INDEX IF NOT EXISTS bank_statement_lines_unchecked_idx ON bank_statement_lines (id) WHERE pay_checked_at IS NULL AND amount > 0;

-- 5. Payers the accountant confirmed once: the next line from the same payer is recorded on its own (or skipped as not a customer).
CREATE TABLE bank_payers (
  payer_key     TEXT PRIMARY KEY,                                           -- the payer name, normalised (bankPayments.js payerKey)
  customer_id   INTEGER REFERENCES customers(id) ON DELETE CASCADE,         -- NULL = not a customer payment
  payer_label   TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
