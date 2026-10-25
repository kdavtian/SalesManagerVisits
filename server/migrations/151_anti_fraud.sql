-- Anti-fraud (owner, 2026-10-25): signals that cash collected by reps may not reach the books. Vaghinak watches, management decides.
--  fraud_alerts       one row per finding (a payment missing from Excel, cash held too long, a customer who "does not see" a payment, ...)
--  fraud_settings     the limits management can change (days, amount)
--  fraud_signal_weights  how much each kind of finding counts in a rep's risk score; "confirmed" / "false alarm" verdicts move them (he learns)
--  fraud_spot_checks  the weekly "call this customer and ask" list
CREATE TABLE fraud_alerts (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  payment_id INTEGER,
  amount_amd NUMERIC,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'false_alarm', 'auto_resolved')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX fraud_alerts_dedupe_idx ON fraud_alerts (dedupe_key);
CREATE INDEX fraud_alerts_status_idx ON fraud_alerts (status, created_at DESC);
CREATE INDEX fraud_alerts_rep_idx ON fraud_alerts (rep_id, status);

CREATE TABLE fraud_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fraud_signal_weights (
  kind TEXT PRIMARY KEY,
  weight NUMERIC NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  false_alarms INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fraud_spot_checks (
  id SERIAL PRIMARY KEY,
  week_start DATE NOT NULL,
  payment_id INTEGER NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  amount_amd NUMERIC NOT NULL,
  payment_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'confirmed', 'mismatch', 'no_answer')),
  note TEXT,
  checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_start, payment_id)
);
CREATE INDEX fraud_spot_checks_week_idx ON fraud_spot_checks (week_start DESC, status);
