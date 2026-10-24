# Potential Customer classification (owner, 2026-10-24)

A potential customer (tier `potential`) is no longer one generic group. Every one carries a **Potential Level** and the **reasons** behind it; every change is kept as history.

## Levels (manual, the primary system)
1 No potential (Հեռանկար չկա) · 2 Low (Ցածր) · 3 Real (Իրական) · 4 High (Բարձր). `NULL` = not assessed (every potential customer that existed before 1.393.0 starts there). The former level 5 "Very high" was removed in 1.396.0 (owner, 2026-10-24); migration 145 turned those prospects into High. In the forms the four levels are one row of chips and **Real potential is preselected**; only the six reasons that usually fit the level (plus "Other") are shown, the rest sit behind "More reasons…".
Level 1 never deletes or hides a customer; it can be reassessed any time.

## Reasons
Counterfeit / not original products, own import, stable cooperation with a competitor, price mismatch, small volume, not interested, no access to the decision maker, payment / solvency problem, no demand for now, high sales potential, active interest, negotiation stage, ready for the first order, other (+ mandatory text). One or more; at least one is required.

## Counterfeit rule
Ticking "Counterfeit / not original products" raises `customers.counterfeit_flag`: a red warning on the customer card and on the New order screen, and **genuine Castrol lines are refused** (server, `buildOrderLines`: brand contains "castrol") for that customer, for the app and KAD OS orders alike. Visiting and working on the customer stays allowed. Only management (admin, CEO, operations director, sales director) can mark "Counterfeit issue is resolved" (date, employee, optional comment are stored and shown in the history). Ticking the reason again after a resolution raises a new flag.

## Who
Any management role sets any customer's level; a sales manager only their own customers (`assigned_manager_id`). History: same people.

## Data (migration 142)
`customers.potential_level / potential_reasons / potential_reason_other / potential_updated_at / potential_updated_by / next_followup_date / expected_volume_l / counterfeit_*`, and `customer_potential_history` (level changes, flag set, flag resolved: previous + new level, reasons, note, who, when). Follow-up date and expected volume are optional ("More" in the editor) and feed the filters; they are also what a later automatic 0-100 score would read (owner: not now).

## API
`PUT /api/customers/:id/potential`, `GET /api/customers/:id/potential-history`, `POST /api/customers/:id/counterfeit-resolve`; `POST /api/customers` accepts `potential_level / potential_reasons / potential_reason_other` for a new potential customer.

## Filters, priority, counts (1.394.0)
- **Customers list -> Potential filter** (bullseye icon, only when potential customers exist): level (with live counts, incl. "not assessed"), reason, counterfeit restriction, last visit (no visit in 7 / 14 / 30 days, never), next follow-up (due or overdue, next 7 days, none), expected volume (50 / 200 / 500 L a month and more). Sales manager and region are the list's own filters. With the filter on, the list is the worklist: high first, then real, not assessed, low, no potential; soonest follow-up next. Rows show the level chip (and a warning mark for the counterfeit restriction).
- **Follow-up priority** (`visitPriorities.js`, the "Visit first" card): a prospect that already has a reason to be visited gets high +20, real +10, not assessed +8, low +3, none 0; a follow-up date that has come adds +15 and is a reason of its own. The level never adds a customer to the card by itself, and "no potential" customers are never hidden.
- **Company dashboard -> Prospects by potential** (admin, CEO, operations director, sales director, accountant; a rep's own numbers are on the same endpoint): count per level, counterfeit restrictions, follow-ups due, and a by-sales-manager breakdown. Each row opens the Customers list with that filter (`#/customers?potential=4`, `=counterfeit`, `=due`).
- `GET /api/customers/potential-summary`.

## New customer: ERP customer ID (1.396.0)
Choosing Bronze, Silver or Gold makes the ERP customer ID mandatory (the field gets a red star, the form refuses to save without it). The server enforces it too: `POST /api/customers` answers 400 (it used to quietly save such a customer as Potential), and `PATCH` answers 400 when the tier is *changed* to Bronze / Silver / Gold and the customer has no ERP ID (a save that sends the unchanged tier back is never refused, so older customers stay editable).

## Reasons remembered per level (1.406.0)
Picking a level ticks the reasons the same user last saved for that level (browser storage `fieldvisits_potential_reasons:<userId>`, per device); a small "Last used" label shows until a reason is touched. "Other" (needs a typed explanation) and "counterfeit" (starts a restriction) are never remembered. Changing the level swaps the reasons to that level's own (they no longer carry over).

## Server memory (1.408.0)
The last used reasons per level are stored on the server (`user_potential_reason_memory`, migration 149) so they follow the person between devices; the browser keeps a copy for offline use.
