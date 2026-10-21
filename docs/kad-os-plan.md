# KAD OS - plan (for the KAD-GMM app, NOT for this repo)

Owner decision (2026-10-18): the business-operating-system idea is built in **KAD-GMM**, tested first on the GMM shop and
workshop, then renamed **KAD OS** and given to wholesale clients as their ERP. This file only records the plan; this app
(KAD Field Visits) stays the distributor's internal tool. Read together with `docs/ROADMAP.md` in the KAD-GMM repo.

## 1. What GMM already plans that a garage or oil-change shop needs (reuse, do not rebuild)
| KAD OS module (idea of 2026-10-18) | Already in the GMM roadmap |
|---|---|
| POS / sales receipt, discounts, split payments, debt | P2 sales process |
| Customers + vehicles (plate, VIN, mileage) | P1 customers with several cars, standardised plate/VIN/phone |
| Inventory, stocktaking, loose litres from drums | P3 purchases and warehouse (D7) |
| Workshop jobs (in -> diagnose -> approve -> repair -> ready -> out) | P2 jobs with car in/out, master, "free service" control |
| Employees, payroll, attendance | P5 staff and timetable |
| Finance, cash, profit, dividends | P4 cash and reports |
| Bonus / referral | P2 bonus engine |
| Audit trail, backups, roles | principles 2, 5, section 6 |

## 2. What is missing for "give it to other businesses" (the real work after GMM works)
1. **Multi-tenant**: today one company, one database. Needs a tenant id on every table (or one schema per client), per-client
   branding/settings, per-client users, and tenant-isolation tests (one row-level mistake leaks a competitor's customers).
2. **Ordering from KAD** (built 2026-10-21, see `docs/kad-os-link.md`: partner account per client, app-order perks, campaigns, progress) (the reason clients adopt it): "You have 3 Magnatec 5W-30 left - reorder 12?" creates a real order in
   KAD Motors' app. GMM is already ERP customer 10001; generalise this into an API key per client (the Lily integration
   pattern), using KAD's price tier for that client.
3. **Onboarding**: import the client's Excel/1C/stock list (GMM's importer is the template), 30-minute first-day setup, a demo
   tenant with synthetic data.
4. **Support and operations**: backups per tenant, monitoring, update policy (one release for all), a way to look at a client's
   problem without seeing their data (audited impersonation).
5. **Commercial model**: free while the client buys from KAD ("Basic"), paid or purchase-threshold "Pro" with AI features.
   Needs a per-tenant entitlement flag and a monthly purchase-volume check from the KAD ERP. Decision for the owner.
6. **Hosting**: the droplet is 1 GB. A handful of tenants is fine; plan 4 GB+ before onboarding several (see GMM docs/SCALE.md).

## 3. AI inside KAD OS
- **AI business assistant (Claude)**: the same pattern as KAD AI here (read-only data tools, names replaced by codes, monthly cap):
  daily owner briefing ("revenue yesterday, 3 overdue customers, 2 products about to run out, 12 customers due for service, suggested
  KAD order"), purchase suggestions within a budget, profit by product/customer/employee.
- **Oil finder (OpenAI, owner's choice)**: the model must NOT guess oil specs from memory. Pipeline:
  vehicle (plate/VIN/brand-model-year-engine) -> specification database (viscosity, ACEA/API/OEM approvals, capacity) ->
  KAD/GMM product database (which Castrol/Lotos/Royal product meets it, stock, price) -> the model only explains and ranks.
  **The hard part is the specification database, not the AI.** Options, cheapest first: (a) GMM's own history (every sale
  already pairs a car with the oil that was poured) gives a verified starter table for the cars Armenia really has; (b) the
  product approvals already stored on KAD products (`products.approvals`) matched to the car's required approval; (c) a licensed
  OEM/aftermarket data provider (cost and licence to be checked). Start with (a)+(b) on the top ~300 models, flag every gap for a
  human to confirm, and never show a recommendation without its source.
- **Customer reminders**: service-due messages (SMS/Viber/Telegram) built from vehicle + mileage + last oil change; this is the
  feature that brings garage customers back and sells more KAD oil.

## 4. Order of work
1. GMM P1-P6 as planned (pilot on the shop, Excel retired). Nothing multi-tenant yet; keep tenant-ready habits (no hard-coded
   company names, settings in tables, every query through one data layer).
2. "Productise": tenancy + isolation tests, onboarding importer, per-client branding, entitlement flag, backups per tenant.
3. KAD ordering link (reorder suggestions -> order in the KAD app) with 3 friendly wholesale clients as design partners.
4. AI: briefing + purchase suggestions (Claude), then the oil finder (OpenAI) once the specification table has real coverage.
5. Commercial launch to all wholesale clients.
Each step ends with a demo to the owner and a measurable result (hours saved per day, reorders placed through the app, liters sold
to clients using KAD OS vs not).

## 5. Open questions for the owner
1. Pricing: free for everyone who buys from KAD, free above a monthly purchase threshold, or always paid? Which threshold?
2. Should a client be able to buy other brands through KAD OS (supplier marketplace), or only KAD products at first?
3. Who supports 20+ clients (your time vs a person), and in which hours?
4. Which 3 wholesale clients would pilot first?
5. Is the GMM data allowed to seed the oil-specification table (it is your own shop's history; clients' data must never be mixed in)?
