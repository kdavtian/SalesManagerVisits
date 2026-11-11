-- Bank statements part 2 (owner, 2026-11-11): "the accountant has already recorded all transactions in the Excel: check them and learn from it".
-- A statement line that finds its Cashflow row teaches the app which category that payer / account / kind of operation belongs to; the next lines
-- of the same payer are suggested that category. hits = how many matched lines said so. key = 'cp:<payer>|in', 'acc:<account>|out', 'type:FEE|out' ...
CREATE TABLE IF NOT EXISTS bank_category_rules (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES cash_categories(id) ON DELETE CASCADE,
  hits        INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key, category_id)
);
CREATE INDEX IF NOT EXISTS bank_category_rules_key_idx ON bank_category_rules (key);

-- A line teaches the rules once (it stays matched on every later reading).
ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS learned_at TIMESTAMPTZ;
