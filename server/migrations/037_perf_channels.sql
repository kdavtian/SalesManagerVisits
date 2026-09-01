-- Team Performance: formal sales-channel entity. Until now "channel" only
-- ever existed as a free-text string -- a Sales Manager's `position` field,
-- or the fixed "Sales Director" label -- matched against the Castrol
-- workbook's own free-text Sales Rep names (see sales_performance.rep_name
-- and erp_order_lines' Sales_Rep column upstream in the Python pipeline).
-- `code` is deliberately set to those exact existing strings so every
-- already-synced row keeps matching without a data migration; new channels
-- can be added later purely through this table, no code change required.
CREATE TABLE sales_channels (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  manager_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- CAS and KF are planned/owned by the Accountant, not the Sales Director
  -- (see roles below) -- everything else defaults to the Sales Director.
  owner_role TEXT NOT NULL DEFAULT 'sales_director' CHECK (owner_role IN ('sales_director', 'accountant')),
  parent_channel_id INTEGER REFERENCES sales_channels(id) ON DELETE SET NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  effective_from DATE,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO sales_channels (code, name, owner_role, display_order) VALUES
  ('OEM', 'OEM', 'sales_director', 10),
  ('PCO', 'PCO', 'sales_director', 20),
  ('CVO', 'CVO', 'sales_director', 30),
  ('SM YVN', 'SM YVN', 'sales_director', 40),
  ('SM Shirak', 'SM Shirak', 'sales_director', 50),
  ('SM Davtashen', 'SM Davtashen', 'sales_director', 60),
  ('SM CAS', 'SM CAS', 'sales_director', 70),
  ('KF', 'KF', 'accountant', 80),
  ('CAS', 'CAS', 'accountant', 90);

-- Immutable "when did we first ever see this ERP customer" marker, kept
-- separate from erp_customer_data (which is TRUNCATE-and-replaced whole on
-- every sync -- see erpSync.js) so this survives every future sync
-- untouched. A row is written once, the first time an erp_customer_id
-- appears in any sync payload, and never updated again -- see the ON
-- CONFLICT DO NOTHING in erpSync.js. This is the actual "new customer"
-- signal per the confirmed business definition: a customer not yet listed
-- in the Castrol Customers sheet, i.e. its first-ever appearance there.
CREATE TABLE erp_customer_first_seen (
  erp_customer_id TEXT PRIMARY KEY,
  first_seen_month DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_erp_customer_first_seen_month ON erp_customer_first_seen (first_seen_month);

-- Mon-Sat is a working day everywhere in the company; this table only ever
-- needs to list the exceptions (Armenian public holidays), kept editable by
-- an admin rather than hardcoded so next year's calendar doesn't need a
-- code change.
CREATE TABLE company_holidays (
  holiday_date DATE PRIMARY KEY,
  name TEXT NOT NULL
);
