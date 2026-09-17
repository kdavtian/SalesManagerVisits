-- Phase 3 (source integration) needs bonusSourceIngest.js's office-
-- attendance ingestion to be safely re-runnable against the same checkin --
-- a retried request, a reconciliation re-sweep, or a duplicate webhook
-- must all land on the same attendance row rather than creating a sibling.
-- bonus_point_ledger's operation_key already caps cherries at one per
-- employee per day (see bonusSourceIngest.js), but without this index nothing
-- stops bonus_attendance_records itself from accumulating duplicate
-- "recorded, non-qualifying" rows for the same checkin on a retry -- a
-- correctness issue (an inflated attendance history) even though it can never
-- double-award. NULL stays unrestricted: an admin-entered correction (a
-- later phase) has no checkin_id at all.
CREATE UNIQUE INDEX bonus_attendance_records_checkin_id_idx
  ON bonus_attendance_records (checkin_id)
  WHERE checkin_id IS NOT NULL;
