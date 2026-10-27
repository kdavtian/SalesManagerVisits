-- Financial director (owner, 2026-10-27: "Lilit - new role, with the same permissions as the accountant"). The account's role stays
-- 'accountant', so every permission, notification and report follows the accountant's exactly; role_title is the name shown for it
-- (Team list, profile, role pickers). A future split of the two only needs its own role value then.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_title TEXT CHECK (role_title IN ('financial_director'));
