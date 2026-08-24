-- Monthly Sales/Collected/Budget series per rep, parsed from the Castrol
-- workbook's Sales Team_2026 sheet -- powers each Sales Manager/Director's
-- "my performance" view. Rep is matched by name against a Sales Manager's
-- `position` field or the fixed "Sales Director" label, not a foreign key,
-- since the sheet's rep names are free text set by the CEO's workbook, not
-- Field Visits accounts.
CREATE TABLE sales_performance (
  id SERIAL PRIMARY KEY,
  rep_name TEXT NOT NULL,
  month DATE NOT NULL,
  sales_amd NUMERIC NOT NULL DEFAULT 0,
  collected_amd NUMERIC NOT NULL DEFAULT 0,
  budget_amd NUMERIC NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rep_name, month)
);
