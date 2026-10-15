-- Operations control part 2: USD/AMD rate review, dead-stock actions, and the new automatic task kinds
-- (dead_stock, fx_review, excel_upload, data_quality; data_missing and order_waiting are used by Vaghinak's chasers).
ALTER TABLE tasks DROP CONSTRAINT tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN
  ('debt_collection', 'reorder_followup', 'dead_stock', 'fx_review', 'excel_upload', 'data_quality', 'data_missing', 'order_waiting'));

-- The ONE USD/AMD rate source management types in (today's market rate). review_done = "prices were reviewed at this rate":
-- the drift that triggers a price review is measured from the latest reviewed rate.
CREATE TABLE fx_rates (
  id SERIAL PRIMARY KEY,
  rate NUMERIC(8, 2) NOT NULL CHECK (rate > 0),
  note TEXT,
  review_done BOOLEAN NOT NULL DEFAULT false,
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What management decided to do with a slow-moving product (one row per product).
CREATE TABLE stock_actions (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('campaign', 'bundle', 'discount', 'transfer', 'keep')),
  note TEXT,
  due_date DATE,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
