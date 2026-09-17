-- Bonuses module (Release 1) -- full schema. See
-- docs/bonuses-design.md for the product spec this implements.
-- Purely additive: no existing table's data or behavior changes. The
-- feature is dormant until app_settings.bonuses_enabled is turned on (see
-- below) and, separately, until an admin actually publishes a challenge --
-- creating this schema does not itself change what any existing screen
-- shows or what any existing write path does.
--
-- Naming: every new table is prefixed bonus_ so the whole module's tables
-- sort together and are unambiguous in a `\dt` listing next to the
-- similarly-shaped existing perf_plan_*/product_price_history tables this
-- schema's own versioned/append-only patterns are modeled on.

-- --------------------------------------------------------------------------
-- Feature flag + module-wide settings, on the existing app_settings
-- singleton (same mechanism as calculator_mode_enabled/lockdown_enabled).
-- Disabled by default in every environment, including production, per the
-- brief's rollout section.
-- --------------------------------------------------------------------------
ALTER TABLE app_settings ADD COLUMN bonuses_enabled BOOLEAN NOT NULL DEFAULT false;

-- The customer record that represents "the office" for attendance/cherry
-- purposes. Nullable on purpose -- attendance earning is disabled (see
-- bonusAttendance.js, written in a later phase) whenever this is unset or
-- doesn't resolve to a customer with coordinates, rather than guessing.
-- Confirmed with the business: the real office customer's erp_customer_id
-- is "10000" -- seeded as the starting value, but stored as a normal
-- admin-editable setting (customers.erp_customer_id is free text with no
-- reserved value), never hardcoded into query logic.
ALTER TABLE app_settings ADD COLUMN bonus_office_erp_customer_id TEXT DEFAULT '10000';

-- Attendance qualifies strictly before this local time -- 09:59:59
-- qualifies, 10:00:00 does not (see bonusAttendance.js).
ALTER TABLE app_settings ADD COLUMN bonus_office_cutoff_time TIME NOT NULL DEFAULT '10:00:00';

-- Optional narrowing so an admin can exclude overnight/nonscheduled
-- check-ins from ever qualifying, without this app assuming a fixed
-- Monday-Friday workweek on anyone's behalf. NULL means "no restriction
-- beyond the cutoff" for either.
ALTER TABLE app_settings ADD COLUMN bonus_office_earliest_time TIME;
ALTER TABLE app_settings ADD COLUMN bonus_office_workdays SMALLINT[]; -- ISO 1=Mon..7=Sun

ALTER TABLE app_settings ADD COLUMN bonus_cherry_points INTEGER NOT NULL DEFAULT 3 CHECK (bonus_cherry_points > 0);

-- How fresh a same-employee/same-customer checkin must be to count as GPS
-- evidence for an otherwise-GPS-less payment/collection (see "documented
-- configurable evidence freshness rule" in the brief's Collections
-- section). Default 4 hours: long enough to cover a rep logging the
-- payment shortly after leaving, short enough that an unrelated visit
-- earlier in the day can't validate a materially later collection.
ALTER TABLE app_settings ADD COLUMN bonus_collection_gps_freshness_hours INTEGER NOT NULL DEFAULT 4 CHECK (bonus_collection_gps_freshness_hours > 0);

-- Pre-fills new challenge templates; each template still stores its own
-- value once created; changing this default never edits an existing
-- template (see bonus_challenge_templates.validation_grace_days below).
ALTER TABLE app_settings ADD COLUMN bonus_default_grace_days INTEGER NOT NULL DEFAULT 7 CHECK (bonus_default_grace_days > 0);

