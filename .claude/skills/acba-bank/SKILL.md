---
name: acba-bank
description: Reading and integrating ACBA Bank (Armenia) account statements in the owner's KAD apps - how a statement is exported, how its lines are recognised (date, signed amount, payer / receiver, TIN in the purpose text, document number, running balance), how each incoming transfer is matched to a customer, a partner or corporate invoice or a debt and recorded as paid, how every line lands in Cash as the "Acba Bank" source so the app's ACBA card equals the bank, and how double imports, unknown payers and a statement that does not reconcile are handled. Use whenever a task touches a bank statement, ACBA, bank transfers (Փոխանցում), invoice payments arriving from partners (Karkom, Karkomavto, Master Service, Nissan Service) or corporate customers, the ACBA balance in KAD OS, or customer debt payments by transfer in Field Visits; also when the owner says "bank statement", "քաղվածք", "выписка", "ACBA", "match payments", "who paid". Covers KAD OS (kdavtian/kad-gmm) and KAD Motors Field Visits (kdavtian/SalesManagerVisits). Companion to KADDev (how to build and ship) and kadprocesses (who does what).
---

# acba-bank - ACBA statements: read, recognise, match, record

Owner decisions (2026-11-11): one skill for **both apps**; statements arrive as the **Excel export from ACBA online banking** (uploaded in the
app, later posted to a Telegram group like the GMM workbook); every matched incoming transfer **marks the invoice / debt paid** and every
line is **recorded in Cash as the ACBA source**. A PDF statement or a direct bank API is NOT the plan (PDF layouts break; an API needs ACBA's
agreement): do not build them without a new owner decision.

Read this file, then the reference you need:

| Need | Open |
|---|---|
| What an ACBA export looks like, the header words, numbers, dates, the checklist for a new file | `references/statement-format.md` |
| Who paid a line and what it pays: TIN, names, invoice / receipt numbers, the confidence levels | `references/matching.md` |
| What already exists in Field Visits (working code) and the plan to bring it to KAD OS | `references/apps.md` |

## Hard rules (both apps)
1. **A statement is private business data.** Never commit a statement file, a line, an account number, a TIN or a payer name to a repo, a
   test fixture, a doc, a PR or the chat. Tests build their own fake lines (`Itest ... LLC`, TIN `0000xxxx`). Uploaded files live outside the
   repo (`data/`, `inbox/`: gitignored) and are kept only as long as the import needs them.
2. **Never twice.** A statement read again, or an overlapping one (Jan 1-31 then Jan 15 - Feb 15), adds nothing new: every line gets a stable
   hash (account + date + signed amount + currency + reference + text + balance + its order among identical lines of the file) with a unique
   index. One line pays at most one thing (unique index on the line in the payment table).
3. **The app decides only when it is sure.** Exact TIN of a known customer + an amount that fits one open invoice = automatic. Everything else
   waits in an "Unspecified" list for a person (the accountant / CEO / admin) with the best guesses offered; the person's answer is remembered
   for that payer (`bank_payers`-style rule), so the same payer is automatic next time.
4. **Never invent money.** A line is recorded with the statement's own date, signed amount and text. Outgoing lines are costs or transfers
   (see `references/matching.md` 4); a line the app cannot classify is recorded under "Other" and listed, never dropped.
5. **The balance proves it.** After an import, the app's ACBA balance for the statement's last day must equal the statement's closing
   balance. A difference is shown at once with the lines that explain it (missing day, a line ignored, an opening balance not set); it is
   never "fixed" by a silent adjusting entry.
6. **Excel is still a ledger until each app's cutover.** Before cutover a bank line and its Excel Cash row are the SAME money: match them,
   never add both (Field Visits already does this: `matchLines`, same signed amount within 3 days). After cutover the statement is the
   source for the ACBA account.
7. **Roles on the server.** Upload and decisions: accountant / CEO / admin (Field Visits), CEO / admin (+ manager read) in KAD OS; a seller
   never sees bank lines. Every decision is in the audit log.

## The flow (target, both apps)
1. Someone exports the statement in ACBA online banking (Excel; period = since the last export, overlap is fine) and uploads it
   (app: Cash -> Bank -> Upload; later: posts it to the bank Telegram group and the bot imports it).
2. The app reads it (`statement-format.md`): finds the header row by its words, one line per transaction, signed amount, AMD only
   (another currency: counted and skipped), shows a preview (period, lines, how many already imported). Nothing is saved before "Import".
3. Each new line: who paid / who was paid (`matching.md` 1-2), what it pays (3), how it is recorded (4).
4. Automatic results are applied in the same transaction as the import: the invoice / debt gets its payment (method Փոխանցում / transfer,
   date = the bank date), the Cash ACBA entry is created and linked to the line, the "Invoice not sent" / debt chips update.
5. The rest waits in "Unspecified" with one-tap answers (this customer / not a customer / a cost of category X / separate / duplicate).
6. The import ends with the balance check (rule 5) and a one-line summary: lines, new, matched automatically, waiting, closing balance OK.

## Before building anything in this area
- Run KADDev (and kad-edit: money = size L, usability gate class C).
- Look at the real file first: ask the owner for one ACBA export (it stays in the session's scratch folder, never in the repo) and fill the
  checklist in `statement-format.md`; the header words there are the ones the parser already knows plus ACBA's to confirm.
- Reuse, do not rewrite: Field Visits' reader (`server/src/money/bankStatement.js`) and payer matcher (`server/src/money/payments2/payerMatch.js`)
  are tested and pure; KAD OS copies them (same behaviour, adapted imports), it does not invent a second parser.
