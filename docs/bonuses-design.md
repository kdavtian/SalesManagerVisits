# Bonuses module — design notes

Implementation of the "KAD Field Visits — Bonuses" product brief (17 Sep
2026), a gamified points/collectibles/challenge system replacing the Home
"Monthly leaders" presentation. This doc is the running record of design
decisions made while implementing it — read this before touching any
`bonus_*` table or `src/bonus*.js` file, since several of these decisions
resolve real ambiguity in the original brief against this app's actual
code, not just restate the brief.

**Status**: Phase 2 (schema + pure rule engine) in progress. See the
phase list in [`release-process.md`](release-process.md) conventions —
this module ships as a sequence of separately reviewed PRs, one per phase,
each fully tested before the next starts. Nothing in this module is wired
into any route, the Home screen, or the offline queue yet; the schema is
additive-only and inert until later phases build on it.

## Decisions resolved during Phase 1 discovery

- **"Monthly Leaders" is real, not just a label.** `dashboard.js`'s
  `points_leaderboard` (visit/photo/customer points) plus an admin
  "close out month" flow (`monthly_points_closeouts` table, `POST
  /api/dashboard/points/close-out`) already exist and are live. Per the
  brief's own instruction: only the Home *presentation* is replaced in a
  later phase; `monthly_points_closeouts` and the closeout capability are
  untouched, preserved for historical record-keeping. The two systems
  (old points/closeout, new Bonuses ledger) are intentionally
  independent — no data migration between them.

- **"Collection" = the `payments` table only, not `checkins.amount_collected_amd`.**
  This app has two separate, unreconciled money-collection mechanisms:
  `checkins.amount_collected_amd` (an informal field with no review step —
  money is just recorded, never accepted/rejected) and the `payments`
  table (a real `pending → approved/rejected` workflow, reviewed by an
  accountant). The brief's "collection" activity explicitly requires a
  pending → accepted transition ("Submission produces visible pending
  credit; accountant acceptance makes it confirmed"), which only the
  `payments` table has. `checkins.amount_collected_amd` is **not** a
  bonus-earning source in Release 1 — there's no acceptance step to hang
  "confirmed" credit off of.
  - Consequence: `payments` has no `lat`/`lng` column of its own. GPS
    validity for a collection is therefore always established via the
    "explicitly linked to its same-employee/same-customer contemporaneous
    verified visit" path in the brief, never a native GPS field on the
    payment itself. The freshness window for that linkage is
    `app_settings.bonus_collection_gps_freshness_hours` (default 4 hours)
    — the brief asks for a "documented configurable evidence freshness
    rule"; this is it.

- **GPS validation is already reused, not reinvented.** A checkin's
  `within_range` (computed server-side from `distance_meters` against the
  admin-configurable `checkin_radius_meters`) is already exactly the
  "server-evaluated valid GPS, never a client boolean" the brief asks for.
  There is no existing "accuracy" or "fix age" concept in this app to
  reuse — none was added, since `within_range` already satisfies the
  brief's actual requirement (a real server-computed decision, not an
  invented new radius).

- **Office customer**: confirmed with the business — a real customer
  record exists with `erp_customer_id = '10000'`. Stored as an editable
  setting (`app_settings.bonus_office_erp_customer_id`, seeded to
  `'10000'`), not hardcoded into any query, per the brief's own
  instruction to resolve the code to its actual record rather than assume
  an internal primary key.

- **Role mapping for money-adjacent actions** (confirmed with the user —
  mirrors the existing payment-approval chain exactly, see `roles.js`):
  - Reward **approval** = admin/ceo/accountant (same set as
    `canReviewPayments`).
  - Payout **recording** = admin/accountant (same set as
    `canRecordOrders`).
  - Rule/template management and challenge publish/cancel roles are
    finalized in the Phase 4/5 PRs that actually add the capability
    functions to `roles.js`, following the same one-function-per-
    capability style as every existing entry there.

- **Delivery shape**: phased PRs, one per brief-section-12 phase, each
  fully tested and merged before the next starts — confirmed with the
  user, matches how every other feature in this repo has shipped.

## Schema (migration `076_bonuses_schema.sql`)

20 new `bonus_*` tables plus 8 new columns on the existing `app_settings`
singleton (the feature flag `bonuses_enabled`, default `false`, plus the
office/attendance/collection-freshness/grace-period settings above).
Table-by-table rationale is documented inline in the migration itself;
the shape follows existing conventions directly:

- Versioned rules (`bonus_earning_rule_versions`, `bonus_level_thresholds`)
  follow `product_price_history`'s append-only, never-updated pattern.
- The point ledger (`bonus_point_ledger`) is append-only, enforced by a
  `BEFORE UPDATE`-rejecting trigger, same mechanism as
  `order_status_history`/`payment_status_history` (migration `071`).
- Idempotency is a database-level `UNIQUE` constraint on `operation_key`
  (ledger, badge awards, challenge awards) or on the natural key itself
  (`bonus_source_contributions(source_table, source_id)`,
  `bonus_challenge_rounds(template_id, start_at)` — the last one is what
  makes "only one round per challenge/boundary pair, even under retries or
  concurrent schedulers" a real guarantee, not just application discipline).
- Collectible/point quantities that can take a 0.5 step (carrots, activity
  points) are stored as plain integers at 2x their real value ("scale-2"),
  converted only through `src/bonusUnits.js`'s `toScaled`/`fromScaled` —
  see that file's own header for why.

## Pure rule engine (this phase)

- `src/utils/yerevanDate.js` — extended with `yerevanDayBounds`,
  `yerevanWeekBounds` (Monday-start), `yerevanMonthBounds`,
  `yerevanYearBounds`, `yerevanCustomRangeBounds` (both dates inclusive),
  `yerevanDateOf`. All return `{startAt, endAt}` as real UTC `Date`
  instants (inclusive start, exclusive end) for exactly the boundary
  math a challenge round's stored `TIMESTAMPTZ` columns need.
- `src/bonusUnits.js` — the scale-2 conversion helpers.
- `src/bonusRules.js` — `getEarningRuleAt(activity, at)`,
  `getCurrentEarningRules(at)`, `setEarningRule(...)`: the versioned,
  prospective-only lookup against `bonus_earning_rule_versions`.

## Not yet built

Everything else in the brief — source integration (visits/collections/
orders/attendance → the ledger), the challenge engine, reward accounting,
employee/admin UI, gamification polish (levels/badges/milestones/personal
bests), and end-to-end validation — is Phases 3 through 8, each its own
PR. See the brief itself for the full acceptance-test matrix each later
phase is validated against.
