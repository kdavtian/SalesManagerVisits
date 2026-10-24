# KAD OS (repo `kdavtian/kad-gmm`, "GMM") - what to know when you work on it

KAD OS is the free ERP of KAD Motors' wholesale customers (pilot: customer 10001 Garage Masters Mall). It is a SEPARATE repo and a separate
droplet app. The supplier-side half of the link lives in THIS repo (`docs/kad-os-link.md`, `server/src/routes/partner.js`, `appOrders.js`,
`appOrdersAdmin.js`, `views/kadOsAdmin.js`). Read that doc first for anything about orders, perks, campaigns, limits or the connection code.

## Workflow differences from Field Visits
- Same owner rules apply (draft PR -> subscribe -> CI `test` + `e2e-smoke` -> ready -> squash merge -> unsubscribe; reset the branch from
  origin/main with a force-with-lease whose sha comes from `git ls-remote`; summaries end with the versions).
- Versions: `client/public/js/version.js` (`APP_VERSION`, 0.x) AND `client/public/sw.js` (`CACHE_VERSION`, a plain number). `npm run check:version`.
- CI now runs `test`, `e2e (desktop)` and `e2e (phone)` in parallel under the required names `test` and `e2e-smoke` (see ops-runbook). Checks before pushing (in `server/`): `npm run verify:ui` (i18n keys hy + en, `node --check client/public/js/i18n.js`), `npm run check:version`,
  `node scripts/test-prepare.js` THEN `npm test` (the cleanup test wipes the DB: run prepare again before every new run), and
  `npx playwright test --config e2e/playwright.config.js` (desktop + phone, port 3011). Run tests in the background and wait with Monitor.
- **RBAC matrix**: every new route needs a row in `server/test/integration/rbac.test.js` (a missing row fails "every registered route has an RBAC matrix row").
- **e2e nav lists**: a new page must be added to `PAGES` and the role `expectNav` lists in `server/e2e/smoke.spec.js`.
- New client module imported by a precached view -> add to `APP_SHELL` in `sw.js`.
- CSP bans inline styles in KAD OS (classes only). All text flat i18n keys in hy + en.
- Postgres in the sandbox stops between turns: `pg_ctlcluster 16 main start`. Never `pkill -f` a string that is in your own command.
- Deploy order for the owner: **KAD Motors first, then KAD OS**: `cd /opt/field-visits && git pull origin main && ./deploy/deploy.sh`, then
  `cd /opt/gmm-app && bash deploy/deploy.sh` (`bash deploy/push-setup.sh` once for push-notification keys).

## Architecture (KAD OS side)
- `server/src/lib/kad.js` talks to KAD Motors' `/api/partner/*` (link from the DB via `lib/kadLink.js`, AES-256-GCM; `.env` fallback), `lib/kadWatch.js` +
  `lib/push.js` = web-push of order steps / offers. Client: `ui/kadHub.js`, `ui/kadOrder.js`, `views/purchases.js`, `views/suppliers.js`; offline order
  queue in `outbox.js` (kind `kad_order`).
- Oil finder: `server/src/lib/oilFinder/` (`query.js` parse, `cars.js` makes/models/aliases + suggestions, `service.js` search/suggest/jobs, `claude.js`
  AI web search, `oil.js` product matching), route `routes/oilFinder.js`, client `views/oilfinder.js` (page AND sheet: `ui/oilFinderSheet.js`,
  opened by the orange `.oil-pill` in the top bar / side menu). `ANTHROPIC_API_KEY` in `/opt/gmm-app/.env` enables internet lookup (owner pastes it silently
  on the droplet, never in chat); without it only the confirmed table answers and managers add cars by hand.
- Owner choices (2026-10-21/22): KAD OS never sees stock quantities (only shelf products, `max_qty` per product); per-pack-size order limits (1 L 48,
  4/5 L 16, 7 L 12, 60 L 4, 180/205/208 L 4, else 12) with On/Off + numbers in Settings -> KAD OS; over the limit the message names the customer's own
  manager's phone (else office) in local format `033 007 020`; products sorted like KAD Motors (`compareProducts`); Armenian-only notifications are fine.
