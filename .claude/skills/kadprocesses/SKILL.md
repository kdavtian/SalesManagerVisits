---
name: kadprocesses
description: The BUSINESS PROCESSES of KAD Motors (Castrol distributor, Armenia) as they run today and as the owner decided to change them - who does what, in which order, with which paper or app screen, which control catches a mistake or fraud, and what is still manual. Covers field visits, orders, delivery, cash collection and the paper-to-Excel document flow, returns, tasks and subordination, staff and pay, the Excel / app / bot / accountant split. Use whenever the owner asks to automate, simplify, control, audit or redesign a process ("document flow", "how should X work", "suggest process", "risk of fraud", "who approves"), before proposing or building any process change in the Field Visits app, KAD OS or the CEO bot. Companion to KADDev (how to build) and Castrol-file (the workbook).
---

# kadprocesses - how KAD Motors runs, process by process

Owner: one person (admin account, CEO role in life). Company: KAD Motors, Castrol / Lotos / Royal / Orlen lubricants distributor in Armenia,
Yerevan office + warehouse, field sales reps in the city and regions. Goal (2026-10-12): No. 1 in the Armenian lubricants market in volume,
sales and profit (~1M litres/year, from ~94k). Operating mindset (2026-10-14): **data -> decision -> action**; a number nobody acts on is waste.
The owner's three words for every process change: **simpler, faster, controlled** (full control and transparency, fewer misstatements, less fraud).

Read this file, then the reference that matches: `references/cash-collection-flow.md` (the collections / document flow, today and proposed).
For HOW to build in the app read the KADDev skill; for the workbook read Castrol-file. Never put real phones, TINs, salaries or tokens here.

## 1. The people (roles in the app)
| Role | Who | Does |
|---|---|---|
| admin | the owner (always this account) | everything; sees everything; "management" always includes admin |
| ceo | the owner's role in life | approves, sees all reports, tasks anyone |
| operations_director | ops | management view, approves, tasks the people below them in Staff |
| sales_director (Martin) | runs the reps | plans, approves route plans and discounts up to net cost, receives the reps' cash, tasks his reps |
| sales_manager (reps) | field sales (SM YVN, SM Shirak, SM Davtashen, SM CAS ...) | visits, orders, collects cash, records payments, check-ins |
| warehouse_manager | warehouse | packs, stock, receives returns |
| delivery_manager (drivers) | delivery | delivers, proof of delivery, collects signed act |
| accountant (Mane; the financial director has this role too) | money + documents | confirms cash (terminal custody), approves payments, records in Excel, issues invoices / waybills (Lily) |

Subordination (owner, 2026-10-28): tasks follow **Staff "reports to"** (direct and indirect); admin and CEO task anyone; the accountant sends
*requests* (Խնդրանք) to the sales director. Pay rules, working days and who reports to whom live in the **Staff** module.

## 2. Sources of truth
- **Castrol Excel workbook** (kept by the accountant, posted daily to a Telegram group) = truth for debt, sales, prices, HC codes, cash ledger,
  plan. The **CEO bot** reads it and syncs into the app (`erp_*` tables) several times a day. Until "cutover", app totals must reconcile to it.
- **Field Visits app (KAD Motors app)** = truth for operations: visits/check-ins (GPS), orders, payments recorded by reps, cash custody,
  tasks, documents (photos, signed PDFs), route plans, staff.
- **KAD OS** = the customers' own free ERP; customers see their orders/payments from KAD and can dispute ("I don't see my payments").
- **Lily** = the accountant's agent that reads confirmed orders from the app and prepares invoices / waybills in the accounting system.
- **Vaghinak** = the AI operations deputy inside the app: watches the data, creates tasks, anti-fraud findings, weekly check calls.

## 3. Processes as they run today

### 3.1 Field visit
Rep follows the route plan (recurring weekday rules or a day plan, approved by the director) -> check-in at the shop (GPS within the
allowance, 300 m default; management may check in anywhere) -> records what is on the shelf (brand chips), orders, payment, photos ->
check-out. Overdue = not visited within the customer's frequency (default per channel / tier). Reps earn points (visit, photo, new customer).
Controls: GPS, within-range flag, "Visit first" ranking by debt / overdue, Vaghinak tasks (debt collection, reorder), daily summary 19:00.

### 3.2 Order
Rep creates draft -> submits (credit limit check, discount policy: <= 3 % automatic, more needs director / CEO; never below net cost) ->
accountant / Lily confirms and requests invoice or waybill -> warehouse packs (stock reserved) -> driver delivers with the **delivery-
acceptance act** (order blank PDF; customer signs on the rep's phone, rep's signature applied silently, PDF per order, order locked after
signature) -> paid. "From ERP": after each Excel sync an order matching an ERP order (customer, date +-1 day, total +-1 AMD) is marked
Delivered automatically. Failed delivery stays packed. Returns / cancellations: request -> management or accountant decides -> warehouse
receives (good / damaged) -> accountant records in Excel (auto-matched to negative ERP lines when possible).

