-- Call and Visit tasks (owner, 2026-10-18): management (and Vaghinak, for customers nobody must visit) give a rep a CALL task;
-- the rep taps Call in the task, the phone dials, and when they are back they record how the call went. A VISIT task closes
-- itself with the rep's check-in at that customer. Every call result is kept in customer_calls (a history line per call).
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_task_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_task_kind_check CHECK (task_kind IN ('collect_debt', 'make_order', 'check_products', 'call_customer', 'visit_customer'));

CREATE TABLE IF NOT EXISTS customer_calls (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  result TEXT NOT NULL CHECK (result IN ('spoke', 'no_answer', 'call_back', 'wrong_number')),
  note TEXT,
  callback_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_calls_customer_idx ON customer_calls (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_calls_task_idx ON customer_calls (task_id);
