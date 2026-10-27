# Desktop version: optimization roadmap

Owner, 2026-10-27: "start optimizing the desktop version. It can have much more functionality than the mobile app and it is ok. It can
have more filters, more information visible. Use screen size optimally so that it is much more convenient to use."

This file is the plan. Each step is one PR; tick the box when it is merged and write the version. Keep the phone untouched: every
change here lives inside `@media (min-width: 1024px)` (`client/public/css/desktop.css`) or behind `isDesktop()` checks, and the phone
tests must stay green. A desktop window is >= 1024 px; the three-pane layouts below need >= 1400 px (`dockSheet.js` WIDE), between
1024 and 1399 px the page keeps today's two-pane form.

## Audit (1440 x 900, admin, 2026-10-27)

What is already good: the sidebar with every page on one screen, tables for Orders / Activity / Customers / Tasks / Payments / Sales /
Debt, the Home KPI tiles, the Map with its side list, Settings as sidebar + page, an order / task opening as a panel docked to the right.

Issues found (I = issue, each has its fix in the steps below):

- I1. **Half the window is empty on most pages.** Customers, Orders, Activity, Tasks, Documents, Cashflow and Staff stretch one list to
  1180 px and show nothing beside it. The row itself holds 3-4 facts; the rest of the width is white.
- I2. **Filters are hidden behind icons.** The phone's filter icons (people / status / sort) are kept on the desktop, where a mouse and
  the width allow the filters to be visible as dropdowns and chips in one row.
- I3. **One click too many to see a thing.** A customer, an order, a visit or a task opens only after a click, and the panel (>= 1400 px)
  or the dialog hides what was behind it. There is no preview on hover, no keyboard navigation (arrows / Enter / Esc).
- I4. **Phone-sized controls on a desktop page.** "Add a person" is a 1160 px wide button (Staff), "Cash handovers" the same (Payments),
  the Documents page has two native `<select>` boxes 575 px wide. The tip toast ("hold the New order button") belongs to touch only.
- I5. **The customer card uses 2 of 3 columns.** The left column ends after the action tiles; visits, orders, payments and files are a
  click away each (sheets), although the window has room for all of them side by side.
- I6. **Reports is a phone list.** Twelve rows with chevrons on a 1180 px page; a report opens as a page, not beside the list, and the
  period / rep filters are inside each report, not shared.
- I7. **No bulk work.** Payments has an Approve button per row, Orders has print selection, nothing else can be done on several rows
  at once (assign, confirm, export, tag).
- I8. **No column choice, no density, no export.** Tables show a fixed set of columns; the accountant cannot add "ERP ID", "channel",
  "phone", and nothing downloads as Excel / CSV from a table (only the fixed reports do).
- I9. **Top bar is empty.** 1200 px of white with the user's name, bell and menu at the far right; no global search, no quick actions.
- I10. **Sidebar MORE is a long flat list** (16 items): Warehouse appears twice (app + page), Delivery / Driver app / Warehouse app
  belong to other roles. No grouping, no collapse, no keyboard shortcut hints.
- I11. **Map:** the side list is a bare name + badge; no columns (channel, debt, last visit), no sort, no "visible on map only" link,
  and the pin key is a bottom sheet designed for a phone.
- I12. **Dashboards are vertical.** Home KPIs are five tiles in two columns with the right 40 % empty; Team performance, Dashboard and
  Cashflow stack their cards instead of using a 3-4 column grid.
- I13. **No keyboard.** "/" to search, "n" new, Esc to close, arrows in tables, Enter to open: none exist. Every power user on Windows
  expects them.
- I14. **Desktop is not tested enough.** Four e2e specs cover tables / panel / sheets / review; nothing checks the layout above 1400 px
  or the new filters. Screenshots of every page at 1440 and 1920 px should be in CI (`desktop-shots.spec.mjs`), not in the scratchpad.

## Principles for every step

1. Same data, same server routes: a desktop step adds columns and filters the API already returns, or adds `?fields=` / a new
   filter parameter in a backward-compatible way. No desktop-only tables.
