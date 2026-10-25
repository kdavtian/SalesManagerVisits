# Expense watch (Vaghinak -> Expenses tab)

Owner, 2026-10-25: "he has to analyze expenses as well and give me reports, recommendations" -- "cash expense in app (it should be the same Excel data). Weekly reports and live alerts".
Vaghinak reads the Excel cashflow (the trusted source) plus the reps' own cash expenses in the app and tells management what is growing, what looks odd and what to do. He never blocks or edits money.

Code: `server/src/expenseWatch.js`, `server/src/routes/expenses.js` (`/api/expenses`), tables in `migrations/152_expense_watch.sql`, tab in `client/public/js/views/vaghinak.js`,
the "In Excel / Not in Excel" mark in `client/public/js/views/cashExpenses.js`. Roles: admin, CEO, operations director, accountant. Runs hourly and right after each Excel cashflow sync (not in tests).

| Finding (`kind`) | Meaning | Default |
|---|---|---|
| `category_spike` | a category on course to cost much more than its 3-month average this month | projected >= 1.5x average and >= 300,000 AMD over, from day 7 |
| `big_entry` | one Excel entry far above that category's usual | >= 500,000 and >= 3x the category median, last 7 days |
| `duplicate_entry` | same date, amount and category twice | - |
| `app_expense_not_in_excel` | a rep's cash expense in the app that the Excel cashflow still lacks (same amount, +-5 days) | older than 5 days |
| `no_description` | a big entry without any description | >= 200,000 |
| `rep_cash_spike` | one rep's field cash expenses this week far above their usual | >= 3x usual and >= 100,000 |

- Numbers on the tab: this month so far / projected month / last month, 7 monthly bars, per category (3-month average, change %, share of sales), field cash by rep ("N not in Excel").
- Recommendations (codes `category_up`, `share_up`, `concentration`, `describe`, `app_not_in_excel`) are generated from the same numbers, in Armenian or English by the UI language.
- Weekly report: every Monday from 09:00 Yerevan one summary is saved (`expense_reports`) and pushed to management (type `expense_alert`, title "Շաբաթվա ծախսերը"). Findings are pushed as they appear.
- A finding can be dismissed on the tab (`POST /api/expenses/alerts/:id/dismiss`); one that no longer applies becomes `auto_resolved`.
- Reps see "In Excel" (green) or "Not in Excel · N d" (amber, after 5 days) on their own cash expenses; `GET /api/cash-expenses` returns `in_excel` and `days_old`.
