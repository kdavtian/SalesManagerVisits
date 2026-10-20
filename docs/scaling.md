# Scaling: what was measured, what was fixed, what is still single-company

Measured on a separate database (`fv_scale`, never real data) seeded with 40,000 customers, 5,000 products, 600,000
ERP order lines, 100,000 app orders (300,000 items) and 200,000 check-ins (332 MB). The app, Postgres and the load
generator shared one 4-core machine. Today's company is about 500 customers, so the customer count of that test is
roughly 80 times today's and the order volume roughly 10 times.

## Measured before / after (1.373.0)

| Screen | Before | After |
|---|---|---|
| Customers list, first customers on screen | 1.8 s (whole list, 34 MB) | 34 ms (first 500), rest streams in behind it |
| Customers list, every page | one 34 MB request | 81 pages, each 35-40 ms, same rows in the same order |
| Customer pickers (order, payment, task) | whole list, then the first 8-30 cut on the phone | the server returns only those 8-30 |
| Home dashboard | 650 ms | ~170 ms |
| Products list | 0.96 s | 0.29 s |

Unchanged and fine: orders list (8 ms, paged + indexed), orders of one customer (5 ms), customer search (70 ms).
About 290 simple requests per second with 50 or 200 people at once, no errors.

## Conventions this introduced

- `GET /api/customers?limit=500&after_name=<last name>&after_id=<last id>`: pages ordered by `(name, id)` (index
  `customers_name_id_idx`, migration 132). A deep page costs the same as the first. `offset` still works for "skip N".
  Without `limit` the whole list comes back (the Map and route planning need every customer).
- The Customers screen paints the first page at once and adds the rest behind it; a cached list that is already showing
  is left alone until every page is in (so it never shrinks to 500 for a moment).
- Anything that is the same value for a whole list is computed once with a grouped query, not once per row
  (`reserved_qty` on products, "overdue" on the dashboard). A correlated subquery per row is the usual cause of a slow
  list as the data grows: check with `EXPLAIN (ANALYZE, BUFFERS)` on seeded data.

## Not done yet (each needs the owner's go-ahead; none matters at today's size)

- Debt balances, Sales and the warehouse staging list still read everything at once (1.0 s / 0.9 s / 0.4 s at the test
  size; most of that came from the test having 13,000 customers with debt and 20,000 open orders).
- The Map still loads every customer (needs viewport loading beyond ~10,000 customers).
- Customer search is a `%word%` scan of every row (70 ms at 40,000, seconds at 1,000,000): needs trigram indexes.
- Row ids on the big tables are 32-bit (`checkins`, `erp_order_lines`, `orders`): they run out at 2.1 billion rows.

## What stops this from being a multi-business (SaaS) product today

1. One company only: no tenant column anywhere, global `app_settings` / `company_profile`, user emails unique across the database.
2. Roles are flat (own data or everything): no team / territory hierarchy for managers.
3. One server process: nine in-process timers with no cross-server lock (two servers would send every reminder twice),
   photos on the server's disk, rate limits in memory, one DB query per request for the session check.
4. Local rules are hard-coded rather than settings: sales channels (KF, CAS, CVO, PCO, OEM), Yerevan time zone, AMD, VAT, hy/en.
5. Excel is still the source of truth for ERP data (a bot, a workbook, a 1-million-row ceiling).

Options for several businesses (owner decides; recommendation is A first):
A. one database per business (least rewrite; deploys run migrations once per business),
B. one shared database with a business id on every table plus Row Level Security (the usual SaaS model; touches every query).
