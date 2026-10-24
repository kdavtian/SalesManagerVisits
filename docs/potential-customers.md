# Potential Customer classification (owner, 2026-10-24)

A potential customer (tier `potential`) is no longer one generic group. Every one carries a **Potential Level** and the **reasons** behind it; every change is kept as history.

## Levels (manual, the primary system)
1 No potential (Հեռանկար չկա) · 2 Low (Ցածր) · 3 Real (Իրական) · 4 High (Բարձր) · 5 Very high (Շատ բարձր). `NULL` = not assessed (every potential customer that existed before 1.393.0 starts there; the New customer form requires a level).
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
