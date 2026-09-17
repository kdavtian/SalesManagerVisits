# Bonuses module — design notes

Implementation of the "KAD Field Visits — Bonuses" product brief (17 Sep
2026), a gamified points/collectibles/challenge system replacing the Home
"Monthly leaders" presentation. This doc is the running record of design
decisions made while implementing it — read this before touching any
`bonus_*` table or `src/bonus*.js` file, since several of these decisions
resolve real ambiguity in the original brief against this app's actual
code, not just restate the brief.

**Status**: Phase 4 (challenge engine and administration) in progress;
Phases 2-3 (schema, pure rule engine, source integration and ledger)
shipped separately. See the phase list in
[`release-process.md`](release-process.md) conventions — this module ships
as a sequence of separately reviewed PRs, one per phase, each fully tested
before the next starts. Still no employee-facing UI and no Home
integration (Phase 6) — the only things wired into the running app are two
in-process workers (`src/bonusReconciliation.js`, `src/bonusChallengeWorker.js`)
plus one admin-only screen (Settings → Admin Workspace → Bonuses, gated to
`canManageBonusChallenges`), all inert while `app_settings.bonuses_enabled`
is `false` (the default in every environment, including production).

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

## Decisions and a schema fix made during Phase 3

- **Ledger/earning-unit storage is uniformly scale-2, even for whole-only
  collectibles.** `bonusUnits.js`'s header says strawberry/apple/cherry
  "never need" `toScaled`/`fromScaled` since they never take a 0.5 step —
  true for *inputs*, but `bonus_point_ledger.collectible_delta_scaled` and
  `bonus_earning_units.confirmed_scaled`/`max_scaled` are one shared column
  per activity, and `bonus_earning_units`' own migration comment already
  puts strawberry/apple through the same scale-2, `max_scaled = 2`
  representation as carrot. Resolution: every activity's ledger/unit
  columns are always `real_value * 2`, whole-only activities simply never
  produce an odd value. `points_delta_scaled = collectible_delta_scaled *
  rule.points_per_unit` holds uniformly as a result — see
  `bonusSourceIngest.js`'s own header comment.

