-- Fixes a real bug in 076_bonuses_schema.sql: bonus_point_ledger's three
-- provenance FKs (source_contribution_id, attendance_id, challenge_award_id)
-- were ON DELETE SET NULL, but the table's own
-- CHECK (num_nonnulls(source_contribution_id, attendance_id, challenge_award_id) = 1)
-- requires exactly one of them to be non-null. A cascaded delete that
-- reaches a bonus_source_contributions or bonus_attendance_records row with
-- ledger history (e.g. deleting a user -- bonus_earning_units.user_id and
-- bonus_attendance_records.user_id both CASCADE) would try to SET NULL that
-- ledger row's link and immediately violate the CHECK, turning an ordinary
-- "delete this user" into a hard failure. Switched to RESTRICT instead --
-- the same choice the existing schema already makes everywhere else a
-- financial record must never silently lose its reasoning (e.g.
-- payments.sales_manager_id REFERENCES users(id) ON DELETE RESTRICT): you
-- cannot delete a user/customer/round/etc. that a ledger row still points
-- to, full stop, rather than corrupting the row that explains where its
-- points came from.
ALTER TABLE bonus_point_ledger DROP CONSTRAINT bonus_point_ledger_source_contribution_id_fkey;
ALTER TABLE bonus_point_ledger
  ADD CONSTRAINT bonus_point_ledger_source_contribution_id_fkey
  FOREIGN KEY (source_contribution_id) REFERENCES bonus_source_contributions(id) ON DELETE RESTRICT;

ALTER TABLE bonus_point_ledger DROP CONSTRAINT bonus_point_ledger_attendance_id_fkey;
ALTER TABLE bonus_point_ledger
  ADD CONSTRAINT bonus_point_ledger_attendance_id_fkey
  FOREIGN KEY (attendance_id) REFERENCES bonus_attendance_records(id) ON DELETE RESTRICT;

ALTER TABLE bonus_point_ledger DROP CONSTRAINT bonus_point_ledger_challenge_award_fkey;
ALTER TABLE bonus_point_ledger
  ADD CONSTRAINT bonus_point_ledger_challenge_award_fkey
  FOREIGN KEY (challenge_award_id) REFERENCES bonus_challenge_awards(id) ON DELETE RESTRICT;
