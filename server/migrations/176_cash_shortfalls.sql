-- Payments redesign, release 3 (owner, 2026-11-02, answer 6): when the cash counted at a hand-over is LESS than the payments in it, the
-- difference stays on the sender's line ("short") until it is closed: paid in (the missing notes were handed over) or written off by
-- admin / the CEO with a reason. The note, the task and the alert to admin / CEO stay as before (cash_handoffs.discrepancy_note).
CREATE TABLE cash_shortfalls (
  id           SERIAL PRIMARY KEY,
  handoff_id   INTEGER NOT NULL UNIQUE REFERENCES cash_handoffs(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,       -- whose line it is (the sender of the hand-over)
  amount_amd   NUMERIC(14, 0) NOT NULL CHECK (amount_amd > 0),
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'written_off')),
  closed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at    TIMESTAMPTZ,
  close_note   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cash_shortfalls_open_idx ON cash_shortfalls (user_id) WHERE status = 'open';
