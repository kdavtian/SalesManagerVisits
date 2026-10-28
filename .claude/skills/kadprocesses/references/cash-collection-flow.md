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
