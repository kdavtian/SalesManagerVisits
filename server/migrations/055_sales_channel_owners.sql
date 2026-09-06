-- Consolidation pass: sales_channels.manager_user_id is the single
-- canonical channel -> manager mapping. It has never been populated (see
-- migration 037) and two other, divergent mechanisms have been standing in
-- for it since: salesChannelAutofill.js's free-text parsing of a sales
-- manager's `position`, and route_distribution.assigned_manager_id (a
-- second, region-keyed place an admin could set a manager for a channel).
-- Both are being changed to read this table first; this migration adds the
-- one channel missing from the original seed and fills in what can be
-- resolved unambiguously from existing users.

-- SM B2B is part of the requested channel->manager mapping but was never
-- seeded into sales_channels (only SM YVN, SM Shirak, SM Davtashen, SM CAS
-- exist among the "SM *" rows). Ordered between SM YVN (40) and SM Shirak
-- (50).
INSERT INTO sales_channels (code, name, owner_role, display_order)
VALUES ('SM B2B', 'SM B2B', 'sales_director', 45)
ON CONFLICT (code) DO NOTHING;

-- CVO/PCO/OEM -> "Sales Director": when exactly one sales_director user
-- exists, that's an unambiguous match.
UPDATE sales_channels
   SET manager_user_id = sd.id
  FROM (SELECT id FROM users WHERE role = 'sales_director') sd
 WHERE sales_channels.code IN ('CVO', 'PCO', 'OEM')
   AND (SELECT COUNT(*) FROM users WHERE role = 'sales_director') = 1;

-- SM YVN -> Marat, SM Davtashen -> Artak, SM Shirak -> Robert, SM B2B ->
-- Artak: left NULL here. No users matching these names exist in this
-- environment's data (checked case-insensitively against
-- users.role = 'sales_manager' and more broadly) -- see final report. An
-- admin can complete these via the new Sales Channel Owners screen once the
-- real accounts are identified.
-- KF -> KF, CAS -> CAS: no separate named manager; owner_role='accountant'
-- (set in migration 037) already reflects that these are Accountant-owned,
-- not Sales-Director-owned, channels. manager_user_id intentionally stays
-- NULL for both.
