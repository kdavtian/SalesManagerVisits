-- Cashflow (owner, 2026-10-27): every change of a ledger row is logged with date and time, and edits / deletions follow a rule:
-- admin and CEO change any row the app made; the accountant changes a row up to 3 days after it was made, older ones only through a
-- request that management (admin / CEO) approves. Rows from Excel stay read-only while Excel is the source.

-- One line per thing that happened to a row: created, updated, deleted, change requested, request approved / rejected.
-- entry_id has no foreign key on purpose: the history of a deleted row stays.
CREATE TABLE cash_entry_log (
  id          SERIAL PRIMARY KEY,
  entry_id    INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'request', 'approve', 'reject')),
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  before      JSONB,
  after       JSONB,
  note        TEXT
);
CREATE INDEX cash_entry_log_entry_idx ON cash_entry_log (entry_id, at);

-- A change of a row older than the accountant's window, waiting for management.
CREATE TABLE cash_entry_requests (
  id            SERIAL PRIMARY KEY,
  entry_id      INTEGER NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('update', 'delete')),
  payload       JSONB,
  reason        TEXT,
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ
);
CREATE INDEX cash_entry_requests_pending_idx ON cash_entry_requests (status, requested_at) WHERE status = 'pending';
CREATE UNIQUE INDEX cash_entry_requests_one_pending_uq ON cash_entry_requests (entry_id) WHERE status = 'pending';
