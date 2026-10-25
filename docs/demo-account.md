# Demo account

`server/scripts/seed-demo.mjs` creates one demo **sales manager** (`demo.rep@kadmotors.demo`) with believable data, for showing the app to someone:

- 26 customers around Yerevan: gold / silver / bronze, 8 potential customers (levels 1-4 with reasons), 2 competitors, every category, visited today / overdue / never visited.
- 27 check-ins, 15 orders in several statuses (real active products from the price list when there are some), 6 approved payments, 5 tasks, debt with real aging (unpaid invoices), this month's sales / plan.

The user is a sales manager, so the demo only ever shows its own data, never the company's real customers.

## Run (droplet)
```
cd /opt/field-visits && docker compose exec app node scripts/seed-demo.mjs
```
Add `DEMO_PASSWORD=...` in front (`docker compose exec -e DEMO_PASSWORD=... app node ...`) to choose the password; otherwise a random one is printed once. Running it again refreshes the data (it removes and recreates).

## Remove after the demo
```
cd /opt/field-visits && docker compose exec app node scripts/seed-demo.mjs --remove
```
Everything is tagged (e-mail ends `@kadmotors.demo`, ERP ids start `DEMO-`, sales row under the user's name), so nothing real is touched.

## Caveat
While the demo data exists, the management screens (admin, CEO, accountant: Home totals, debt, sales, orders, payments) include it. Remove it when the demo is over.
