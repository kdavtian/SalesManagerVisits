-- Task types a sales director picks when giving a task (owner, 2026-10-16): collect the debt, make an order, check the
-- products at the shop. Separate from auto_kind (the tasks Vaghinak creates on his own): a typed task is a person's task,
-- but it closes itself like the automatic ones -- a payment closes "collect_debt", an order closes "make_order", a check-in
-- that records the shop's brands closes "check_products" (taskAutoComplete.js). NULL = a plain task.
ALTER TABLE tasks ADD COLUMN task_kind TEXT CHECK (task_kind IN ('collect_debt', 'make_order', 'check_products'));
CREATE INDEX tasks_kind_open_idx ON tasks (customer_id, task_kind) WHERE status = 'open' AND task_kind IS NOT NULL;
