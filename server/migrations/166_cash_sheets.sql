-- Document flow V1 + V2 (owner, 2026-10-28; .claude/skills/kadprocesses/references/cash-collection-flow.md).
-- The director counts the rep's cash: counted_amd is what was on the table (NULL = the expected amount, confirmed without a count typed);
-- a different amount is a discrepancy with a note. The director's confirmation of a rep's hand-off makes a "daily cash sheet": the same
-- rows the paper list had (date, ERP id, customer, amount), posted to the accounting Telegram group by the CEO bot (posted_at), then
-- marked "Recorded in Excel" by the accountant (recorded_at) or closed by the sync when every payment of it is found in the Excel.
ALTER TABLE cash_handoffs ADD COLUMN IF NOT EXISTS counted_amd NUMERIC(14,2);
ALTER TABLE cash_handoffs ADD COLUMN IF NOT EXISTS discrepancy_note TEXT;

CREATE TABLE IF NOT EXISTS cash_sheets (
  id              SERIAL PRIMARY KEY,
  handoff_id      INTEGER NOT NULL UNIQUE REFERENCES cash_handoffs(id) ON DELETE CASCADE,
  rep_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  director_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sheet_date      DATE NOT NULL,
  total_amd       NUMERIC(14,2) NOT NULL,
  counted_amd     NUMERIC(14,2) NOT NULL,
  item_count      INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at       TIMESTAMPTZ,
  post_attempts   INTEGER NOT NULL DEFAULT 0,
  last_post_error TEXT,
  recorded_at     TIMESTAMPTZ,
  recorded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded_auto   BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS cash_sheets_unposted_idx ON cash_sheets (id) WHERE posted_at IS NULL;
CREATE INDEX IF NOT EXISTS cash_sheets_open_idx ON cash_sheets (created_at) WHERE recorded_at IS NULL;

-- The document flow's automatic tasks (cashSheets.js): a rep's hand-off unconfirmed by 20:00, sheets not recorded after 2 days, a discrepancy.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN
  ('debt_collection', 'reorder_followup', 'dead_stock', 'fx_review', 'excel_upload', 'data_quality', 'data_missing', 'order_waiting', 'downpayment',
   'cash_handoff_unconfirmed', 'cash_sheet_not_recorded', 'cash_discrepancy'));
