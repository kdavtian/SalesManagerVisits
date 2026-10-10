-- Debt-collection tasks record how the visit went (paid / partial / promised on a
-- date / no answer / refused); a promised date drives the follow-up. A second kind of
-- automatic task reminds the rep to reach out to a customer who stopped ordering.
ALTER TABLE tasks
  ADD COLUMN outcome TEXT CHECK (outcome IN ('paid', 'partial', 'promised', 'no_answer', 'refused')),
  ADD COLUMN promise_date DATE;
ALTER TABLE tasks DROP CONSTRAINT tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN ('debt_collection', 'reorder_followup'));
