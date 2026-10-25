# Anti-fraud watch (Vaghinak -> Anti-fraud tab)

Owner, 2026-10-25: "there is a very high risk that sales reps collect cash and do not record it in the app". Vaghinak watches for the signs;
management (admin, CEO, operations director) decides. Nothing here blocks a rep or changes money.

Code: `server/src/antiFraud.js` (detectors, risk score, learning, weekly check calls), `server/src/routes/antiFraud.js` (`/api/anti-fraud`),
tables in `migrations/151_anti_fraud.sql`, tab in `client/public/js/views/vaghinak.js`. Runs every hour and right after each Excel sync.

| Kind | What it means | Default limit |
|---|---|---|
| `payment_not_in_excel` | recorded in the app, still not in the Excel cashflow (same customer, same amount, within 5 days) | after 3 days |
| `cash_held_long` / `cash_held_amount` | a rep (or director) holds unhanded cash (payments `pending`, not in a handoff) | older than 3 days / more than 1,000,000 AMD |
| `customer_dispute` | a KAD OS customer pressed the red "I don't see my payments" button (`POST /api/partner/payments/dispute`); management is told, the rep is NOT, and the app offers the office number to call | - |
| `cash_gap` | the rep records far less than their cash-term (`payment_term_days = 0`) deliveries of the last 30 days suggest, next to the median of the other reps | below 50 % of the peers |
| `late_recorded` | recorded more than 2 days after the collection date | 2 days |
| `burst` | 5 payments by one person within 10 minutes | 5 / 10 min |
| `repeated_amount` | the same round amount (multiple of 50,000) 4 times in 30 days, 3+ customers | 4 |
| `spot_check_mismatch` | the weekly check call found that the customer says something different | - |

- Every finding has a severity 1-3 and a status: `open`, `confirmed`, `false_alarm`, `auto_resolved` (the condition is gone: the payment reached the Excel, the cash was handed over).
- Risk score per rep (0-100) = open and confirmed findings of the last 60 days x weight x severity/2 (confirmed x1.5). Levels: low < 25, medium < 60, high.
- **He learns:** a verdict Confirmed multiplies that kind's weight by 1.2 (max 3x), False alarm by 0.8 (min 0.25x) (`fraud_signal_weights`).
- Weekly check calls: 5 payments (leaning toward riskier reps and bigger amounts, max 2 per rep, no customer called in the last 4 weeks) with the customer's phone; the
  result buttons are "confirms", "does not match" (becomes a severity-3 finding) and "no answer".
- Limits are editable by admin / CEO / operations director on the tab (`fraud_settings`).
- Notifications use the `fraud_alert` type: one combined push per run to management, and a plain "hand over your cash" reminder to the rep who holds it.
