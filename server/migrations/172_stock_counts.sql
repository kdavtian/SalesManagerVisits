-- Stock count (Գույքագրում), owner 2026-10-30: every active product is counted once a month, spread over the month's working days
-- (Mon-Sat, company holidays skipped), so the warehouse manager counts a part of the stock every day. A product not counted on its day
-- moves to the next day (that day is "not finished"); a difference against the Excel stock is reported to the CEO / admin and becomes
-- a task for the accountant. Rules: server/src/orders/stockCount.js.
CREATE TABLE stock_counts (
  id            SERIAL PRIMARY KEY,
  month         DATE NOT NULL,                       -- first day of the month the count belongs to
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  planned_date  DATE NOT NULL,                       -- the working day it is planned for
  counted_qty   INTEGER CHECK (counted_qty >= 0),
  expected_qty  INTEGER,                             -- the Excel stock (products.stock_qty) at the moment it was counted
  counted_at    TIMESTAMPTZ,
  counted_day   DATE,                                -- Yerevan date of counted_at
  counted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note          TEXT,
  reported_at   TIMESTAMPTZ,                         -- the difference went into the day's report / task
  UNIQUE (month, product_id)
);
CREATE INDEX stock_counts_open_idx ON stock_counts (planned_date) WHERE counted_at IS NULL;
CREATE INDEX stock_counts_day_idx ON stock_counts (counted_day);

-- One row per working day once it is closed (by the warehouse manager's "Finish the day" or automatically in the evening).
CREATE TABLE stock_count_days (
  day          DATE PRIMARY KEY,
  planned      INTEGER NOT NULL DEFAULT 0,           -- due that day (its own plan + what was carried over to it)
  counted      INTEGER NOT NULL DEFAULT 0,
  differences  INTEGER NOT NULL DEFAULT 0,
  left_over    INTEGER NOT NULL DEFAULT 0,           -- not counted: moved to the next working day
  finished_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_by  INTEGER REFERENCES users(id) ON DELETE SET NULL, -- NULL = closed automatically in the evening
  task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL
);
