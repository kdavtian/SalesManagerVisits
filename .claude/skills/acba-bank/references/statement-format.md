# The ACBA statement file

Status (2026-11-11): the parser that reads bank statements already exists in Field Visits (`server/src/money/bankStatement.js`) and
understands English, Armenian and Russian header words. **The exact layout of ACBA's own Excel export is NOT yet confirmed from a real file**:
everything marked UNVERIFIED below must be checked against the first real export and this file updated (header words, sheet, number and date
formats, which columns exist). Ask the owner for one export when you start; keep it in the session scratch folder only.

## How the owner gets it
ACBA online banking (business) -> the account -> statement / transactions for a period -> export to Excel (`.xlsx`; CSV when offered).
Period: since the last export; overlapping periods are safe (lines are hashed, rule 2 of SKILL.md). UNVERIFIED: the menu names and whether
the export holds one account per file (the parser assumes one account per file; the uploader picks the account).

## What the reader expects (already implemented, Field Visits `bankStatement.js`)
- File: `.xlsx` (first sheet) or CSV with `,` `;` tab or `|`; text in UTF-8, UTF-16 (with BOM) or Windows-1251.
- The header row is found by its words, within the first 40 rows (bank exports often start with a title block: bank name, account,
  period, opening balance). Field -> words it recognises (lower case, punctuation ignored):

| Field | Words |
|---|---|
| date | date, booking / transaction / value / posting / operation date, ամսաթիվ, գործարքի ամսաթիվ, дата, дата операции, дата проводки |
| amount (signed) | amount, sum, transaction amount, գումար, сумма, сумма операции |
| debit (money out) | debit, withdrawal, paid out, money out, expense, դեբետ, дебет, расход |
| credit (money in) | credit, deposit, paid in, money in, income, կրեդիտ, кредит, приход |
| description | description, details, purpose, payment purpose, memo, comment, նկարագրություն, նպատակ, վճարման նպատակ, назначение платежа |
| counterparty | counterparty, beneficiary, payer, receiver, sender, partner, name, վճարող, ստացող, գործընկեր, плательщик, получатель, контрагент |
| reference | reference, document no / number, transaction id, փաստաթուղթ, փաստաթղթի համար, номер документа |
| currency | currency, ccy, արժույթ, валюта |
| balance | balance, running balance, մնացորդ, остаток |

- Either one signed Amount column, or Debit and Credit columns (amount = credit - debit).
- When the header is not recognised the upload sheet asks which column is which; that mapping is kept per account and used next time.
- Lines in a currency other than AMD / USD are skipped and counted; KAD OS takes AMD only.

## ACBA-specific checklist (fill from the first real file, then delete this line)
1. Sheet name and the row number of the header; the title block above it (account number, period, opening / closing balance cells).
2. The exact header words (Armenian? English? both?) -> add any missing one to ALIASES in BOTH apps' readers.
3. Amount: one signed column or Debit / Credit? Thousands separator (`1,234,567.00` / `1 234 567,00`)? `parseAmount` handles both, check.
4. Date: real Excel date cells or text (`11.11.2026`, `2026-11-11`, with time?). `parseDate` takes date cells, ISO `yyyy-mm-dd` and `dd.mm.yyyy` (also `/` `-`); a bare number (an Excel serial in a text column) is NOT read: add it if ACBA sends one.
5. Is the payer's TIN (ՀՎՀՀ) a column of its own, or only inside the purpose text? Is the payer's account number given?
6. Is there a running balance per line? Opening / closing balance cells for the balance check?
7. Fees: separate lines (bank commission) or netted into the transfer amount?
8. Card acquiring (POS) settlements: one line per day with the total, or per card payment? (KAD OS Card = ARCA source; ACBA POS lands where?)

## Values
- Amount: AMD, two decimals in the file, whole AMD in KAD OS (round half up only for display; keep the exact value in the line table).
- Date: the bank date (Yerevan). The payment / Cash entry takes this date, never the import date.
- Text: keep the purpose and counterparty exactly as given (they are the evidence); normalise only in the matcher.