-- --------------------------------------------------------------------------
-- Earning rules -- versioned, prospective-only (brief section 3: "Rule
-- changes take effect prospectively at a recorded effective timestamp...
-- never multiply historical quantities by today's rate"). One row per
-- change; the rule in force at any instant is the latest row for that
-- activity with effective_at <= that instant. Modeled directly on
-- product_price_history's append-only shape.
-- --------------------------------------------------------------------------
CREATE TABLE bonus_earning_rule_versions (
  id SERIAL PRIMARY KEY,
  activity TEXT NOT NULL CHECK (activity IN ('strawberry', 'carrot', 'apple', 'cherry')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  points_per_unit INTEGER NOT NULL CHECK (points_per_unit > 0),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);
CREATE INDEX bonus_earning_rule_versions_lookup_idx ON bonus_earning_rule_versions (activity, effective_at DESC);

-- Seed the four always-on activities at their documented default point
-- values (brief section 3's table) so the rule engine always has a current
-- rule to find -- an admin can change these later, but Release 1 never
-- ships with an activity silently unrated.
INSERT INTO bonus_earning_rule_versions (activity, enabled, points_per_unit, note) VALUES
  ('strawberry', true, 1, 'Initial default (docs/bonuses-design.md section 3)'),
  ('carrot', true, 5, 'Initial default (docs/bonuses-design.md section 3)'),
  ('apple', true, 5, 'Initial default (docs/bonuses-design.md section 3)'),
  ('cherry', true, 3, 'Initial default (docs/bonuses-design.md section 3)');

-- --------------------------------------------------------------------------
-- GPS evidence -- one row per location decision, referenced by both a
-- source contribution (a checkin's own GPS) and an attendance record
-- (the office checkin's GPS). Kept as its own table rather than inline
-- columns so the "server decision, never a client boolean" evidence has
-- one consistent shape wherever it's needed, and so access can be
-- restricted the same way as other location data per the brief.
-- --------------------------------------------------------------------------
CREATE TABLE bonus_gps_evidence (
  id SERIAL PRIMARY KEY,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  reference_lat DOUBLE PRECISION,
  reference_lng DOUBLE PRECISION,
  distance_meters DOUBLE PRECISION,
  within_range BOOLEAN NOT NULL,
  rule_note TEXT, -- e.g. "checkin_radius_meters=200" at decision time
  captured_at TIMESTAMPTZ, -- device-reported occurrence time, if known
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Earning units -- the per employee/customer/activity/Armenia-calendar-day
-- grouping the brief mandates for strawberries, carrots, and apples
-- (cherries/attendance are a separate, non-customer-scoped concept, see
-- bonus_attendance_records below). confirmed_scaled is the unit's current
-- maximum eligible contribution (0, 1, or 2 in scale-2 terms -- never a
-- sum of its contributions), enforced by application logic in a later
-- phase; max_scaled is the activity's cap (2 for all three today, kept as
-- a column rather than a hardcoded constant so a future activity with a
-- different cap doesn't need a schema change).
-- --------------------------------------------------------------------------
CREATE TABLE bonus_earning_units (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  activity TEXT NOT NULL CHECK (activity IN ('strawberry', 'carrot', 'apple')),
  local_date DATE NOT NULL,
  confirmed_scaled INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_scaled >= 0),
  max_scaled INTEGER NOT NULL DEFAULT 2 CHECK (max_scaled > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_id, activity, local_date)
);
CREATE INDEX bonus_earning_units_user_date_idx ON bonus_earning_units (user_id, local_date DESC);

-- One source record (a checkin, a payment, an order) contributes to at
-- most one earning unit. UNIQUE(source_table, source_id) is what makes
-- reprocessing an already-linked source idempotent -- an outbox/worker
-- retry hits the unique index instead of creating a duplicate.
CREATE TABLE bonus_source_contributions (
  id SERIAL PRIMARY KEY,
  earning_unit_id INTEGER NOT NULL REFERENCES bonus_earning_units(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL CHECK (source_table IN ('checkin', 'payment', 'order')),
  source_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'reversed')),
  contributes_scaled INTEGER NOT NULL CHECK (contributes_scaled >= 0),
  gps_verified BOOLEAN NOT NULL DEFAULT false,
  gps_evidence_id INTEGER REFERENCES bonus_gps_evidence(id) ON DELETE SET NULL,
  occurrence_at TIMESTAMPTZ NOT NULL, -- the source's own activity date (visit/collection/order-placement time)
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_id)
);
CREATE INDEX bonus_source_contributions_unit_idx ON bonus_source_contributions (earning_unit_id);

-- --------------------------------------------------------------------------
-- Attendance -- deliberately separate from earning_units (no customer, no
-- source-linkage grouping/upgrade complexity, just "earliest qualifying
-- arrival per employee per day"). Every arrival is recorded, qualifying or
-- not; a correction is a new row linked via correction_of_id, never an
-- edit to the original (brief: "a delayed-sync record with a validated
-- earlier occurrence can correct it through an auditable update").
-- --------------------------------------------------------------------------
CREATE TABLE bonus_attendance_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date DATE NOT NULL,
  checkin_id INTEGER REFERENCES checkins(id) ON DELETE SET NULL,
  occurrence_at TIMESTAMPTZ NOT NULL, -- device-reported check-in time
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- server receipt time
  gps_evidence_id INTEGER REFERENCES bonus_gps_evidence(id) ON DELETE SET NULL,
  qualifies BOOLEAN NOT NULL, -- strictly before the configured cutoff, GPS-valid
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'held_for_review', 'superseded')),
  correction_of_id INTEGER REFERENCES bonus_attendance_records(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, -- non-null only for an admin-entered correction
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bonus_attendance_records_user_date_idx ON bonus_attendance_records (user_id, local_date, occurrence_at);

-- --------------------------------------------------------------------------
-- Point ledger -- append-only. Every credit, reversal, and adjustment is a
-- row; nothing here is ever UPDATEd or DELETEd (enforced by the same
-- BEFORE UPDATE-rejecting trigger pattern as order_status_history/
-- payment_status_history, added below). operation_key is the single
-- idempotency guard for the entire module: any process that might retry
-- (an outbox worker, a duplicate webhook, a re-run reconciliation) computes
-- the same deterministic key for the same logical event and the unique
-- index turns a retry into a no-op.
-- --------------------------------------------------------------------------
CREATE TABLE bonus_point_ledger (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity TEXT NOT NULL CHECK (activity IN ('strawberry', 'carrot', 'apple', 'cherry', 'watermelon')),
  collectible_delta_scaled INTEGER NOT NULL,
  points_delta_scaled INTEGER NOT NULL,
  rule_version_id INTEGER REFERENCES bonus_earning_rule_versions(id) ON DELETE SET NULL,
  source_contribution_id INTEGER REFERENCES bonus_source_contributions(id) ON DELETE SET NULL,
  attendance_id INTEGER REFERENCES bonus_attendance_records(id) ON DELETE SET NULL,
  challenge_award_id INTEGER, -- FK added after bonus_challenge_awards exists, below
  reversal_of_id INTEGER REFERENCES bonus_point_ledger(id) ON DELETE SET NULL,
  operation_key TEXT NOT NULL UNIQUE,
  reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A ledger row always originates from exactly one of these three links
  -- (a source activity, an attendance record, or a challenge-completion
  -- award) -- never zero, never more than one.
  CHECK (num_nonnulls(source_contribution_id, attendance_id, challenge_award_id) = 1)
);
CREATE INDEX bonus_point_ledger_user_idx ON bonus_point_ledger (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION bonus_point_ledger_reject_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'bonus_point_ledger is append-only -- insert a reversal row instead of updating id %', OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bonus_point_ledger_immutable
  BEFORE UPDATE ON bonus_point_ledger
  FOR EACH ROW EXECUTE FUNCTION bonus_point_ledger_reject_update();

-- --------------------------------------------------------------------------
-- Challenge templates, targets, and rounds.
-- --------------------------------------------------------------------------
CREATE TABLE bonus_challenge_templates (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('single_metric', 'balanced_basket', 'product_sales')),
  audience_mode TEXT NOT NULL CHECK (audience_mode IN ('individual', 'selected_users', 'selected_roles')),
  audience_user_ids INTEGER[], -- set when audience_mode IN ('individual','selected_users')
  audience_roles TEXT[], -- set when audience_mode = 'selected_roles'
  recurrence TEXT NOT NULL CHECK (recurrence IN ('once', 'daily', 'weekly', 'monthly', 'yearly')),
  custom_start_date DATE, -- only for recurrence = 'once' with an explicit custom range
  custom_end_date DATE,
  reward_amd INTEGER CHECK (reward_amd IS NULL OR reward_amd > 0),
  watermelon_point_value INTEGER CHECK (watermelon_point_value IS NULL OR watermelon_point_value > 0),
  validation_grace_days INTEGER NOT NULL CHECK (validation_grace_days > 0),
  first_round_policy TEXT NOT NULL DEFAULT 'publish_forward' CHECK (first_round_policy IN ('publish_forward', 'scheduled_future', 'historical_explicit')),
  scheduled_start_at TIMESTAMPTZ, -- used when first_round_policy = 'scheduled_future'
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancelled_reason TEXT,
  -- Product-sales challenges must have their watermelon value set before
  -- publishing -- never an invented default (brief section 3).
  CHECK (type <> 'product_sales' OR status = 'draft' OR watermelon_point_value IS NOT NULL),
  CHECK (audience_mode <> 'selected_roles' OR audience_roles IS NOT NULL),
  CHECK (audience_mode = 'selected_roles' OR audience_user_ids IS NOT NULL)
);
CREATE INDEX bonus_challenge_templates_status_idx ON bonus_challenge_templates (status);

-- A single_metric or balanced_basket template's target(s). Balanced basket
-- has >1 row here and ALL must be met (brief: "requires ALL configured
-- components, not an average or sum"). Positive integer targets except
-- carrot/points, which may use 0.5 steps (stored scaled).
CREATE TABLE bonus_challenge_template_targets (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES bonus_challenge_templates(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('strawberry', 'carrot', 'apple', 'cherry', 'points')),
  target_scaled INTEGER NOT NULL CHECK (target_scaled > 0)
);
CREATE INDEX bonus_challenge_template_targets_template_idx ON bonus_challenge_template_targets (template_id);

-- A product_sales template's exact SKU targets (2+ rows for the bundle
-- example, 1 row for a single-product challenge). Snapshotted at creation
-- so a later catalog rename/reprice can never rewrite a published
-- template's rules.
CREATE TABLE bonus_challenge_product_targets (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES bonus_challenge_templates(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name_snapshot TEXT NOT NULL,
  product_unit_snapshot TEXT, -- e.g. "1L" -- the exact packaging variant being counted in pieces
  target_pieces INTEGER NOT NULL CHECK (target_pieces > 0)
);
CREATE INDEX bonus_challenge_product_targets_template_idx ON bonus_challenge_product_targets (template_id);

-- One row per actual occurrence of a template's period. snapshot_rules
-- freezes everything the round's progress/completion math needs (target
-- values, point weights at round-start, audience) so a later template edit
-- or a mid-round earning-rate change never reaches back into an
-- already-published round (brief: "Published rounds are immutable...
-- Total-point challenge progress uses those fixed weights even if the
-- general earning rate changes mid-round"). UNIQUE(template_id, start_at)
-- is the DB-level guarantee against duplicate rounds from a retried or
-- concurrent scheduler.
CREATE TABLE bonus_challenge_rounds (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES bonus_challenge_templates(id) ON DELETE CASCADE,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  validation_deadline_at TIMESTAMPTZ NOT NULL,
  snapshot_rules JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_reason TEXT,
  UNIQUE (template_id, start_at)
);
CREATE INDEX bonus_challenge_rounds_active_idx ON bonus_challenge_rounds (status, end_at);

-- Frozen eligible participants for one round (brief: "Resolve and freeze
-- concrete eligible employee IDs at each round start... Subsequent role
-- changes do not silently change a running round").
CREATE TABLE bonus_round_participants (
  id SERIAL PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES bonus_challenge_rounds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, user_id)
);

-- Rebuildable progress projection -- never the sole financial authority
-- (brief: "Progress projection... never the sole financial authority").
-- Reward approval always recomputes from the ledger/contributions
-- directly (see bonusRewards.js, a later phase); this table exists purely
-- so the UI can show progress cheaply without scanning source tables.
CREATE TABLE bonus_progress (
  id SERIAL PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES bonus_challenge_rounds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  component_progress JSONB NOT NULL DEFAULT '{}', -- {metric: {confirmed_scaled, pending_scaled, target_scaled}}
  overall_status TEXT NOT NULL DEFAULT 'in_progress' CHECK (overall_status IN ('in_progress', 'target_reached', 'not_achieved')),
  reached_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, user_id)
);

-- --------------------------------------------------------------------------
-- Product-sales challenge contributions -- tracked per order line, updated
-- in place on edits (brief: "Edits update its current net contribution
-- with audit history rather than adding another sale"). One row per
-- (round, order_item) so an edited/split/returned line is a single
-- traceable row, not a re-derived aggregate.
-- --------------------------------------------------------------------------
CREATE TABLE bonus_product_challenge_contributions (
  id SERIAL PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES bonus_challenge_rounds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_target_id INTEGER NOT NULL REFERENCES bonus_challenge_product_targets(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  net_pieces INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'qualifying' CHECK (status IN ('qualifying', 'cancelled', 'excluded')),
  occurrence_at TIMESTAMPTZ NOT NULL, -- order placement time
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, order_item_id)
);
CREATE INDEX bonus_product_challenge_contributions_lookup_idx ON bonus_product_challenge_contributions (round_id, user_id, product_target_id);

-- --------------------------------------------------------------------------
-- Challenge-completion awards -- watermelons today, the one Release 1
-- collectible a challenge (rather than everyday activity) can issue.
-- Explicitly NOT a bonus_point_ledger source on its own right -- a ledger
-- row is created separately, linked via challenge_award_id, so watermelon
-- points still flow through the one append-only ledger everything else
-- does.
-- --------------------------------------------------------------------------
CREATE TABLE bonus_challenge_awards (
  id SERIAL PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES bonus_challenge_rounds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collectible TEXT NOT NULL DEFAULT 'watermelon' CHECK (collectible = 'watermelon'),
  points_value INTEGER NOT NULL CHECK (points_value > 0),
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'reversed')),
  operation_key TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at TIMESTAMPTZ,
  reversed_reason TEXT,
  UNIQUE (round_id, user_id)
);

ALTER TABLE bonus_point_ledger
  ADD CONSTRAINT bonus_point_ledger_challenge_award_fkey
  FOREIGN KEY (challenge_award_id) REFERENCES bonus_challenge_awards(id) ON DELETE SET NULL;

-- --------------------------------------------------------------------------
-- Reward claims -- the money side, deliberately separate from bonus_progress
-- (brief: "Keep progress state separate from the claim/payment record").
-- UNIQUE(round_id, user_id) enforces "one claim per round/employee" at the
-- DB level; the version column is an optimistic-lock guard against a race
-- between approval and a concurrent reversal (same pattern as
-- perf_plans.lock_version).
-- --------------------------------------------------------------------------
CREATE TABLE bonus_reward_claims (
  id SERIAL PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES bonus_challenge_rounds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_amd INTEGER NOT NULL CHECK (amount_amd > 0),
  status TEXT NOT NULL DEFAULT 'awaiting_validation' CHECK (status IN ('awaiting_validation', 'approved', 'rejected', 'on_hold', 'paid')),
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  hold_reason TEXT,
  paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ,
  payment_reference TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, user_id)
);
CREATE INDEX bonus_reward_claims_status_idx ON bonus_reward_claims (status);

-- --------------------------------------------------------------------------
-- Badges, levels, personal bests -- gamification-only, no cash effect.
-- --------------------------------------------------------------------------
CREATE TABLE bonus_badge_definitions (
  code TEXT PRIMARY KEY,
  title_key TEXT NOT NULL, -- i18n key
  description_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO bonus_badge_definitions (code, title_key, description_key) VALUES
  ('first_delivered_order', 'bonus_badge_first_delivered_order', 'bonus_badge_first_delivered_order_desc'),
  ('first_accepted_collection', 'bonus_badge_first_accepted_collection', 'bonus_badge_first_accepted_collection_desc'),
  ('first_approved_reward', 'bonus_badge_first_approved_reward', 'bonus_badge_first_approved_reward_desc'),
  ('first_balanced_basket', 'bonus_badge_first_balanced_basket', 'bonus_badge_first_balanced_basket_desc');

CREATE TABLE bonus_badge_awards (
  id SERIAL PRIMARY KEY,
  badge_code TEXT NOT NULL REFERENCES bonus_badge_definitions(code) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_table TEXT,
  source_id INTEGER,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'reversed')),
  operation_key TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at TIMESTAMPTZ
);
CREATE INDEX bonus_badge_awards_user_idx ON bonus_badge_awards (user_id);

-- Versioned level thresholds -- initial 8-level scale from the brief,
-- section 8. min_points_scaled is compared against a user's valid
-- confirmed lifetime points (scale-2), so e.g. level 2's threshold of 100
-- points is stored as 200.
CREATE TABLE bonus_level_thresholds (
  id SERIAL PRIMARY KEY,
  level_number INTEGER NOT NULL CHECK (level_number > 0),
  min_points_scaled INTEGER NOT NULL CHECK (min_points_scaled >= 0),
  label_key TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bonus_level_thresholds_lookup_idx ON bonus_level_thresholds (level_number, effective_at DESC);

INSERT INTO bonus_level_thresholds (level_number, min_points_scaled, label_key) VALUES
  (1, 0, 'bonus_level_1'),
  (2, 200, 'bonus_level_2'),
  (3, 600, 'bonus_level_3'),
  (4, 1500, 'bonus_level_4'),
  (5, 3000, 'bonus_level_5'),
  (6, 6000, 'bonus_level_6'),
  (7, 12000, 'bonus_level_7'),
  (8, 20000, 'bonus_level_8');

-- Highest confirmed full-calendar-week collectible count/points, per the
-- brief's "Exclude incomplete historical coverage" -- rule_version_note
-- records enough about the scoring rules in force at the time that a
-- later UI can annotate "earned under a different point rate" rather than
-- imply a false improvement/decline.
CREATE TABLE bonus_personal_bests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('collectible_count', 'points')),
  best_value_scaled INTEGER NOT NULL,
  achieved_week_start DATE NOT NULL,
  rule_version_note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, metric)
);

-- --------------------------------------------------------------------------
-- Generic append-only audit log for privileged Bonuses corrections
-- (attribution transfers, manual reward holds, adjustment entries) --
-- modeled on perf_plan_audit's before/after JSONB shape.
-- --------------------------------------------------------------------------
CREATE TABLE bonus_audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_table TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  before JSONB,
  after JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bonus_audit_log_entity_idx ON bonus_audit_log (entity_table, entity_id, created_at DESC);
