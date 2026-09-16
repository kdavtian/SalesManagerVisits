# ERP integration

This app is the operational/field side (check-ins, orders, payments,
delivery). Actual invoiced revenue, product debt balances, and sales
performance numbers are owned by the company's ERP system (Castrol's), and
arrive here as a periodic bulk push — the app never writes back to the
ERP, and never calls out to it directly.

For the exact JSON payload shape of each endpoint, see
[`erp-sync-contract.md`](erp-sync-contract.md). This doc covers the parts
that contract doesn't: who owns the pipeline, how often it runs, what
happens on failure, and how the numbers get reconciled.

## Ownership

The sync pipeline (`ceo_agent.py` / `work/sync_field_visits.py`) is an
**external Python project** (`castrol_ceo_report`), not part of this repo.
It reads the company's Castrol Excel export, transforms it, and pushes it
to this app. Anyone changing the payload shape, transform logic, or push
schedule needs to touch that repo, not this one — this app is a receiver,
not a participant in that pipeline's own code or scheduling.

## Direction and mechanism

**Inbound push, not a pull.** The ERP bot calls three endpoints on this
app, authenticated with a shared secret header (`X-Sync-Key`, matched
against `ERP_SYNC_KEY` — see [`configuration.md`](configuration.md)):

| Endpoint | Pushes | Semantics |
|---|---|---|
| `POST /api/erp-sync` | Customer debt/ERP-linkage data, order lines, sales performance, products, brand volume | **TRUNCATE-and-replace** per table — each push is a full snapshot, not a delta. |
| `POST /api/erp-sync/daily-report` | The CEO's daily summary numbers | Upserted by date. |
| `POST /api/erp-sync/reports` | Generated report files (Sales Director workbook, debt/receivables Excel, CEO management workbook) | Stored as-is in `generated_reports.file_data`, never parsed by this app. |

If `ERP_SYNC_KEY` is unset, all three endpoints reject every request —
sync is opt-in, not silently broken.

## Frequency

The push schedule is entirely the external bot's decision (this app has
no scheduler that pulls or expects a sync on a fixed cadence) — in
practice, roughly daily, whenever the bot's own run reads a fresh Excel
export. This app doesn't assume any particular frequency; it only tracks
**how long it's been** since the last successful sync per table
(`erpSyncFreshness.js`), and alerts if that gap gets too large (see
Retries and staleness below).

## Retries and staleness

- **The app does not retry pushes itself** — it's a passive receiver.
  Retry behavior, if any, is the external bot's responsibility.
- **TRUNCATE-and-replace makes a retry safe by construction**: if the bot
  re-sends the same (or a corrected) snapshot, the app just replaces the
  table again — there's no partial-write or duplicate-row risk from a
  retried push.
- **Staleness monitoring** (`server/src/erpSyncMonitor.js`): checks hourly
  whether the most recent `synced_at` timestamp on any ERP-sourced table
  is older than `ERP_STALE_AFTER_HOURS` (72 hours). If so, it notifies
  admin/CEO — the deliberate signal that "the pipeline looks broken", not
  just "the number is a bit old" (a few days between syncs is normal for
  this business). The same freshness check also badges reports in the UI
  as stale (`GET /api/reports` and friends), so a viewer sees it too, not
  just an admin notification.

## Reconciliation

ERP data (invoiced revenue, debt balances) and this app's own operational
data (submitted orders, collected payments) are **two independent
sources of truth that get compared, not merged**:

- **Debt Balances** and **Sales** screens show the ERP's own numbers
  directly (see `docs/erp-sync-contract.md` and `sales.js`'s own header
  note: "ERP-invoiced revenue, not the app's own order pipeline").
- **Payments** collected through the app go through their own review/
  custody chain (see [`docs/roles-permissions.md`](roles-permissions.md)
  and `server/src/routes/payments.js`) and are marked
  `approved`/`rejected`/`pending` independently of anything the ERP says.
  An accountant reconciling the books compares the two — the app doesn't
  attempt to auto-match an ERP-reported payment against an app-recorded
  one.
- There is currently no automated cross-check flagging a mismatch between
  what the app's payment records say and what the ERP eventually shows —
  reconciliation is a manual, human step done by the accountant against
  both sources. Worth revisiting if/when payment volume makes manual
  reconciliation error-prone; not tracked as a risk-register item today
  since it's the accepted, working process.

## Debugging a sync issue

See ["Quick way to tell which side the problem is on"](erp-sync-contract.md#quick-way-to-tell-which-side-the-problem-is-on)
in the contract doc.
