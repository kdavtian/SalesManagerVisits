# Staff module (owner, 2026-10-23)

People, who reports to whom, payroll. It replaces the Excel sheets Tabel, Sales Team 2026 and Plan 2026: nothing is copied from them, everything (people, fixed salaries, rules) is set in the module.

## Data (migration 141)
- `staff_members`: name, position, `kind` (executive / director / rep / office / warehouse / driver), `reports_to` (the tree; loops are refused), optional `user_id` (the person's app login, one login = one person), fixed monthly salary, `visit_based`, own visit threshold, paid day-offs per month, commission (`commission_basis` none / collected / sales, `commission_pct`, channels counted / never counted), start / end date, active.
- `staff_days`: an explicit mark for one day: `completed` (counts as a full day), `dayoff`, `unpaid`.
- `staff_pay_items`: premiums, bonuses and deductions of a month.
- `app_settings.staff_settings`: company rule `min_visit_pct` (default 75, changed by the CEO / admin in Staff -> Rules).

## Pay (server/src/payroll.js)
`pay = daily rate x paid days + commission + premiums + bonuses - deductions`, `balance = pay - paid`.
- **Daily rate** = fixed salary / working days of the month (Mon-Sat minus `company_holidays`). October 2026: 27 days, 200,000 AMD -> 7,407 per day.
- **A day is paid** when the boss marked it `completed`; or it is a `dayoff` inside the person's paid allowance; or nothing marks it and
  - the person is visit-based and the rep did at least the threshold % of the visits in that day's **approved plan** (check-ins of the planned customers), or
  - the person is not visit-based (every working day).
  A day marked `unpaid`, a day off over the allowance, and a visit-based day with no approved plan are not paid (the boss can still mark it completed). Today stays open until the % is reached.
- **Commission**: the person's % of the money collected (Cashflow "Oil order" rows of their channel) or of sales (order lines, internal stock customer 10000 excluded), minus the channels that never count (the sales director excludes KF and CAS).
- **Paid** = Cashflow "Salary" rows whose Info is `<position> <YYYY> <MON>` (`SM YVN 2026 OCT`). Other spellings of the position (`Sales Manager YVN`) go in the person's "other spellings".

## Access (server/src/routes/staff.js, roles.js)
- admin / CEO / accountant: see everyone, manage people and pay items. Only admin / CEO change the company rules.
- Anyone else: themselves and everybody below them in the tree (the sales director -> the reps).
- Marking days: admin / CEO for anybody; a boss for the people below them (not for themselves); the accountant does not mark days.

## Screens (`#/staff`, `#/staff/<id>`)
Payroll (month list with earned / paid / balance), People (add / edit), Structure (the tree), Rules; a person's month with the day calendar (tap a day to mark it), the breakdown and premiums / bonuses / deductions. Tile `qa_staff`; the warehouse manager and driver Homes have a Staff tile for their own pay.

## Not yet
- Salary payments are read from Cashflow, not created here (Cashflow phase 2: add entries in the app).
- Importing the people from the old Excel sheets is deliberately not done.
