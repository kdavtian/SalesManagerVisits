# Business / domain rules (decisions the owner has made)

## Company
KAD Motors (Armenia), distributes Castrol (also Lotos, Orlen, Royal) lubricants. Field sales managers visit workshops/oil-change points; office staff (director, CEO, operations director, accountant, warehouse, delivery) use the same app. Currency AMD; liters matter as much as money.

## Customers
- Category (`customers.category`, stored as Armenian text, label via `categoryLabel`): oil change point (Յուղման կետ), workshop, shop, garage, other.
- Tier (`customer_tier`): `potential` (no ERP link yet, default for new), `bronze` (auto when an ERP customer id is entered while tier is potential; silver/gold are never auto-downgraded), `silver`, `gold`, `competitor`. Colours: gold/silver/bronze must look like gold/silver/bronze. Customer-list icon: category glyph with outline + glyph in tier colour, white/none inner fill. Map pins: ALL our customers (bronze/silver/gold) are one green (clearly distinguishable from red); potential stay red; tier is not shown on the map.
- ERP link: `erp_customer_id` (Excel "Customer ID"). Only linked customers show debt/orders/last payment. Prevent duplicate ERP ids.
- Sales channel (a.k.a. "direction"; codes like SM YVN, SM DAVTASHEN, SM SHIRAK, SM CAS, SM B2B, CVO, PCO, OEM, KF, CAS, retail) and assigned manager come automatically from region/subregion via `route_distribution` when creating a customer; CVO/PCO/OEM etc. the user sets manually. Channels KF/CAS/CVO/PCO/OEM never become "overdue" (not visited in the field). Region/subregion are auto-detected from the pin (Armenian names stored; display in current UI language). New-customer default name = `<Subregion> / Yuxman ket` in English transliteration (e.g. `Armavir / Yuxman ket`), editable.
- Sales managers see ONLY customers assigned to them, plus ERP data only for those; management sees all. Customer edits by managers go through edit requests (admin sees a requests list + notifications).
- Customers tab filters (all tri-state accordion sheets): assignment (direction -> manager), region -> subregion, customer type -> tier (replaced the old Direction filter in v1.244.0). Status chips: all/visited/overdue/not visited.
- Search matches name, address, ERP id, phones, social profiles, and more.

## Pricing (v1.244.0)
Products carry `bronze_price_amd` (+`unit_price_amd` mirror), `silver_price_amd`, `gold_price_amd`, `retail_price_amd`, `landing_cost_amd`, net cost, `hc_code` (accounting product code), `family`, `brand`, `unit`, `stock_qty`.
Order line price is resolved on the SERVER from the customer's tier (`server/src/tierPricing.js`): bronze/potential/competitor -> bronze (if empty or 0 -> silver); silver -> silver, else bronze; gold -> gold, else silver, else bronze. 0 means "not set". Gold customers can have individually negotiated prices (`customer_product_prices`, migration 087): saved ones apply automatically; admin/sales_director/ceo/operations_director can type a price per line in the order form (`price_override: true`) and it is remembered. Client `tierPrice`/`basePrice` in `orderCreate.js` only displays. Prices snapshot into the order at save time.
Open question not yet confirmed with the owner: whether the app's customer tier should follow Excel `Tier` (the bot already sends `erp_tier`; server currently ignores it).

## Orders
Workflow EXACTLY 5 stages: draft -> submitted -> confirmed -> packed_stock_out (one stage: "Packed / Stock Out") -> delivered. Orders for customers without ERP id stay `draft`. Discount (% or flat AMD, mutually exclusive) needs director approval (`approval_status`); changing a discount resets approval; editing items keeps it. Payment method `cash` | `invoice`. Brand name shown on warehouse staging/pick lists. Excel per-product discounts/price adds are shown as an extra row under the discounted line. Products are only ever real catalog products.
Accounting (Lily): after confirm, management sees a sheet to request a Բեռնագիր (waybill) for cash orders or Հաշիվ ապրանքագիր (invoice) for invoice orders; they can change the payment method on the same sheet; doc type always follows payment method. Lily guesses missing hc_codes (but hc_code is also synced from the workbook).
Delivery: driver/sales director/accountant/ceo/admin may move packed -> delivered without a route (drivers don't use the app). Sales director has warehouse-manager permissions.

## Products ordering (everywhere: order form, pricelist, inventory, warehouse)
`productSort.js` `compareProducts`: brand (Castrol first, then Lotos, Orlen, Royal) -> family (Edge, Magnatec, GTX, CRB, Vecton, ...) -> viscosity ascending (0w8, 0w16, 0w20, 0w30, 0w40, 10w60 treated like 0w40 price-wise, 5w20, 5w30, 5w40, 10w40, 15w40...) -> specification (C3, C5, LL, A3/B4 ... grouped) -> size ascending (0.5L, 1L, 4L, 60L, 208L). Ungrouped Castrol goes under "Other". Grouped variant pills: one card per product, sizes as pills. Normalise unit text. Duplicate products in inventory are a bug to fix (dedupe by product id / normalised key).

## Stock
Days of stock left from sales demand (recency-weighted velocity, `stockForecast.js` / bot `product_recent_velocity`): `< 45 days` critical, `45-90` low, `>= 90` ok; dead stock flagged; inventory subtotals per product in pcs and liters. Landing cost / net cost toggle on warehouse (tap landing cost -> shows landing cost; tap again -> net cost; price buttons independent); AMD whole numbers.

## Money reports
- Excel is the trusted source; a 3-day lag of Excel data is preferred over live app numbers for debt/sales. Show data-freshness timestamps ("Castrol data as of ..." hidden behind the "!" icon).
- Debt balances page: live (Debits snapshot) and "as of date" (Balance0 + orders to D - cashflow payments to D, by customer id). Last payment = latest of app payments and Cashflow. Amounts right-aligned; sub-total in the headline row; as-of date uses the iOS-native wheel date picker (same as Team Performance).
- Sales page: ERP orders grouped by date with subtotals (AMD, liters, order count); month-to-date default starting from the 1st; card row 1 = OrderID . channel . amount (right), row 2 = customer name bold; wheel date pickers with "From"/"To" inside the buttons.
- Company dashboard: period filter (today/WTD/MTD/YTD, default MTD) styled like Activity chips; sales vs PLAN (never "budget"); a "|" marker for collected amount on the bar; per-rep bars for today/week/month; collected % of sales next to collected.
- Team performance: only Sales + Collections (merged bar), plan only for sales; management sees aggregated total; managers see their own result (and channel results for channels assigned to them, e.g. B2B).
- Home dashboard progress for sales managers is cumulative week progress ("this week's progress", visited this week); managers see today's visit plan; management home shows Company Dashboard preview instead of recent activity.

## Bonuses module
Feature flag; challenges (daily/weekly/monthly, product-sales type, audiences by role/user), ledger, badges, personal bests, reward claims/payouts with GPS-evidence rules; hide daily challenges the user has not progressed on; "Monthly leaders" collapsible; Armenian wording: "Օպերացիոն տնօրեն", "Թիմի կատարողական".

## Languages
Armenian default; English available. Examples of wording the owner corrected: Կամընտիր -> Ըստ ցանկության; Օպերացիաների տնօրեն -> Օպերացիոն տնօրեն; Թիմի կատարողականություն -> Թիմի կատարողական; Այսօրվա -> Այս շաբաթվա առաջընթացը (week progress).
