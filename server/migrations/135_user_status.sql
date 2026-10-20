-- Offboarding / pausing a rep (owner, 2026-10-20): the account is kept (history, orders, check-ins stay correct) but switched off.
--   active     = normal
--   paused     = on leave: cannot log in, hidden from rep lists, leaderboards, plans and Vaghinak; can be reactivated
--   offboarded = left the company: same switch-off, shown as "left" in the Team list; can still be reactivated by an admin
ALTER TABLE users
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'offboarded')),
  ADD COLUMN status_changed_at TIMESTAMPTZ,
  ADD COLUMN status_changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN status_note TEXT;
CREATE INDEX users_switched_off_idx ON users (id) WHERE status <> 'active';
