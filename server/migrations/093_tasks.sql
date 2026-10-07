-- Task management: management gives a task (with a checklist) to a staff
-- member, optionally attached to a customer, with a deadline (the customer's
-- next visit by default). The assignee gets a notification (and again at
-- 09:30 on the deadline day) and ticks the checklist off.
CREATE TABLE tasks (
  id                         SERIAL PRIMARY KEY,
  title                      TEXT NOT NULL,
  creator_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignee_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id                INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  due_date                   DATE NOT NULL,
  due_is_next_visit          BOOLEAN NOT NULL DEFAULT false,
  status                     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  completed_at               TIMESTAMPTZ,
  completed_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completion_note            TEXT,
  deadline_reminder_sent_on  DATE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_assignee_open_idx ON tasks (assignee_id, due_date) WHERE status = 'open';
CREATE INDEX tasks_customer_open_idx ON tasks (customer_id) WHERE status = 'open';
CREATE INDEX tasks_creator_idx ON tasks (creator_id);

CREATE TABLE task_items (
  id          SERIAL PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  done        BOOLEAN NOT NULL DEFAULT false,
  done_at     TIMESTAMPTZ
);
CREATE INDEX task_items_task_idx ON task_items (task_id, sort_order);