2. Three panes above 1400 px: **sidebar | list | detail**; the detail pane is the docked sheet that already exists (`dockSheet.js`).
   The list keeps the selected row highlighted (`.row-open`), arrows move the selection, Enter opens, Esc closes.
3. One shared table engine (`deskTable.js`): sortable headings, column picker (per page, saved in `localStorage`), density
   (comfortable / compact), sticky header, row count, CSV export of the loaded rows, multi-select with a checkbox column and a
   bulk-action bar. Pages opt in; the phone never loads it.
4. Filters visible, not hidden: one filter row with dropdown chips (`filterIcons.js` labels become visible text), active filters as
   removable chips, a "Clear" link. The phone keeps its icons.
5. The owner's taste: compact, calm, iOS-like; no new colours; amounts right-aligned whole AMD; Armenian first.
6. Each step ships with: its e2e spec at 1440 px, screenshots looked at (1440 and 1920), phone smoke green, version bump.

## Steps (in order; each one PR)

### Step 1. Table engine + Customers page (the template for the rest) — I1 I2 I7 I8 I13
- [x] `deskTable.js`: column picker (gear at the end of the heading row), density toggle, sticky header, "N rows" footer, CSV export
      (loaded rows, UTF-8 BOM so Excel opens Armenian), checkbox column + bulk bar, arrow / Enter / Esc keys.
- [x] Customers table columns: customer, ID, channel, rep, tier, potential level, last visit, next visit, debt (if visible to the role),
      phone, region, added. Default set as today + rep + debt; the rest in the picker.
- [x] Filter row: Rep, Channel, Tier, Visit status, Region (accordion tree), Potential level; chips of the active ones; "Clear".
- [x] Bulk: assign rep (canReassignCustomers), export CSV.
- [x] Row click opens the customer card in the right pane (>= 1400 px) instead of leaving the list; the list keeps its scroll.
- Spec: `desktop-customers.spec.mjs`.
- As built (1.441.0): the filter row keeps the app's existing filter groups as labelled dropdown buttons (Direction & manager,
  Region, Potential, Customer type & tier, Products) with a chip per chosen value and Clear; the visit-status pills above the
  search stay the "Visit status" filter. Beside a docked card (>= 1400 px) the list keeps Customer, Last visit and Debt only.
  Density (comfortable / compact) is one setting for every desktop table. Ctrl/Cmd-click on a row still opens the full page.

### Step 2. Orders + Activity + Tasks on the same engine — I1 I2 I3 I7
- [x] Orders: columns customer, ID, order code, rep, channel, status, payment method / term, liters, amount, created, delivered,
      documents; filters Status, Rep, Channel, Period, Payment method, "needs attention"; bulk confirm (canConfirmOrders), bulk print
      blanks (exists), export.
- [x] Activity: columns customer, rep, date / time, duration, outcomes (icons + text), order amount, collected, distance / verified;
      filters Rep, Outcome, Period (exists), Verified; export. Visit opens in the right pane (`visitDetail.js` docked).
- [x] Tasks: columns task, type, customer, person, created by, due, status, progress; filters Person, Type, Status, Period; bulk
      reassign / cancel for the creator roles.
- Spec per page: `desktop-orders.spec.mjs`, `desktop-activity.spec.mjs`, `desktop-tasks.spec.mjs`.
- As built (1.442.0): one `createDeskTable()` instance per page (deskTable.js) now carries the head, cells, foot, selection and
  keys for Customers, Orders, Activity and Tasks. Orders: the checkbox column feeds the same selection as the phone's long
  press, so the floating action bar (confirm / reject / deliver / approve / print) is the one bulk bar; Rep and Period go to
  the server (`user_id`, `from`, `to`), Channel / Payment / Needs attention narrow the loaded page. Activity: a visit opens
  docked (`visit:<id>`); Duration comes from `ended_at`. Tasks: bulk Reassign / Cancel (creator or a see-all role; one PATCH
  per task) and a Due filter (overdue / today / this week / this month).

