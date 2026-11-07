-- Cashflow categories as a tree (owner, 2026-11-07): IN / OUT / Transfer -> category -> subcategory, managed by the admin.
-- The model follows the direct-method cash flow statement (IAS 7): every group belongs to a section -- operating, investing, financing --
-- plus the owner's own money and moves between our own accounts (internal: never counted as money in or out). The Excel "For" names stay as
-- the subcategories, so the bot's ledger keeps landing where it did; a removed or merged name is remembered as an alias (cash_category_aliases)
-- and the Excel rows that still carry it go to the category it was moved to.
ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS parent_id integer REFERENCES cash_categories(id) ON DELETE RESTRICT;
ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;
ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'both' CHECK (direction IN ('in', 'out', 'both', 'transfer'));
ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS section text NOT NULL DEFAULT 'operating' CHECK (section IN ('operating', 'investing', 'financing', 'owner', 'internal'));
ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS cash_category_aliases (
  name text PRIMARY KEY,               -- lower-case Excel "For" text
  category_id integer NOT NULL REFERENCES cash_categories(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- the groups (skipped when a category of that name already exists)
INSERT INTO cash_categories (name, kind, sort_order, is_group, direction, section)
SELECT v.name, v.kind, v.sort_order, true, v.direction, v.section
FROM (VALUES
  ('Customer payments', 'income', 1, 'in', 'operating'),
  ('Other income', 'income', 2, 'in', 'operating'),
  ('Goods & import', 'expense', 10, 'out', 'operating'),
  ('Taxes', 'expense', 11, 'out', 'operating'),
  ('Payroll', 'expense', 12, 'out', 'operating'),
  ('Running costs', 'expense', 13, 'out', 'operating'),
  ('Equipment', 'expense', 20, 'out', 'investing'),
  ('Loans & interest', 'expense', 30, 'both', 'financing'),
  ('Owner', 'owner', 40, 'both', 'owner'),
  ('Transfers between accounts', 'internal', 50, 'transfer', 'internal')
) AS v(name, kind, sort_order, direction, section)
WHERE NOT EXISTS (SELECT 1 FROM cash_categories c WHERE lower(c.name) = lower(v.name));

-- the Excel names under their group (only those not placed yet)
UPDATE cash_categories c SET parent_id = g.id, direction = g.direction, section = g.section
FROM (VALUES
  ('oil order', 'Customer payments'),
  ('purchase', 'Goods & import'), ('customs', 'Goods & import'), ('transportation', 'Goods & import'),
  ('tax', 'Taxes'),
  ('salary', 'Payroll'),
  ('office', 'Running costs'), ('fuel', 'Running costs'), ('maintenance', 'Running costs'), ('marketing', 'Running costs'), ('other', 'Running costs'),
  ('ppe', 'Equipment'),
  ('loan', 'Loans & interest'), ('interest', 'Loans & interest'),
  ('divident', 'Owner'), ('personal', 'Owner'), ('armen loans', 'Owner'), ('investment', 'Owner'),
  ('to bank', 'Transfers between accounts'), ('exchange', 'Transfers between accounts'), ('transfer', 'Transfers between accounts'),
  ('balance', 'Transfers between accounts'), ('credit line', 'Transfers between accounts'), ('poxarutyun', 'Transfers between accounts'),
  ('veradarcvox', 'Transfers between accounts')
) AS m(leaf, grp)
JOIN cash_categories g ON lower(g.name) = lower(m.grp) AND g.is_group
WHERE lower(c.name) = m.leaf AND c.parent_id IS NULL AND NOT c.is_group;
