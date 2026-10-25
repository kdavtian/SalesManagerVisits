# Desktop Home KPIs, Payments and Sales tables (1.415.0)

Owner, 2026-10-25 (desktop only, >= 1024 px): "desktop Home = a KPI dashboard instead of duplicating the menu; Payments and Sales as tables; Team performance stays as it is".

- **Home** (`client/public/js/views/homeKpis.js`, `GET /api/dashboard/kpis`, `server/src/dashboardKpis.js`): for admin, CEO, operations director, sales director and accountant the menu tiles are hidden on desktop (the sidebar has them) and five tiles show the company's numbers, each a link to the page where it is handled:
  sales this month next to the same days of last month (workbook order lines, customer 10000 "Inventory" left out), customers owe (+ the late part, FIFO aging as on Debt balances),
  payments not in the Excel (app payments older than 3 days with no matching cashflow row, same rule as the Payments page and anti-fraud), orders waiting (to confirm / pack / deliver), open tasks (+ overdue).
  One request, cached a minute on the server and shown from the local cache first. Phones keep the tiles and never request the numbers.
- **Payments** and **Sales** pages are sortable tables on desktop (same look as Debt balances: `deskTable.js` headings, `.dtl-*` rows in `desktop.css`). Payments: date, customer (+ ID), collected by (+ channel), status, in the Excel, amount, Approve on the row;
  only the date heading sorts (the list is paged by the server). Sales: date, customer, order, channel, liters, payment (late chip + unpaid amount), amount; headings sort the loaded rows, day groups stay in date order.
- Team performance was not touched.
- Tests: `dashboardKpis.test.js`, `home-kpis.spec.mjs`, `desktop-tables.spec.mjs`.
