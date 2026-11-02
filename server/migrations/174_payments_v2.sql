-- Payments, redesigned (owner, 2026-11-02; answers the same day): every customer payment carries TWO tracks, shown as two chips --
--   cash:  collected (the person who took it) -> counted (the sales director) -> received (the accountant)      [cash only]
--   books: open (not in the Excel yet) -> matched (found automatically) / linked (the accountant linked it by hand)
-- A card or bank payment has no cash track: it lands straight in its account (terminal, bank). A mistake is VOIDED with a reason, never deleted.
-- Money lands in an account (cash_accounts, the Excel "Source"): a bank account, the card terminal, or the cash desk of a rep, the sales
-- director or the CEO (owner's answer 9). Fresh start: the new records begin on the cutover date (owner's answer 1: 1 November 2026); what the
-- old module records from that day on is copied in (source = 'bridge') until the new screens are switched on (payments_v2_live).
-- Rules: server/src/money/payments2/.

ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS payments_cutover DATE NOT NULL DEFAULT '2026-11-01';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS payments_v2_live BOOLEAN NOT NULL DEFAULT false;

-- The card terminal is an account of its own; a cash desk belongs to one person (the rep / director / CEO who holds that cash).
ALTER TABLE cash_accounts DROP CONSTRAINT IF EXISTS cash_accounts_kind_check;
ALTER TABLE cash_accounts ADD CONSTRAINT cash_accounts_kind_check CHECK (kind IN ('cash', 'bank', 'card', 'credit', 'other'));
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS holder_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE customer_payments (
  id                        SERIAL PRIMARY KEY,
  customer_id               INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  customer_name_snapshot    TEXT NOT NULL,
  erp_customer_id_snapshot  TEXT,
  amount_amd                NUMERIC(14, 0) NOT NULL CHECK (amount_amd > 0 AND amount_amd < 100000000000),
  paid_at                   TIMESTAMPTZ NOT NULL,
  pay_day                   DATE NOT NULL,                                   -- Yerevan date of paid_at
  method                    TEXT NOT NULL CHECK (method IN ('cash', 'card', 'bank')),
  account_id                INTEGER REFERENCES cash_accounts(id) ON DELETE RESTRICT, -- where the money is now (cash: the holder's desk)
  collected_by              INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sales_manager_id          INTEGER REFERENCES users(id) ON DELETE SET NULL, -- whose customer (commission, reports)
  cash_state                TEXT CHECK (cash_state IN ('collected', 'counted', 'received')),
  holder_id                 INTEGER REFERENCES users(id) ON DELETE SET NULL, -- who has the cash in hand now
  books_state               TEXT NOT NULL DEFAULT 'open' CHECK (books_state IN ('open', 'matched', 'linked')),
  books_note                TEXT,                                            -- why it is booked, or why it cannot be matched
  voided_at                 TIMESTAMPTZ,
  voided_by                 INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason               TEXT,
  checkin_id                INTEGER REFERENCES checkins(id) ON DELETE SET NULL,
  note                      TEXT,
  source                    TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'bridge', 'bank')),
  legacy_payment_id         INTEGER UNIQUE REFERENCES payments(id) ON DELETE SET NULL,
  client_ref                TEXT,
  created_by                INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((method = 'cash') = (cash_state IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE UNIQUE INDEX customer_payments_client_ref_uq ON customer_payments (created_by, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX customer_payments_customer_idx ON customer_payments (customer_id, pay_day DESC);
CREATE INDEX customer_payments_day_idx ON customer_payments (pay_day DESC, id DESC);
CREATE INDEX customer_payments_open_books_idx ON customer_payments (erp_customer_id_snapshot, pay_day) WHERE books_state = 'open' AND voided_at IS NULL;
CREATE INDEX customer_payments_holder_idx ON customer_payments (holder_id) WHERE cash_state IN ('collected', 'counted') AND voided_at IS NULL;
CREATE INDEX customer_payments_rep_idx ON customer_payments (sales_manager_id, pay_day DESC);

-- Which Excel Cash rows book a payment. The Excel rows are replaced on every sync (their ids change), so a row is named by a key that stays
-- the same: customer | date | amount | account | n-th identical row. One row may book several payments and one payment several rows
-- (owner's answer 5: sums are accepted), so a link carries the part of the payment it covers.
CREATE TABLE payment_book_links (
  id               SERIAL PRIMARY KEY,
  payment_id       INTEGER NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
  entry_key        TEXT NOT NULL,
  entry_date       DATE NOT NULL,
  entry_amount_amd NUMERIC(16, 0) NOT NULL,
  account_name     TEXT,
  excel_row        INTEGER,
  amount_amd       NUMERIC(14, 0) NOT NULL CHECK (amount_amd > 0),
  how              TEXT NOT NULL CHECK (how IN ('auto', 'hand')),
  linked_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_book_links_payment_idx ON payment_book_links (payment_id);
CREATE INDEX payment_book_links_entry_idx ON payment_book_links (entry_key);

-- Owner's answer 3: a payment pays the customer's oldest unpaid orders first (automatically); what is left over is an advance (answer 8).
CREATE TABLE payment_allocations (
  payment_id  INTEGER NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_amd  NUMERIC(14, 0) NOT NULL CHECK (amount_amd > 0),
  PRIMARY KEY (payment_id, order_id)
);
CREATE INDEX payment_allocations_order_idx ON payment_allocations (order_id);

-- Everything that happened to a payment, in order; never changed afterwards.
CREATE TABLE customer_payment_events (
  id          SERIAL PRIMARY KEY,
  payment_id  INTEGER NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,          -- NULL = the app itself (matching, copy from the old module)
  kind        TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX customer_payment_events_payment_idx ON customer_payment_events (payment_id, at);
CREATE TRIGGER customer_payment_events_immutable
  BEFORE UPDATE ON customer_payment_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_modification();