### Step 3. Customer card in three columns — I5
- [x] >= 1400 px: left = facts + actions + products at this shop; middle = visit history (full rows, not 30 + button); right = orders
      (app + Excel in one list), payments, files (thumbnails), tasks. All from the bundle `customerCardLoader.js` already loads.
- [x] Sheets that still open (edit, payments list, files) dock to the right instead of covering the card.
- [x] The map of this customer (small, static, pin + nearby customers) under the facts.
- Spec: `desktop-customer-card.spec.mjs`.
- As built (1.443.0): `customerWide.js` moves the card's existing blocks into three columns on a window of 1400 px and more and
  puts them back below it (the phone order never changes); the right column adds Orders (app orders Excel does not have yet +
  the Excel orders of the last 3 months, 8 rows, "View all" opens the orders page), Payments received (6 rows + total) and Files
  (thumbnails). The middle column loads the whole visit history at once, each row with its outcomes and collected amount.
  Payments, files, an Excel order, Edit and Account settings dock to the right and take the right column's place. The mini map
  (Leaflet, no dragging) shows this customer and the customers within about 1 km; "Show on map" opens the Map. Inside the
  narrow customer panel beside the Customers table nothing changes, and a sheet opened there stays a dialog on top of it.

### Step 4. Top bar: global search + quick actions + keyboard — I9 I13
- [x] A search box in the top bar (customer, order code, ID, phone), "/" focuses it, results in a dropdown grouped Customers / Orders /
      Tasks; Enter opens the first.
