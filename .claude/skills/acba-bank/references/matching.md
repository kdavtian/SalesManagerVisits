# Who paid and what it pays

The rules, most certain first. "Automatic" = applied at import; everything else waits for a person in "Unspecified" with the guesses shown.
Field Visits implements 1a-1c today (`payments2/payerMatch.js`, pure, tested): copy it, do not rewrite it.

## 1. Who is the counterparty (incoming lines)
a. **A remembered answer**: the accountant once said "this payer = customer X" or "not a customer": key = the normalised payer name
   (`payerKey`: lower case, punctuation gone, 200 chars). Automatic.
b. **TIN**: an 8-digit number in the payer column or the purpose text that is exactly one customer's TIN (KAD OS `customers.tin`, Corporate /
   Partner only; Field Visits `customers.tin`). Automatic. Two customers with the same TIN = wait.
c. **Exact name**: the payer name without its legal form (ՍՊԸ, ՓԲԸ, ԱՁ, LLC, CJSC, ООО ... see `LEGAL_FORMS`) equals exactly one customer's
   name or legal / company name. Automatic (owner's choice in Field Visits, 2026-11-02).
d. **Close name** (one word different, transliteration Latin <-> Armenian): a guess only, waits.
e. Nothing: waits as "Unknown payer".

## 2. Outgoing lines (money out)
- To a supplier: the receiver's TIN / name = a supplier (KAD OS `suppliers`; Field Visits the purchase side) -> a supplier payment.
- Bank commission / fee (purpose words: commission, միջնորդավճար, комиссия): category bank fee (KAD OS "Other" until a category exists).
- Tax (receiver = the tax authority / treasury; purpose with tax words): "Tax".
- Salary (purpose salary / աշխատավարձ / зарплата): the staff payments ledger (KAD OS Staff > Payments matches person and month).
- Own transfer to cash / another own account: a Transfer (KAD OS category "Transfer": outside income / cost, moves both balances).
- Anything else: "Other", listed.

## 3. What an incoming payment pays
KAD OS (owner 2026-11-10/11):
- **A partner's or corporate customer's open receipts** (the partner visit receipts, the bank-transfer sales). Order of tries:
  1. the purpose names a receipt / invoice number (`#123`, `N 123`, `չեկ 123`, `հաշիվ 123`) of that customer and the amount equals its open amount -> automatic;
  2. one open receipt of that customer with exactly that open amount -> automatic;
  3. several open receipts whose open amounts add up exactly to the payment (oldest first, at most 10) -> automatic, one payment per receipt;
  4. otherwise (partial, over, no open receipt) -> waits; an overpayment is never split silently.
- The payment is added like Pay debt: method Փոխանցում (transfer), the bank date, details from the customer card (company, TIN), linked to the
  statement line. The receipt's "Invoice not sent" chip is separate (that is about the request to the accountant), the debt chip clears.
- Partners earn no bonus (lib/receipts.js `earn`): nothing extra to do.
Field Visits: the customer payment of `bankPayments.js` (a typed payment of the same customer and amount within 5 days is CONFIRMED, not
duplicated; a likely second copy waits).

## 4. How every line is recorded in Cash (KAD OS, after its cutover)
- Source **"Acba Bank"** (KAD OS `lib/categories.js` SOURCES spelling), the bank date, the signed amount, the purpose as Info, the payer /
  receiver as Customer, `origin` = bank + the line id (so it is not added twice and the line shows its entry).
- Category: a matched customer payment -> the receipt's own payment (do NOT add a second income entry: the receipt payment already counts in
  Cash via `cash_all`); fee / tax / salary / supplier / transfer as in 2; else "Other".
- Before the KAD OS cutover (Excel still the ledger): only reconcile with the workbook's Cash rows of source ACBA Bank (same signed amount
  within 3 days), list what is missing on each side; record nothing.

## 5. Confidence and the person's answers
Every waiting line shows: the payer as the bank wrote it, the guesses (customer + open receipts that fit), and the buttons: this customer /
not a customer (remember) / this cost category / separate payment / duplicate. An answer about a payer is remembered (1a). Each answer is
audited. Lines older than the cutover are shown, never applied.