### 3.3 Cash collection and the document flow (the part the owner wants redesigned)
Today: rep collects cash (sometimes delivers and collects), records payment + signed slip in the app -> back at the office hands paper checks
to the sales director -> director writes a paper list per rep (date, ERP id, customer, amount) -> photo to the Telegram group -> accountant
types it into the Excel cashflow sheet -> next sync marks the app payment "in Excel" (auto-approve on exact match). Four hand-written copies
of the same number. Details, risks and the proposed redesign: `references/cash-collection-flow.md`.
App pieces that already exist: payment slip with customer signature, cash hand-off chain rep -> director -> (CEO |) accountant with confirm
/ reject and the accountant's confirmation = terminal (payment approved), "in Excel / not in Excel" per payment, "Collected, not in Excel" on
Debt balances, anti-fraud detectors (not in Excel after 3 days, cash held > 3 days or > 1M AMD, late recording, bursts, repeated round
amounts, customer disputes from KAD OS, weekly check calls).

### 3.4 Money ledger (Cashflow)
Excel `Cash` table mirrored into the app (bot sync or manual import); admin / CEO / accountant may add rows in the app (risk: double entry
while Excel is still kept). Salaries are in this ledger. Bank statements can be matched to rows.

### 3.5 Staff and pay
Staff module: people, position, kind, reports to, fixed salary split over working days, visit-based days (a day pays only when enough
planned visits were done), paid days off, commission (collected or sales, per channel). Day marks: completed / day off / unpaid.

### 3.6 Tasks
Management gives tasks with a checklist, optionally on a customer, due on a date (next visit by default). Typed tasks (collect debt, make
order, check products, call customer, visit customer) close themselves when the rep does the thing. Vaghinak creates the automatic ones
(debt collection after every sync: no payment longer than the credit term, KF / CAS / OEM skipped; max 15 per rep per run).

### 3.7 Planning and performance
Monthly plan per channel (Team Performance: draft -> submitted -> approved -> closed month), sales vs plan with collections tick, pace and
forecast, "needs attention" recommendations. Route plans: recurring rules + day plans, approved by the director; auto route plan.

## 4. Controls that exist (where fraud or mistakes are caught)
- GPS check-in allowance; check-in spots map for a wrong pin; pin review.
- Credit limit and net-cost guard on orders; discount approval ladder.
- Customer signature on the act and on the payment slip; order locked after signature.
- Cash custody chain with amounts recomputed by the server; a payment frozen while in an in-flight hand-off.
- Excel as the independent record: "not in Excel" after 3 days is a finding; "From ERP" matching is exact (customer, amount, date).
- Vaghinak anti-fraud tab with risk score per rep, learning from Confirmed / False alarm, weekly check calls to customers.
- KAD OS: the customer sees their own payments and can dispute.
- Role boundaries enforced on the server (see docs/roles-permissions.md in the repo).

## 5. Decided process rules (dates = owner's decision)
- 2026-10-13: a rep's check-in counts as a visit at any distance (the allowance refuses too-far check-ins instead).
- 2026-10-13/14: notifications minimal; one 19:00 summary; task deadline reminder 09:30.
- 2026-10-24: Cashflow in the app; Excel stays the source until switched off.
- 2026-10-25: anti-fraud watch, management decides, nothing blocks a rep automatically.
- 2026-10-26: documents live per customer AND per order AND in the accountant inbox; rep's signature silent; one customer signature for
  all orders of a visit; signing works offline; after signature only admin / CEO may change the order; drivers use the same flow; AI check
  OFF by default behind a switch; documents kept forever.
- 2026-10-27: the accountant / financial director sends *requests* to the sales director (same task object, named Խնդրանք).
- 2026-10-28: tasks follow Staff "reports to"; admin and CEO task anyone; admin unlocks a locked sign-in from the Team page.
- 2026-10-28: sales director and above (ops director, CEO, admin) may move a CONFIRMED order back to submitted to change it, then confirm
  again; not once packed, not while accounting works on its documents (a pending accounting request is cancelled).
- 2026-10-28: no order may ADD a product that is out of stock (Excel stock minus what open orders already promised <= 0), whatever the path
  (KAD Motors app, KAD OS, edit, draft submit); unknown stock passes for staff, not for KAD OS. Server: `orderStock.js`.
- 2026-10-28: what a customer wants but we do not have is a **wish** (`product_wishes`, `productWishes.js`): an out-of-stock catalog product
  ("Wish" on the order row; a search shows out-of-stock matches even with "Available only") or a product we never carried ("Product we
  don't have", typed name). Never part of the order. Management (admin, CEO, ops + sales director) is notified at once and reads Reports >
  Wished products (by product / typed name, most customers first). After an Excel sync a wished product that is available again notifies the
  customer's rep once. KAD OS customers add wishes too (`/api/partner/wishes`) and see "back in stock".
- 2026-10-28 (document flow answers): Mane fills the Castrol Excel **Cashflow and Sales sheets**; the director counts **per rep**; the daily
  cash sheet is posted to the **existing accounting Telegram group by the bot**; paper slips are kept for a **transition month**, then dropped.
  Build: V1 + V2 of `references/cash-collection-flow.md`.

## 6. How to propose a process change (what the owner expects)
1. Describe the process as it runs today in 3-5 steps naming the person and the paper / screen at each step.
2. Count the manual copies of the same data and the places a mistake or fraud can hide.
3. Propose the new flow with the SAME numbering: who taps what, what is generated automatically, which control replaces which paper.
4. Say what it removes (minutes, papers, taps), what it protects against (rep / director / accountant / customer side), and the trail.
5. Offer 2-3 depths (minimal / recommended / later) and a recommendation; list the open questions in full; wait for the owner's choice.
6. Policy changes are the owner's: never implement a new rule without a yes; when told "suggest", only suggest.