- [x] Quick actions on the right: New order, New task, New customer (role-gated), with the keyboard hints (n o / n t / n c).
- [x] Esc closes the top-most sheet / panel everywhere (one listener in `app.js`).
- Spec: `desktop-topbar.spec.mjs`.
- As built (1.444.0): `deskTopBar.js` (loaded only on a desktop window; not for the warehouse / driver shells). Customers come
  from the existing customer search (name, ID, TIN, phone digits, address...), orders from a new `q` + `limit` on
  `GET /api/orders` (order code, customer name, customer ID), tasks from the open tasks this person sees (cached a minute). The
  search starts at 2 letters; arrows move, Enter opens. New order opens the customer picker on the Orders page
  (`#/orders?new=1`), New customer the Map's add mode, New task the task editor (task-creating roles only). On a desktop window
  between 1024 and 1365 px the action buttons show icons only. Esc: one listener in `app.js` removes the top-most sheet when
  nothing else (a sheet's own Esc, a menu, the search box) has handled the key.

### Step 5. Sidebar grouping and role cleanup — I10
- [x] MORE grouped: Sales (Vaghinak, Team performance, Sales, Reports), Money (Payments & expenses, Debt, Cashflow, Accounting),
      Operations (Delivery, Warehouse, Documents, Products), Admin (Staff, KAD AI, Dashboard). Groups collapse, state remembered.
- [x] Driver app / Warehouse app entries only for the roles that use them; "Warehouse" once.
- [x] Collapsed sidebar (icons only) at 1024-1279 px, full from 1280 px; a toggle remembers the choice.
- Spec: `desktop-sidebar.spec.mjs`.
- As built (1.445.0): groups in `SIDEBAR_GROUPS` (app.js): Sales (Vaghinak, Team performance, Sales, Reports, Route plans,
  Bonuses), Money (Payments & expenses, Debt balances, Cashflow, Accounting, Recorded), Operations (Delivery, Warehouse,
  Returns, Documents, Products), Admin (Staff, KAD AI, Dashboard); a tile not named there lands in a last "More" group. A
  folded group still shows the page that is open (CSS, no rebuild). Folded groups: `fieldvisits_sidebar_folded`; icons-only
  mode: `fieldvisits_sidebar_mode` (auto / collapsed / full), toggle in the logo row. The "(new)" warehouse and driver apps
  stay on the Home grid only. Role shells (warehouse, driver) keep their short full sidebar with no toggle.

### Step 6. Reports as sidebar + report — I6
- [x] Reports page = left list of reports (grouped as today), right the chosen report; the period row and the rep / channel filters
      shared above the report; last opened report remembered.
- [x] Every table report gets Export (CSV / Excel) and Print.
- Spec: `desktop-reports.spec.mjs`.
- As built (1.446.0): `reportsDesk.js` wraps the existing reports (each report is still drawn by `reports.js` / `bizReports.js` /
  `fuelReport.js` / `volumeReport.js`, now into the right pane). `#/reports` opens the last report (or the first) and renames
  the address to `#/reports?r=<key>` without drawing twice. The reports have no common rep filter, so the filters that travel
  are the ones they share: period, month, region and sales channel (kept for the browser tab, applied only where the next
  report has the same filter and the same choice). Export = a CSV (UTF-8 BOM) of what the report shows: headings as rows, each
  card or table row as a row of its texts. Print = the browser's print with a print stylesheet that keeps the report only.
  Phones keep the list -> report pages.

### Step 7. Dashboards use the width — I12
- [ ] Home KPIs: one row of 5 tiles, under it two columns: "Needs attention" (orders waiting, unconfirmed payments, overdue tasks,
      payments not in Excel: each row a link) and "Today" (team today, planned vs done per rep, a small map of today's visits).
- [ ] Team performance / Dashboard / Cashflow: 3-4 column grids above 1400 px, charts side by side, no page longer than two screens.

### Step 8. Map for the desktop — I11
- [ ] Side list as a table (customer, channel, debt, last visit, planned today) sortable, "only the visible area" toggle, click = pan +
      open the popup; the popup gains the Last order and Debt lines it has on the card.
- [ ] Pin key as a right panel (not a bottom sheet) above 1400 px; filters row above the map instead of the icon buttons.

### Step 9. Forms and small controls sized for a mouse — I4
- [ ] Wide-page buttons ("Add a person", "Cash handovers", "Import Excel") become normal-width buttons in the header row.
- [ ] Native `<select>` boxes replaced by the same dropdown chips as the tables (Documents, Staff, Settings forms).
- [ ] Touch-only tips (hold-to-open) hidden with a pointer: fine; hover tooltips with the full text on truncated cells.
- [ ] Date inputs: the wheel picker stays on touch, a keyboard-typable date + calendar popover on the desktop.

### Step 10. Desktop in CI — I14
- [ ] `desktop-shots.spec.mjs`: every main page at 1440 and 1920 px, artefacts kept by the nightly workflow.
- [ ] Layout assertions: no element overflows the window, the right pane never covers the selected row, sticky headers stay.

## Improvement ideas beyond the steps (ask the owner before building)

- A1. Saved views per user ("my overdue Gold customers", "orders to confirm this week"): a name + the filter set, in the sidebar.
- A2. Two windows: open a customer / order in a new browser tab with Ctrl+click (deep links exist: `#/customers/:id`, `#/orders?open=`).
- A3. Print-friendly stylesheet for any table (Ctrl+P prints the visible table, not the app shell).
- A4. Inline editing in tables for the admin (rep, channel, tier) with the same server rules as the edit sheet.
- A5. Side-by-side compare: two reps or two periods on Team performance.
- A6. Notifications as a right drawer (bell) with filters, instead of a page.
- A7. Dark theme check for every desktop table (the owner uses Windows at night).

## Done log

(step, version, PR, date)

- Step 1 (table engine + Customers page): 1.441.0, PR #479, 2026-10-27.
- Step 2 (Orders + Activity + Tasks on the engine): 1.442.0, PR #480, 2026-10-27.
- Step 3 (customer card in three columns): 1.443.0, PR #481, 2026-10-27.
- Step 4 (top bar search + quick actions + keyboard): 1.444.0, PR #483, 2026-10-27.
- Step 5 (sidebar groups + icons-only mode): 1.445.0, PR #484, 2026-10-27.
- Step 6 (reports as list + report, export, print): 1.446.0, 2026-10-27.
