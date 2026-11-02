# Cash collection and the document flow (owner's description 2026-10-28; V1 + V2 chosen the same day)

## Today (as the owner described it)
1. Reps collect money in the field; sometimes they deliver goods and collect at the same visit. They record it in the app: order,
   payment, check-in (payment slip signed by the customer on the phone since 1.428.0).
2. Back at the office the rep hands the paper checks to the sales director.
3. The sales director writes down every collection by hand, grouped by rep: date, ERP id, customer name, amount.
4. The director sends a photo of that paper to the Telegram group.
5. The accountant (Mane) types the rows into the Excel cashflow sheet. The next bot sync marks the app payment "in Excel" and approves it
   when customer + amount + date (3 days) match exactly.

Four hand-written copies of one number (rep's check, director's list, Telegram photo, Excel). Each copy is a place to make a mistake or hide one.
Where fraud can hide: rep collects and does not record; director counts short; accountant mis-keys; nobody compares the copies in time.

## What the app already has for this
- `payments` with status pending -> approved; `approved_from_erp` when the Excel match did it.
- Payment slip PDF with the customer's signature (required), stored in `customer_files`, visible in the accountant's Documents inbox.
- Cash hand-offs (`cash_handoffs`): rep -> sales director -> (CEO |) accountant; sender declares, receiver confirms or rejects with a reason;
  the amount is recomputed by the server from the included payments; the accountant's confirmation is terminal = payments approved.
- "In Excel / not in Excel" on every payment; "Collected, not in Excel" on Debt balances; anti-fraud findings (not in Excel after 3 days,
  cash held > 3 days or > 1,000,000 AMD, late recording, bursts, repeated round amounts, KAD OS disputes, weekly check calls).

## Chosen flow (V1 + V2, owner 2026-10-28)
1. Rep at the shop (no change): payment recorded, amount pre-filled from the debt, customer signs the slip; cash without a slip is flagged.
2. Rep at the office: taps **"Hand over today's cash"** -> one hand-off with all his unconfirmed payments and the total to put on the table.
3. Sales director: counts, opens the hand-off, sees the list (date, ERP id, customer, amount, rep), taps **Confirm** or **Discrepancy**
   with the counted amount. No writing. Replaces the paper list.
4. Automatically on confirm: the **Daily cash sheet** goes to the Telegram group (per rep: date, ERP id, customer, amount, total) as text
   and as an Excel-ready file. Replaces the photo.
5. Accountant: records from the file (copy-paste block or one-click import if the Cashflow layout is fixed), taps **"Recorded in Excel"**,
   or does nothing: the next sync matches each payment and the sheet closes itself.
6. Control loop (Vaghinak): payment "not in Excel" after 2 days, hand-off not confirmed by evening, any discrepancy -> a task to the right
   person and a line on the owner's Home "Needs attention".

Removes: 3 of 4 manual copies; the director's evening work becomes a count + one tap.
Protects: rep fraud (slip exists only in the app; debt tile and "customer paid but nothing recorded" check; later customer-side receipt in
KAD OS / SMS), director short-count (expected amount computed before counting; only confirm or declare a discrepancy), accountant
mis-keying (import, mismatches surface automatically). Full trail per day: who collected, who counted, when, where, what was recorded.

Depths offered: V1 = steps 2-4 (one release); V2 = + steps 5-6 (recommended with V1); V3 = customer-side confirmation (later).

Owner's answers (2026-10-28):
1. The file must match the Castrol Excel **Cashflow** and **Sales** sheets Mane fills today.
2. The director counts **per rep** (one hand-off per rep).
3. Yes: the bot posts to the **existing accounting Telegram group**.
4. Paper slips stay for a **transition month**, then the app is the only record.

## Built (1.453.0 + CEO bot, 2026-10-28)
- Rep: Home card "Hand over today's cash" (amount + count) -> one confirm step; the cash goes to the rep's Staff "reports to" boss first,
  then a sales director (never straight to the accountant by default).
- Director: the hand-off sheet has "Counted on the table" (starts at the expected total); a different amount = "Confirm with difference"
  + a required note; the owner side (admin, CEO) gets a notification and a task. Reject asks the reason inside the sheet (no pop-ups).
- Confirming a REP's hand-off makes the daily cash sheet (`cash_sheets`, migration 166; `server/src/money/cashSheets.js`). The CEO bot polls
  `/api/erp-sync/cash-sheets/pending` every ~30 s and posts text + Excel to `telegram.upload_chat_ids` (or `cash_sheet_chat_ids`).
  Excel: tab "Cashflow" = workbook Cash columns A..G (Date, Amount, Currency=AMD, For="Oil order", ID=Customer ID, Source=rep cash box
  by channel: SM YVN->Cash YVN, SM Davtashen->Cash DVT, SM Shirak->Cash Shirak, else Cash, Info="rep · app <payment id> · sheet <n>");
  tab "Sales" = orders the rep delivered himself that day (pod_records.driver_id = rep).
- Accountant: Cash handovers page > "Daily cash sheets": Excel file, "Recorded in Excel" (undo in the toast); the sync closes a sheet by
  itself when every payment of it matches an Excel Cashflow row ("Found in Excel").
- Checks (every 30 min, working days): a rep's hand-off still pending at 20:00 -> task for the receiver; a sheet not recorded after 2 days
  -> task for the accountant(s); a discrepancy -> task + notification for admin and CEO.
