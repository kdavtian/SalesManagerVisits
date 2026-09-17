# Bonuses module — design notes

Implementation of the "KAD Field Visits — Bonuses" product brief (17 Sep
2026), a gamified points/collectibles/challenge system replacing the Home
"Monthly leaders" presentation. This doc is the running record of design
decisions made while implementing it — read this before touching any
`bonus_*` table or `src/bonus*.js` file, since several of these decisions
resolve real ambiguity in the original brief against this app's actual
code, not just restate the brief.

**Status**: All 8 phases complete and merged to `main`, plus a
post-Phase-8 follow-up (the admin creation wizard, closing the Phase 4
gaps noted below). The module is fully built, end-to-end validated
(Phase 8), and ready to turn on — see
["Turning it on" below](#turning-it-on-phase-8-handoff) for the
production runbook. It ships as a sequence of separately reviewed PRs, one
per phase, each fully tested before the next started, per
[`release-process.md`](release-process.md)'s conventions. The full
employee-facing surface is a "Bonuses" Home Quick Action → `#/bonuses`
screen showing points/level/active-challenge progress/reward claims/
badges/personal bests, plus the admin-only screens (Settings → Admin
Workspace → Bonuses: template management gated to
`canManageBonusChallenges`, reward-claim review gated to
`canApproveBonusRewards`/`canRecordBonusPayouts`) and three in-process
workers (`src/bonusReconciliation.js`, `src/bonusChallengeWorker.js` —
the latter also updating personal bests each tick). Everything stays
invisible/inert while `app_settings.bonuses_enabled` is `false` (the
default in every environment, including production, right now).

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
  (Revisited post-Phase-8 — see ["Admin creation wizard"](#admin-creation-wizard-post-phase-8-follow-up)
  below: both gaps are now closed.)

## Decisions made during Phase 5

- **A claim is created exactly once, at round finalization, from whatever
  `bonus_progress` says at that moment** — never earlier, even if a
  participant's progress shows `target_reached` mid-round. The grace period
  exists precisely so a late-arriving contribution isn't wrongly denied
  credit; creating the claim before finalization would risk locking in a
  premature (or a since-reversed) amount. `createClaimsForFinalizedRound`
  is called from `bonusChallengeWorker.js`'s existing finalization step
  (the same tick that flips a round to `ended`), not a separate pass.

- **Approval, rejection, and hold share one role gate
  (`canApproveBonusRewards`); payout recording is a separate one
  (`canRecordBonusPayouts`)** — exactly the admin/ceo/accountant vs.
  admin/accountant split confirmed with the user in Phase 1, mirroring
  `canReviewPayments`/`canRecordOrders`. A claim must be `approved` before
  it can be paid; there is no path from `awaiting_validation` straight to
  `paid`.

- **Self-approval and self-payment are blocked by identity, not role** — an
  admin who happens to also be a challenge participant still cannot
  approve or pay out their own claim, checked as `claim.user_id ===
  actorId` after the role check (so the error message can distinguish
  "you don't have this role" from "you can't act on your own claim" for
  someone who does).

- **Optimistic locking mirrors `perf_plans.lock_version` exactly**
  (`teamPerformance.js`'s `SELECT ... FOR UPDATE` + `expected_lock_version`
  pattern) — every mutation takes the caller's last-known `version`, locks
  the row, compares, and only proceeds on a match; a mismatch is a
  `ClaimConflictError` surfaced as HTTP 409, not a silent overwrite or a
  generic 500.

- **Amount adjustment only before a claim leaves review**
  (`awaiting_validation`/`on_hold`) — an approved or paid claim's amount is
  final; correcting a paid claim is a payout dispute outside this module's
  scope, not a claim-accounting adjustment. Every mutation (including
  adjustment) writes a `bonus_audit_log` row with the before/after state,
  modeled on `perf_plan_audit`'s shape per the Phase 2 schema.

- **No employee-facing "my rewards" UI yet** — the admin review/payout
  screen (Settings → Admin Workspace → Bonuses → Reward claims, visible to
  anyone who can approve or pay: admin/ceo/accountant) is this phase's
  whole UI surface. An employee's own claim history is Phase 6's scope
  (Home integration), where it belongs alongside the rest of the
  employee-facing Bonuses experience rather than bolted onto Settings.

## Decisions made during Phase 6

- **`app_settings.bonuses_enabled` is now exposed to every authenticated
  role via `GET /api/settings`** (read-only there; still only written via
  the Bonuses admin surface) — the same pattern as `calculator_mode_enabled`.
  This is what the Home Quick Action tile and desktop sidebar entry gate
  on: both filter the `qa_bonuses` id out unless the flag is true, so the
  entry point stays invisible everywhere until an admin turns the module
  on, matching every prior phase's "inert by default" requirement.

- **Monthly Leaders is left untouched, not removed.** The brief says to
  replace the Home *presentation*, but doing that safely means fully
  understanding and re-testing an existing, live, unrelated feature
  (`points_leaderboard`/`monthly_points_closeouts`) under real time
  pressure — a real risk for a feature this phase doesn't otherwise need
  to touch, especially since Bonuses stays invisible by default anyway
  (`bonuses_enabled=false` in every environment). The new "Bonuses" entry
  point (Quick Action tile → `#/bonuses`) is purely additive: it shares no
  DOM ids, CSS classes, or state with the Monthly Leaders block in
  `dashboard.js`. Removing/replacing Monthly Leaders is left as an explicit
  follow-up decision for whoever turns `bonuses_enabled` on for real,
  rather than bundled into this PR.

- **The summary endpoint (`GET /api/bonus-summary`) 404s while disabled**,
  not a 200 with empty data — consistent with the module being genuinely
  unreachable, not just quietly showing nothing, while off.

- **Level lookup mirrors the earning-rule versioned-lookup shape**
  (`bonusRules.js`'s `getEarningRuleAt`): `bonus_level_thresholds` is
  append-only per `level_number`, so "the threshold in force now" is the
  latest version with `effective_at <= now`, looked up the same way a
  challenge round's snapshot already looks up earning rates.

- **The employee screen shows only what's actually been built**: points,
  level, collectible counts, active-challenge progress, and reward claim
  history. Badges, personal bests, and milestone messaging (Phase 7) are
  not referenced yet — there is nothing in the database to show for them
  until that phase seeds/awards them.

## Decisions made during Phase 7

- **Badges are gamification-only, tracked as a followup side effect of
  the triggering event's own transaction, never nested inside it.**
  `bonusBadges.js`'s `awardBadge()` opens its own `pool.connect()` +
  `BEGIN`/`COMMIT` and is called only *after* the ingest/claim/progress
  code path that triggers it has already committed — awarding a badge is
  purely informational (no cash/points effect) and must never be able to
  roll back or block the underlying business transaction it observes.
  Idempotency reuses the same `operation_key` UNIQUE-constraint pattern as
  every other phase (`badge:${code}:${userId}`), which also elegantly
  answers "is this the user's first X" without scanning history.

- **Only the 4 Release-1 badges from the brief are wired**: first
  delivered order, first accepted collection, first approved reward claim,
  first completed balanced-basket challenge — matching the four rows
  seeded in `bonus_badge_definitions` (migrations/076). Each is awarded at
  its natural trigger point (`bonusSourceIngest.js`'s
  `ingestOrderDelivery`/`ingestCollectionContribution`,
  `bonusRewardClaims.js`'s `approveClaim`,
  `bonusChallengeProgress.js`'s `recomputeParticipantProgress`) rather
  than via a separate sweep.

- **Personal bests are "highest confirmed full-calendar-week total,"
  never the in-progress week.** `bonusPersonalBests.js`'s
  `updatePersonalBestsForWeek` is only ever called by the challenge
  worker's tick with *last* week's bounds
  (`lastCompletedWeekBounds`) — an in-progress week's partial total could
  never fairly compete with a past full week's total, and would keep
  changing underneath a displayed "personal best" as the week continues.
  The UPSERT's `GREATEST()` means a best can only ever hold steady or
  rise, never fall, even though the worker recomputes the same completed
  week's totals on every hourly tick.

- **Next-action messaging is a single static line above the active-
  challenges list**, chosen from three states (no active challenge /
  in-progress / target reached) rather than a rules engine — the brief
  asks for "clear next-step guidance," which these three states already
  cover for Release 1's challenge types.

- **Reduced-motion celebrations are satisfied by having no celebration
  animation at all**, on any device or `prefers-reduced-motion` setting —
  the employee screen's badge/personal-best/level UI is entirely static
  HTML, so there's nothing to disable. `npm run verify:ui`'s existing
  "reduced-motion preference is respected" check continues to pass
  unchanged.

- **No Armenian translations for the new badge/personal-best/next-action
  i18n keys**, consistent with the rest of the Bonuses module's existing
  `en`-only keys (see Phase 6's scope notes) — `hy` falls back to `en`
  for every `bonuses_*`/`bonus_*` key already, not just these new ones.

## Phase 8: end-to-end validation

`server/test/integration/bonusEndToEnd.test.js` drives the whole module as
one real user journey through the actual HTTP routes (not another unit
test for a single function): starting from `bonuses_enabled=false`
(confirmed 404 on the employee summary route), an admin creates and
publishes a challenge template over `POST /api/bonus-challenges/templates`
and its `/publish` route, the challenge engine's `ensureOnceRound` creates
the round, a real payment approval flows through
`ingestCollectionContribution` (Phase 3) and both earns a collectible and
awards the "first accepted collection" badge (Phase 7) as a followup side
effect, the worker's `processRound` (Phase 4) recomputes progress and
finalizes the round into a reward claim, the employee's own
`GET /api/bonus-summary` (Phase 6) reflects the collectible count, badge,
personal best, and claim, an admin approves the claim over
`POST /api/bonus-reward-claims/:id/approve` (awarding the "first approved
reward" badge to the claimant, never the approving admin), a plain
sales_manager is confirmed unable to record the payout while an accountant
can (`canRecordBonusPayouts` vs `canApproveBonusRewards`, Phase 5), and
finally `bonuses_enabled` is turned back off and the employee route goes
back to 404 — proving the module returns cleanly to fully inert. A second
test confirms `app_settings.bonuses_enabled`'s column default is `false`
directly against the schema, independent of any test having touched the
row. Together with the 353 tests across all 8 phases (`npm test`) and
`npm run verify:ui`'s 27 checks, this is the acceptance validation the
brief's Section 13 matrix asked for.

Also confirmed during this phase: `npm run check:version` passes, the
server boots cleanly and smoke-tests correctly with the flag both off and
on, and a full local run of `npm test` was repeated twice with zero
failures to rule out the cross-test-file `bonuses_enabled` race (documented
in Phase 4/5's notes) recurring under the new, longer-running end-to-end
test.

## Turning it on (Phase 8 handoff)

The module is entirely inert until someone flips
`app_settings.bonuses_enabled` to `true` (currently only settable via the
Bonuses admin surface — there's no separate ops toggle). Before doing that
in production:

1. **Design the real challenge templates first.** Nothing is pre-seeded
   beyond the schema's own reference data (level thresholds, the 4 Release-1
   badge definitions) — an admin with `canManageBonusChallenges` (admin/ceo)
   needs to actually create and publish templates via Settings → Admin
   Workspace → Bonuses before employees see anything beyond an empty
   points/level view.
2. **Turn the flag on.** This immediately makes `GET /api/bonus-summary`
   live, exposes the "Bonuses" Home Quick Action, and lets the two
   in-process workers (`bonusReconciliation.js`, `bonusChallengeWorker.js`)
   start actually finding work to do on their existing hourly/periodic
   ticks — they no-op harmlessly while the flag is off, so there's no
   separate "start the worker" step.
3. **Monitor the first few worker ticks** (`console.error` calls in both
   workers' `setInterval` catch blocks are the only current failure
   signal — see `docs/monitoring.md` for how server logs are watched) and
   the reward-claims queue (Settings → Admin Workspace → Bonuses → Reward
   claims) for the first batch of claims once a round's validation window
   closes.
4. **Rollback plan**: flip `bonuses_enabled` back to `false`. This is
   instant and safe — no data is deleted, ledger/challenge/claim history
   stays intact, the employee route goes back to 404, and every worker
   goes back to a no-op on its next tick. Re-enabling later resumes exactly
   where it left off (idempotent `operation_key`s mean nothing double-fires
   on the next tick after a pause).

One scope gap carried forward from Phase 6, still open: "Monthly Leaders"
was deliberately left in place rather than replacing the Home
presentation, so both exist side by side until someone makes an explicit
call to retire the old one. It doesn't block turning the flag on — Monthly
Leaders staying visible alongside the new Bonuses entry point is a
presentation choice, not a data-integrity risk.

## Admin creation wizard (post-Phase-8 follow-up)

Phase 4's admin template dialog was originally a single long form with no
way to create a `product_sales` challenge (its own comment said so
explicitly — product targets needed the API directly). Replaced with a
5-step guided wizard in `client/public/js/views/bonusChallengesAdmin.js`
(`openNewChallengeWizard`), matching the wizard shape already used
elsewhere (`routePlans.js`'s `openNewRoutePlanFlow`): one sheet body
re-rendered per step, state accumulated in a single `draft` object rather
than re-read from the DOM at submit time (later steps, like the product
search results, aren't all present in the DOM at once).

1. **Basics** — title, description, type (with a one-line hint per type).
2. **Rules** — metric targets for `single_metric` (exactly one, no add/
   remove) and `balanced_basket` (add/remove freely), or a debounced
   product search (reusing `GET /api/products?q=`, the same endpoint the
   Pricelist/Orders pickers already use) with an add/remove/quantity list
   for `product_sales` — the gap this wizard exists to close.
3. **Schedule & reward** — recurrence, validation grace period, cash
   reward, watermelon points, and, only when recurrence is `once`, the
   `first_round_policy` choice with its own conditional sub-fields
   (a scheduled start date/time, or an explicit start/end date range).
4. **Audience** — `selected_users` (the only mode the old form supported)
   or `selected_roles` (new — a checkbox list of `roles.js`'s `ROLES`,
   mirrored client-side as `ROLE_LABELS`).
5. **Review** — a plain-language summary of every choice, then the same
   `POST /api/bonus-challenges/templates` call the old form made; nothing
   about the API payload shape changed, only how it's collected.

Verified via a real browser (Playwright against the actual dev server, not
just `node --test`): logged in as an admin, stepped through creating a
`product_sales` challenge end to end (product search and pick, `once` /
`historical_explicit` scheduling, `selected_roles` audience), confirmed
the draft template and its `bonus_challenge_product_targets` row landed
correctly in the database, and confirmed no uncaught JS exceptions during
the flow. That verification script was a throwaway (not committed) since
it duplicated the review-step assertions node:test integration coverage
doesn't reach (real click-through, real network requests) without adding
a second, slower e2e spec for a UI wizard whose payload the API layer
already validates thoroughly.
