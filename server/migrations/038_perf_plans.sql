-- Team Performance monthly plan. One row per (month, version) -- an
-- approved plan is never edited in place; a CEO revision inserts a new row
-- with version = previous + 1 and supersedes_plan_id pointing back, so
-- every past version stays queryable exactly as it was approved. `month`
-- is the first-of-month date, matching the existing sales_performance
-- convention.
CREATE TABLE perf_plans (
  id SERIAL PRIMARY KEY,
  month DATE NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'closed', 'superseded')),
  supersedes_plan_id INTEGER REFERENCES perf_plans(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  revision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Optimistic-locking token: bumped on every save so two people editing
  -- the same draft at once get a conflict instead of one silently
  -- clobbering the other's changes (see PATCH /:id in teamPerformance.js).
  lock_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (month, version)
);
CREATE INDEX idx_perf_plans_month_status ON perf_plans (month, status);

-- Only one non-superseded plan should ever be "the" plan for a given month
-- at draft/pending/approved/rejected status -- superseded/closed rows are
-- exempt so history can pile up freely.
CREATE UNIQUE INDEX idx_perf_plans_one_live_per_month ON perf_plans (month)
  WHERE status IN ('draft', 'pending_approval', 'approved', 'rejected');

CREATE TABLE perf_plan_targets (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES perf_plans(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES sales_channels(id),
  sales_target_amd NUMERIC NOT NULL DEFAULT 0,
  collection_target_amd NUMERIC NOT NULL DEFAULT 0,
  new_customers_target INTEGER NOT NULL DEFAULT 0,
  UNIQUE (plan_id, channel_id)
);

-- Kept as its own table (rather than columns on perf_plan_targets) so a
-- new brand never needs a migration -- see the KPI extensibility
-- requirement. Initial brands are Castrol/Lotos/Royal, but `brand` is
-- plain text, not a lookup table, matching how brand already works
-- everywhere else in this app (products.brand, erp_order_lines.brand).
CREATE TABLE perf_plan_brand_targets (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES perf_plans(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES sales_channels(id),
  brand TEXT NOT NULL,
  target_liters NUMERIC NOT NULL DEFAULT 0,
  UNIQUE (plan_id, channel_id, brand)
);

-- Full audit trail -- every state transition and every field-level change,
-- not just approvals. before/after are JSONB snapshots of whatever changed
-- (a single target row, the plan header, etc.), not the whole plan, so this
-- stays cheap to write on every autosave.
CREATE TABLE perf_plan_audit (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES perf_plans(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_perf_plan_audit_plan ON perf_plan_audit (plan_id, created_at);

CREATE TABLE perf_plan_comments (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES perf_plans(id) ON DELETE CASCADE,
  channel_id INTEGER REFERENCES sales_channels(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_perf_plan_comments_plan ON perf_plan_comments (plan_id, created_at);
