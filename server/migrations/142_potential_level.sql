-- Potential Customer classification (owner, 2026-10-24): every potential customer gets a Potential Level (1-5) and the reasons behind it,
-- every change is kept as history, and "counterfeit / not original products" is a separate flag that restricts genuine Castrol supply
-- until a manager resolves it. NULL level = not assessed yet (all customers that were potential before this release, and every non-potential customer).
-- The columns beside the level (next follow-up, expected volume) are what the list filters and, later, an automatic 0-100 score would read.
ALTER TABLE customers
  ADD COLUMN potential_level          SMALLINT CHECK (potential_level BETWEEN 1 AND 5),
  ADD COLUMN potential_reasons        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN potential_reason_other   TEXT,
  ADD COLUMN potential_updated_at     TIMESTAMPTZ,
  ADD COLUMN potential_updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN next_followup_date       DATE,
  ADD COLUMN expected_volume_l        NUMERIC(10, 1) CHECK (expected_volume_l IS NULL OR expected_volume_l >= 0),   -- litres per month
  ADD COLUMN counterfeit_flag         BOOLEAN NOT NULL DEFAULT false,                                              -- true = unresolved: no genuine Castrol
  ADD COLUMN counterfeit_resolved_at  TIMESTAMPTZ,
  ADD COLUMN counterfeit_resolved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN counterfeit_resolved_comment TEXT;

CREATE INDEX customers_potential_level_idx ON customers (potential_level) WHERE customer_tier = 'potential';
CREATE INDEX customers_counterfeit_idx ON customers (id) WHERE counterfeit_flag;

CREATE TABLE customer_potential_history (
  id            SERIAL PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'level' CHECK (kind IN ('level', 'counterfeit_set', 'counterfeit_resolved')),
  old_level     SMALLINT,
  new_level     SMALLINT,
  reasons       TEXT[] NOT NULL DEFAULT '{}',
  reason_other  TEXT,
  note          TEXT,
  changed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customer_potential_history_customer_idx ON customer_potential_history (customer_id, changed_at DESC, id DESC);
