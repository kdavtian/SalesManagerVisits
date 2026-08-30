-- Recurring route-plan rules originally only supported area-based customer
-- selection (region/subregion). The dedicated Route Plans page instead
-- lets a director/ceo/admin pick straight from the customers already
-- assigned to a sales manager (assigned_manager_id), which didn't exist
-- when visit_plan_rules was first built. Explicit customer_ids sit
-- alongside the existing areas column rather than replacing it -- a rule
-- can carry either or both, and both are unioned together at read time.
ALTER TABLE visit_plan_rules ADD COLUMN customer_ids INTEGER[] NOT NULL DEFAULT '{}';
