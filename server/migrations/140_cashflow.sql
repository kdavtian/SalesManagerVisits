-- Cashflow module (owner, 2026-10-23): the Excel Cashflow sheet (table `Cash`, one row per money movement) moves into the app.
-- Phase 1: the whole ledger arrives from Excel (the bot or an uploaded workbook REPLACES the rows with origin = 'excel' each time, manual rows
-- are never touched) until the owner switches over; accounts ("Source": Cash YVN, EvocaBank AMD ...) and categories ("For") are real tables.

CREATE TABLE cash_accounts (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'bank' CHECK (kind IN ('cash', 'bank', 'credit', 'other')),
  active      BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cash_accounts_name_lower_uq ON cash_accounts (lower(name));

-- kind: income = money coming from customers / others; expense = running the business; owner = owner / family money (dividend, personal, loans);
-- internal = moves between our own accounts (to bank, exchange, transfer, balance corrections ...) -- never counted as income or expense.
CREATE TABLE cash_categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'owner', 'internal')),
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cash_categories_name_lower_uq ON cash_categories (lower(name));

INSERT INTO cash_categories (name, kind, sort_order) VALUES
  ('Oil order', 'income', 10),
  ('Interest', 'expense', 40), ('Purchase', 'expense', 20), ('Customs', 'expense', 21), ('Tax', 'expense', 22), ('Transportation', 'expense', 23),
  ('Salary', 'expense', 24), ('Office', 'expense', 25), ('Fuel', 'expense', 26), ('Maintenance', 'expense', 27), ('Marketing', 'expense', 28),
  ('Loan', 'expense', 41), ('PPE', 'expense', 42), ('Other', 'expense', 90),
  ('Divident', 'owner', 60), ('Personal', 'owner', 61), ('Armen Loans', 'owner', 62), ('Investment', 'owner', 63),
  ('To bank', 'internal', 80), ('Exchange', 'internal', 81), ('Transfer', 'internal', 82), ('Balance', 'internal', 83),
  ('Credit Line', 'internal', 84), ('Poxarutyun', 'internal', 85), ('Veradarcvox', 'internal', 86);

CREATE TABLE cash_entries (
  id               SERIAL PRIMARY KEY,
  entry_date       DATE NOT NULL,
  amount           NUMERIC(16, 2) NOT NULL,             -- signed, in `currency` (+ in, - out)
  currency         TEXT NOT NULL DEFAULT 'AMD' CHECK (currency IN ('AMD', 'USD')),
  fx_rate          NUMERIC(10, 4),                      -- AMD per USD, typed on USD rows
  amount_amd       NUMERIC(16, 2) NOT NULL,
  category_id      INTEGER REFERENCES cash_categories(id) ON DELETE RESTRICT,
  account_id       INTEGER REFERENCES cash_accounts(id) ON DELETE RESTRICT,
  erp_customer_id  TEXT,                                -- "Oil order" rows: the customer who paid
  ref              TEXT,                                -- other rows: the free text of the Excel ID column (car plate, model ...)
  info             TEXT,
  sales_rep        TEXT,
  transaction_id   TEXT,
  origin           TEXT NOT NULL DEFAULT 'excel' CHECK (origin IN ('excel', 'manual', 'bank')),
  excel_row        INTEGER,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cash_entries_date_idx ON cash_entries (entry_date DESC, id DESC);
CREATE INDEX cash_entries_account_idx ON cash_entries (account_id, entry_date);
CREATE INDEX cash_entries_category_idx ON cash_entries (category_id, entry_date);
CREATE INDEX cash_entries_customer_idx ON cash_entries (erp_customer_id) WHERE erp_customer_id IS NOT NULL;
CREATE INDEX cash_entries_origin_idx ON cash_entries (origin);

-- Every time the ledger was refreshed from Excel (the bot's push or a workbook uploaded in the app).
CREATE TABLE cash_syncs (
  id          SERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  via         TEXT NOT NULL CHECK (via IN ('bot', 'upload')),
  rows_in     INTEGER NOT NULL,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  file_name   TEXT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT
);