- Data KAD Motors shares with KAD OS = what `partner.js` returns (me, catalog, price-list (Bronze list price only), offers, orders, balance, preview, order create/cancel). Costs,
  margins, stock numbers, other customers and internal hold reasons are never sent. Keep that list true when you add a field (the owner asked for it).

## Wholesale price = KAD Bronze price (owner, 2026-10-23, 0.53.0)
- The shop's wholesale price (the "Wholesale" switch of a sale line, Products page, Oil finder) is KAD Motors' **Bronze list price**, not the workbook's OPT (OPT = the Silver price). Pipeline: KAD Motors `GET /api/partner/price-list` (every active product, in stock or not: id, brand, family, name, size, sku, bronze; SalesManagerVisits#412) -> `server/src/lib/bronze.js syncBronzePrices()` matches products with `matchLocal` (brand + name without size + pack size) and writes `products.bronze_price_amd` (migration 033) at start +30 s, every 6 h and on demand (`POST /api/kad-orders/sync-prices`, ceo/admin/manager).
- Everything reads `coalesce(bronze_price_amd, opt_price_amd)`: API field `wholesale_price_amd` (products list, `/api/receipts/quick`), and the server's own receipt pricing (`lib/receipts.js`, so a phone can never choose the price). `opt_price_amd` stays the workbook value (product edit form). A card KAD does not list, or an older KAD without the endpoint, keeps OPT.
- Open follow-up: nothing shows the owner WHEN the Bronze prices were last synced (`bronze_synced_at` is stored); add a small "synced at" line in Settings -> KAD OS if asked.

## Product order = KAD Motors' own comparator (owner, 2026-10-23: "Sort ALL products as in Kad motors everywhere")
- KAD Motors' `client/public/js/productSort.js compareProducts`: oils (a viscosity grade in the name) by brand (Castrol, Lotos, Orlen, Royal, rest A-Z) > product line (Edge, Magnatec, GTX, CRB, Vecton, ON, ...) > viscosity (0W-8 ... 15W-40, 10W-60 right after 0W-40) > specification (C1 ... LL) > pack size ascending > name; everything without a viscosity grade after all oils, A-Z by name.
- KAD OS twin: `server/src/lib/productOrder.js kadKey()` builds ONE sortable SQL text key (so lists can still be paged) used by Products, Warehouse (inventory), stocktaking and the sale product finder (`ORDER BY kadKey, size_l, id`); `brandRank/familyRank` order the brand chips and filter lists; client side `util.js byPriority(BRAND_ORDER)`. Any new product list must use these. Keep both twins in sync with KAD Motors if its comparator changes (test: `product-order.test.js`).

## Sale screen rules (owner, 2026-10-23)
- New sale: the line discount defaults to **AMD** and an AMD discount is taken off **each unit** (x quantity); `%` unchanged. The client converts to the server's line-total `discount_amd` when it sends (`money(unit discount * qty)`), the server contract did not change.
- Adding a product again, + and - update in place (`bumpLine`, `appendLine`, `markFound` in `views/sale.js`); only discount edits, deletes and customer changes repaint the lines list.

## Row actions (swipe pen/bin, long press) - `ui/rowActions.js`
- Phones send NO click after a swipe, so a "swallow the next click" flag armed by a swipe stayed on and ate the tap on the pen/bin ("buttons stuck"). The flag now expires after 700 ms, the pen/bin are never swallowed, and any press outside the open row closes it. Test it with synthetic pointer events (no click), not with `page.mouse` (which does click).
- Look: the pen has no background (accent icon), the bin is a rounded chip in the app red (`--neg`), both on the surface colour.

## Logo
- Orange tile (#ff8a3d) with a graphite K (reversed on 2026-10-23); icons `client/public/icons/*` are regenerated from `favicon.svg` (Playwright screenshot of the SVG, then PIL rounded-corner mask for the non-maskable PNGs).

## Lessons
- A model typed without its make ("Camry") used to become a make called "Camry": the make-less case needs inference from the make/model list.
- Suggestions: debounce 140 ms, server `GET /api/oil-finder/suggest?q=`, shop's own customer cars boost the ranking; picking a model fills the input and
  waits for the year (oil depends on the year, and a no-year AI answer would be stored for every year).
- Open an existing screen as a sheet (`openSheet`) when it must not lose the screen below it (a sale in progress); mount the same view with `{ embedded, onPick }`.
