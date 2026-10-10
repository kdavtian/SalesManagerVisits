-- Tasks created by the system (not by a person). `debt_collection`: when a
-- sales rep's customer is overdue with debt after an ERP sync, the rep gets a
-- "Հավաքագրիր պարտքը" task for the next visit (see debtCollectionTasks.js).
ALTER TABLE tasks ADD COLUMN auto_kind TEXT CHECK (auto_kind IN ('debt_collection'));
-- At most one OPEN automatic task of a kind per customer, even if two syncs race.
CREATE UNIQUE INDEX tasks_auto_open_customer_idx ON tasks (customer_id, auto_kind)
  WHERE auto_kind IS NOT NULL AND status = 'open' AND customer_id IS NOT NULL;
