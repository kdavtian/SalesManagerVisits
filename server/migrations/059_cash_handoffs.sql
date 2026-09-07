-- Cash custody chain (physical hand-to-hand handoffs).
--
-- Until now a payment had exactly one state transition that mattered:
-- pending -> approved, done by whoever reviewed it. In reality the physical
-- cash travels through several pairs of hands before anyone reconciles it:
--   sales_manager -> sales_director -> (ceo OR accountant, director's
--   choice) -> accountant
-- with the accountant always terminal. Each hop has a sender who declares
-- it and a receiver who confirms (or rejects) that they physically got the
-- money.
--
-- This is deliberately a LAYER ON TOP of payments.status, not a
-- replacement: payments.status keeps meaning "has this money's journey
-- fully completed and been reconciled", which is what Reports, the
-- financial CSV exports, Team Performance and the payment notifications
-- already key off. The terminal accountant confirmation is what flips a
-- payment to 'approved', so the old single-stage meaning still holds.

-- Who physically holds this specific payment's cash right now.
ALTER TABLE payments ADD COLUMN current_holder_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Non-null while this payment is bundled into a handoff awaiting the
-- receiver's confirm/reject decision. A payment can be in at most one
-- in-flight handoff at a time -- this column IS that lock.
ALTER TABLE payments ADD COLUMN pending_handoff_id INTEGER;

CREATE TABLE cash_handoffs (
  id               SERIAL PRIMARY KEY,
  -- from_user_id is the person whose custody the cash is leaving. It is
  -- NOT always the person who tapped submit: for the first hop the sales
  -- director submits on behalf of the manager who handed them the cash
  -- (see submitted_by), mirroring the existing canSubmitPaymentsForOthers
  -- pattern in routes/payments.js.
  from_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  to_user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Always recomputed server-side as the sum of the included payments;
  -- never taken from the client. Stored so the historical total survives
  -- even if a payment row is later corrected.
  amount_amd       NUMERIC(14,2) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  submitted_by     INTEGER NOT NULL REFERENCES users(id),
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_by     INTEGER REFERENCES users(id),
  confirmed_at     TIMESTAMPTZ,
  rejected_by      INTEGER REFERENCES users(id),
  rejected_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  note             TEXT
);

CREATE TABLE cash_handoff_items (
  handoff_id INTEGER NOT NULL REFERENCES cash_handoffs(id) ON DELETE CASCADE,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  PRIMARY KEY (handoff_id, payment_id)
);

-- Added after the table exists, since the column above is declared first.
ALTER TABLE payments
  ADD CONSTRAINT payments_pending_handoff_fkey
  FOREIGN KEY (pending_handoff_id) REFERENCES cash_handoffs(id) ON DELETE SET NULL;

CREATE INDEX cash_handoffs_to_user_status_idx ON cash_handoffs (to_user_id, status);
CREATE INDEX cash_handoffs_from_user_idx ON cash_handoffs (from_user_id);
CREATE INDEX cash_handoff_items_payment_idx ON cash_handoff_items (payment_id);
-- The "available to hand off" query is holder + no in-flight handoff +
-- still pending, run on every Payments screen load for a sender.
CREATE INDEX payments_current_holder_idx ON payments (current_holder_id) WHERE pending_handoff_id IS NULL;

-- Backfill: every existing payment's current holder is whoever collected
-- it (sales_manager_id) if still pending, or whoever approved it if
-- already terminal -- there is no custody chain history for rows created
-- before this migration, so this is a reasonable one-time default, not a
-- claim about what actually happened historically.
UPDATE payments SET current_holder_id = COALESCE(approved_by, sales_manager_id) WHERE current_holder_id IS NULL;
