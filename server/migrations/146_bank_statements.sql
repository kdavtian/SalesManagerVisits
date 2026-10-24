-- Cashflow phase 3 (owner, 2026-10-24): bank statements. A statement (CSV / Excel) of one bank account is read into lines and kept, so it is never imported
-- twice; the lines are reconciled against the Cashflow ledger. Excel stays the main ledger for now, so a bank line and its Excel row are the SAME money:
-- the match is computed from the current ledger every time (the Excel refresh replaces its rows, ids cannot be remembered). Only the accountant's
-- decisions are stored: status 'added' (a manual ledger row was made from the line, entry_id) or 'ignored'.
CREATE TABLE bank_imports (
  id             SERIAL PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES cash_accounts(id) ON DELETE CASCADE,
  file_name      TEXT,
  rows_in        INTEGER NOT NULL,
  rows_new       INTEGER NOT NULL,
  rows_duplicate INTEGER NOT NULL,
  rows_skipped   INTEGER NOT NULL DEFAULT 0,
  via            TEXT NOT NULL DEFAULT 'upload' CHECK (via IN ('upload', 'bot')),
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bank_statement_lines (
  id           SERIAL PRIMARY KEY,
  import_id    INTEGER REFERENCES bank_imports(id) ON DELETE SET NULL,
  account_id   INTEGER NOT NULL REFERENCES cash_accounts(id) ON DELETE CASCADE,
  line_date    DATE NOT NULL,
  amount       NUMERIC(16, 2) NOT NULL,                 -- signed, in `currency` (+ in, - out)
  currency     TEXT NOT NULL DEFAULT 'AMD' CHECK (currency IN ('AMD', 'USD')),
  description  TEXT,
  counterparty TEXT,
  reference    TEXT,
  balance      NUMERIC(16, 2),
  line_hash    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'added', 'ignored')),
  entry_id     INTEGER REFERENCES cash_entries(id) ON DELETE SET NULL,
  decided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bank_statement_lines_hash_uq ON bank_statement_lines (account_id, line_hash);
CREATE INDEX bank_statement_lines_account_date_idx ON bank_statement_lines (account_id, line_date);
CREATE INDEX bank_statement_lines_status_idx ON bank_statement_lines (status) WHERE status = 'open';
