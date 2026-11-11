# The two apps: what exists, what to build

## Field Visits (kdavtian/SalesManagerVisits): already built
- Reader: `server/src/money/bankStatement.js` (`readStatement`, `detectLayout`, `parseAmount`, `hashLines`, `matchLines`), migration 146
  (`bank_imports`, `bank_statement_lines`: hash unique per account, status open / added / ignored, `entry_id`).
- Upload UI: Cashflow -> Bank (`openBankSheet`, client `bankStatements.js`), preview before import, column mapping when headers are unknown.
- Customer payments from bank lines: `server/src/money/payments2/bankPayments.js` (credit lines from the cutover on, AMD, bank account ->
  a customer payment, or confirms a typed one; likely duplicates wait), payer rules `payments2/payerMatch.js` + table `bank_payers`
  (migration 175), the "Unspecified" list for the accountant.
- Docs: `docs/cashflow.md` "Bank statements". Phase 3b (planned there): the bot takes the statement from a Telegram group.
- ACBA work here = confirm the ACBA layout (statement-format.md checklist), add missing header words, nothing else.

## KAD OS (kdavtian/kad-gmm): to build (owner 2026-11-11: "both", "Excel export", "mark invoices paid" + "record in Cash")
Sources and money today: Cash sources `SOURCES` incl. "Acba Bank" (`lib/categories.js`), app cash entries `app_cash_entries`, receipt
payments `receipt_payments` (method transfer, `details` = company / TIN from the customer since 0.132.0), `cash_all` view = Excel rows +
app rows, balances in `routes/dashboard.js` (`GET /api/dashboard/balances`, opening via `cash_openings`). Invoice state: `needsInvoiceSql`,
`invoiceSentSql` in `lib/invoiceRequest.js`. Partner visits: `receipts.partner_of`, `visit_customer_id` (migration 073).

Plan, one PR per step (KADDev rule 62), each size L / class C:
1. **Reader + import** (migration `bank_imports`, `bank_statement_lines` like Field Visits; copy `bankStatement.js` as `lib/bankStatement.js`,
   ES module, no ExcelJS change needed, same tests adapted). Route `POST /api/bank/preview`, `POST /api/bank/import` (CEO / admin),
   `GET /api/bank/lines?status=`. UI: Cash -> a "Bank" button -> upload sheet with preview. Before the KAD OS cutover: reconcile only.
2. **Payer + invoice matching** (copy `payerMatch.js`; `bank_payers`; the rules of matching.md 3) applied at import; the "Unspecified" list in
   Cash -> Bank with one-tap answers; payments added through the same code as Pay debt (`addPayment`, method transfer, pay_date = bank date).
3. **Cash recording** after cutover (matching.md 4) + the balance check against the statement's closing balance on the ACBA card.
4. **Telegram**: the bank statement posted to a group is imported by the existing sync bot (same as the GMM workbook, `sync/telegramSource.js`),
   one group per purpose, the bot replies with the one-line summary.
5. **Andranik / bell**: a reminder when "Unspecified" lines wait more than a day; the CEO's bell when the balance check fails.

Tests: unit for the reader (CSV / xlsx / header words / Debit-Credit / amounts / dates) and the matcher (TIN, names, sums, overpayment waits),
integration for import twice = nothing new, automatic payment applied once, partner receipt paid, balance check. Fake data only.
