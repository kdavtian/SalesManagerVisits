-- Management's decision per old / hard debt account (Operations control -> Legacy balances).
-- It is a FLAG in the app, not an accounting entry: Excel stays the source of truth for the debt itself.
--   collect     = we do chase it (also for key-account channels the automatic tasks normally skip)
--   restructure = a payment plan is being agreed (normal chasing continues)
--   dispute     = being reconciled with the customer (no automatic collection tasks)
--   legal       = handed to lawyers (no automatic collection tasks)
--   write_off   = management considers it lost (no automatic collection tasks)
CREATE TABLE debt_decisions (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('collect', 'restructure', 'dispute', 'legal', 'write_off')),
  note TEXT,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