- **Collection GPS linkage direction: checkin at-or-before the payment,
  nearest first.** The freshness window (`bonus_collection_gps_freshness_hours`,
  default 4h) looks for a checkin by the same rep at the same customer
  *ending* at the payment's own timestamp, never a checkin recorded after
  the payment was logged — matches the real workflow ("visit, collect, log
  the payment shortly after"), not the reverse.

- **Full vs. half collection credit**: GPS-linked evidence with
  `within_range = true` earns a full carrot (scaled `2`); no linkage, or a
  linked checkin outside GPS range, earns half a carrot (scaled `1`) —
  never zero. This is the brief's "GPS-dependent full/half collection
  credit" made concrete.

- **Apples (delivered orders) are not GPS-gated.** "Delivered" is an
  objective warehouse/ERP event (`order_status_history`'s first transition
  to `'delivered'`); unlike visits, collections, and attendance, the brief
  never asks for a location claim on it. If the order carries a linked
  checkin (`orders.checkin_id`), that checkin's evidence is recorded for
  information only and never gates the award.

- **Cherries cap at one per employee per day via a deterministic
  `operation_key`** (`attendance:cherry:{userId}:{localDate}`), not by
  pre-querying for an earlier qualifying record — so two concurrent
  qualifying arrivals the same day are still guaranteed to post exactly one
  ledger row (the second `postLedgerEntry` call returns the *existing* row
  on the unique-constraint conflict, never `null` — a caller checks the
  returned row's `id` against what it already knows, not truthiness, to
  tell "new" from "already earned today" apart).

- **Real schema bug found and fixed**: migration `076`'s
  `bonus_point_ledger.source_contribution_id`/`attendance_id`/
  `challenge_award_id` were `ON DELETE SET NULL`, but the table's own
  `CHECK (num_nonnulls(...) = 1)` requires exactly one of them non-null at
  all times. A cascaded delete that reaches a referenced
  `bonus_source_contributions`/`bonus_attendance_records` row while a
  ledger row still points at it (e.g. deleting a *customer* — as opposed to
  the user — cascades `bonus_earning_units.customer_id`, which cascades the
  contribution, while the ledger row's own `user_id` FK is untouched) would
  try to null that ledger row's link and immediately violate the CHECK,
  turning an ordinary delete into a hard failure. Fixed in migration `078`
  by switching all three to `ON DELETE RESTRICT` — the same choice the rest
  of this codebase already makes wherever a financial record must never
  silently lose its reasoning (e.g. `payments.sales_manager_id`). Verified
  by hand: deleting a customer with real ledger history now fails with a
  clear FK error instead of corrupting a ledger row.

- **GPS evidence is decision-scoped, not source-scoped.** Every ingestion
  call that has a location decision to make (a checkin's own GPS, or a
  payment's linked checkin) inserts its own `bonus_gps_evidence` row rather
  than reusing one across calls — evidence rows are cheap, append-only, and
  this keeps "why did/didn't this specific decision qualify" always
  answerable per source row without a shared-row ownership question.

## Source integration (Phase 3, this phase)

- `src/bonusSettings.js` — getters/setters for the 8 `bonus_*`
  `app_settings` columns, following `settings.js`'s no-caching,
  `UPSERT`-on-write shape exactly.
- `src/bonusGpsEvidence.js` — records a `bonus_gps_evidence` row from a
  checkin's own GPS decision, and finds the nearest same-employee/
  same-customer checkin within the collection freshness window.
- `src/bonusEarningUnits.js` — get-or-create and lock (`SELECT ... FOR
  UPDATE`) a `bonus_earning_units` row, so two concurrent contributions to
  the same employee/customer/activity/day can never both credit a full
  unit.
- `src/bonusIdempotency.js` — a shared `SAVEPOINT`-wrapped idempotent-insert
  helper. A bare `INSERT` that hits a `UNIQUE` constraint aborts the whole
  enclosing transaction in Postgres; every idempotent insert in this module
  (`bonus_source_contributions`, `bonus_point_ledger`,
  `bonus_attendance_records`) goes through this helper instead of catching
  the error directly.
- `src/bonusLedger.js` — `postLedgerEntry` (idempotent by `operation_key`)
  and `reverseLedgerEntry` (posts the exact negation, linked via
  `reversal_of_id`, itself idempotent).
- `src/bonusSourceIngest.js` — the four ingest functions
  (`ingestVisitContribution`, `ingestCollectionContribution`,
  `ingestOrderDelivery`, `ingestOfficeAttendance`) plus
  `reverseSourceContribution` (reverses the ledger entry *and* gives back
  the earning-unit capacity it consumed). Every function is safe to call
  more than once for the same source row.
- `src/bonusReconciliation.js` — an hourly in-process sweep (same
  `setInterval` pattern as `dailySummary.js`/`erpSyncMonitor.js`), scoped to
  "rows in a 48h lookback window with no recorded decision yet" per source
  table, so a steady-state sweep only touches genuinely new activity. This
  is the only thing wired into `index.js` this phase — no HTTP route hooks
  yet, so it is also, for now, the *only* path anything reaches the ledger
  through. Every ingest function's idempotency is what makes it safe to add
  direct route-level hooks in a later phase without risking a double
  award: a route hook and this sweep processing the same row is a no-op,
  not a duplicate.

## Decisions made during Phase 4

- **Progress is computed by summing `bonus_point_ledger` within the round's
  window, never re-deriving rates.** A round's `snapshot_rules` freezes
  *targets* (and, for product-sales, the exact SKU list) at round-creation
  time, per the brief's "Published rounds are immutable." It does **not**
  separately freeze the general earning rate: each ledger row already
  carries the rate that was in force when it was posted
  (`rule_version_id`), so summing `collectible_delta_scaled`/
  `points_delta_scaled` over the round's `[start_at, end_at)` window is
  already immutable per-entry — a mid-round rate change can never reach
  back into an already-posted contribution. Simpler than re-snapshotting
  rates, and correct for the same reason `bonusSourceIngest.js`'s ledger
  entries are correct.

- **A round stays `active` (never `ended`) through its grace period.**
  `end_at` is when new activity stops counting toward it; a participant
  still shows `in_progress` (recomputed every worker tick) until
  `validation_deadline_at` — late-syncing evidence (an offline check-in, a
  payment approved the next morning) can still land and be counted right up
  to the deadline. Only past `validation_deadline_at` does the worker lock
  in `not_achieved` for anyone who never reached target and flip the round
  to `ended`, per the brief's grace-period requirement.

- **Product-sales contributions are resynced from `order_items` every
  worker tick, not tracked event-driven off order creation.** The brief
  requires an edited/split order line's "current net contribution" to
  always reflect its latest state, with audit history rather than a new
  row per edit. Recomputing `net_pieces` from whatever `order_items` says
  *right now* on every tick (upserted by the table's own
  `UNIQUE(round_id, order_item_id)`) gets this for free — no separate
  edit-tracking logic, and it self-heals if a tick was ever missed.

- **Cherries/attendance never feed challenge progress via `bonus_earning_units`.**
  A `points`-metric target sums `bonus_point_ledger.points_delta_scaled`
  directly (any activity, including cherry/watermelon), so a challenge
  built around total points still counts everything — it's only a
  single-activity metric target (e.g. `strawberry`) that's scoped to one
  `activity` column value.

- **`canManageBonusChallenges` is admin/ceo, not `canReviewPayments`'s
  admin/ceo/accountant.** Template design (targets, audience, reward
  amounts) is a management call per the brief, distinct from
  `canApproveBonusRewards`/`canRecordBonusPayouts` (added now, mirroring
  `canReviewPayments`/`canRecordOrders` exactly as confirmed with the user
  in Phase 1 — not yet wired to any route; that's Phase 5's reward-claim
  approval flow).

- **Admin UI scope for this phase: a single-form create dialog, not the
  multi-step wizard pattern** used elsewhere (`routePlans.js`'s
  `openNewRoutePlanFlow`) — a deliberate simplification to keep Phase 4
  bounded. The form also only supports `single_metric`/`balanced_basket`
  templates; `product_sales` (which needs a product-target picker this pass
  doesn't have) is reachable via the API but not yet from the UI. Both are
  fine to revisit in a later polish pass without changing the API shape.

## Not yet built

Everything else in the brief — reward accounting/approval (`bonus_reward_claims`,
Phase 5), employee UI and Home integration (Phase 6), gamification polish
(levels/badges/milestones/personal bests, Phase 7), and end-to-end
validation (Phase 8) — each its own PR. The Phase 4 admin UI itself is also
incomplete per the scope note above (no wizard, no product-sales form).
See the brief itself for the full acceptance-test matrix each later phase
is validated against.