- Paper slips: kept for the transition month (until ~2026-11-28), then dropped (owner's decision; no code involved).

## Payments redesign (owner, 2026-11-02) -- decided, built in releases R1..R4
Proposal: artifact "Payments Redesign". Every payment has TWO tracks: cash (collected -> counted -> received) and books (open -> matched
automatically / linked by hand). Card and bank payments have no cash track. A mistake is voided with a reason, never deleted.
Owner's answers:
1. Cutover 2026-11-01: the new records start that day; older payments stay in the old module as the archive (fresh start).
2. Bank transfers come into the app (from the bank statement import).
3. A payment pays the customer's oldest unpaid orders first, automatically.
4. The accountant receives the cash at the end; a rep may ALWAYS hand cash straight to the accountant.
5. Matching accepts sums: several payments = one Excel row, one payment = several rows (same customer, +-5 days, exact amounts).
6. A counting difference: note + task + notice to admin/CEO, and the shortfall stays on the rep's line until closed.
7. After counting (and for card / bank), only admin and CEO may void a payment, with a reason.
8. Partial payments and advances (more than the debt) are allowed; an advance is a credit on the customer.
9. Where money is received: bank accounts, the card terminal, and the cash desks of each rep, the sales director and the CEO
   (= cash_accounts, the Excel "Source"; since R2 a desk has one or more holders in cash_desk_holders).
10. Depth: Recommended (R1-R4) + Later (customer confirms each payment in KAD OS / SMS receipt).
R1 (1.488.0): migration 174 (customer_payments, payment_book_links, payment_allocations, customer_payment_events, cash_accounts.holder_user_id
+ kind 'card', app_settings.payments_cutover / payments_v2_live), server/src/money/payments2/ (matching.js pure rule, books.js, bridge.js copy
from the old module since the cutover, service.js void), /api/payments2 (status, one payment, run, void), job "payments-v2" every 10 min.
Excel rows are matched from cash_entries by a STABLE key (customer|date|amount|account|n) because the sheet is reloaded with new ids.
R2 (1.489.0, owner 2026-11-02): cash desks + bank payments. Owner's answers:
- Cash desks = the Excel "Source" names: Office desk (both accountants + CEO), Sales director desk, SM YVN desk, SM Davtashen desk (one
  rep each). A desk may have SEVERAL holders (cash_desk_holders). Admin adds / edits desks (Money -> Bank & cash desks -> Cash desks); a
  renamed desk keeps its old name as an Excel alias (cash_accounts.excel_aliases), so the Excel import still lands on it.
- Every sales rep automatically gets his own desk "SM <name> desk" when created or made a rep (desks.js ensureRepDesk); the one-time
  setup command (server/scripts/setup-cash-desks.mjs, names passed in the command, never in the repo) also covers existing reps.
- Card payments go through the bank: the accountants handle bank payments, typed by hand or read from an uploaded statement (the
  Cashflow statement upload, one upload for both). A credit line (AMD, from the cutover, bank account) is recorded automatically when
  the payer is recognised: a payer the accountant confirmed before -> the customer's TIN in the line -> a payer name equal to exactly one
  customer's name / legal name (owner chose "also automatic on exact name"). Otherwise it waits in "To check" ("Unspecified"): choose the
  customer (payer remembered by default), not a customer payment (remembered), and for a possible second copy: same money / separate.
- Never twice: a statement line is imported once (hash), holds at most one payment; a line equal to a payment typed by hand (customer,
  amount, +-5 days) confirms it; typing a payment that looks recorded is refused until "separate payment"; a voided bank payment puts its
  line back in To check. Bank payments do not change debts until R4 (Excel stays the truth; the accountant keeps typing Excel rows).
- Owner, later the same day: the Office desk is held by the accountants, Ilona (a second user with the CEO role, who handles the CEO's
  cash) and admin; admin can do everything in every desk (release 3's cash steps treat admin as a holder of all desks); the CEO role may
  add / edit desks too (canManageCashDesks = admin, CEO).
R3 (owner 2026-11-02): keep the existing screens (check-in payment, Home "Hand over today's cash", director count sheet, cash sheets) and
fix + add instead of rebuilding. R3a (1.492.0, migration 176):
- Cash in hand (server/src/money/cashCustody.js CASH_IN_HAND_SQL): a payment the Excel already shows (approved from the ERP sync) is still
  cash in the rep's hands until handed over (it used to drop out of the hand-over); from the cutover on only. The accountant's confirmed
  hand-over records her as the one who received it (approved_by). Used by the hand-over lists, anti-fraud custody, the cash-custody
  report and offboarding.
- Approving directly (admin / accountant) = the approver received the money: payments.current_holder_id moves to the approver.
- Shortfall line (answer 6): counted LESS than handed over -> cash_shortfalls row on the sender's line (Home card, Cash handovers page)
  until "Paid in" (director / accountant / admin / CEO / ops) or "Written off" with a reason (admin / CEO). Counted more = note only.
- Bridge: cash on a desk an accountant holds (the Office desk, also when the CEO holds it) = received.
Owner's answers for R3b / R3c: keep both rep entry points and give the Payments "+" sheet signature, slip photo and offline saving; a
payment pays the oldest unpaid orders across Excel AND app orders (leftover = advance).
