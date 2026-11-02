# Castrol Global presentations

## KAD OS deck (current, November 2026)

KAD OS explained feature by feature for Castrol Global, who asked for it so they can share it with other Castrol distributors: what each module solves, how it works step by step, real screens and embedded demo videos. The only statistics are build and adoption time (owner, 2026-11-02). Includes the owner's own edits from `KAD_OS_Castrol_Global_v4.pptx` and `_v5.pptx` (v5: no "about this deck" slide, A-to-Z headline, "Reporting", daily report to management, "IWS", shorter title notes) (wording on slides 3, 4, 8, 9 and 18; "AI agent" naming; build timeline May -> Aug -> Sep -> 6th month).

| File | What it is |
|---|---|
| `KAD_OS_Castrol_Global.pptx` | 16:9, 33 slides, speaker notes on every slide, 4 embedded demo videos (click the phone to play). Outline: title, what is KAD OS, problems solved, how it works, the home screen, A to Z flow, customers & map (2), customer card (2 + video), check-in (2 + video), routes & fuel allowance, orders (+ video), accounting & invoicing, credit & cash, warehouse (+ video), delivery & driver, management, Executive Assistant, AI agent, how the AI agent decides, human approvals, AI & automation, built for field work, built and adopted, adoption (bonus + contest), next: customer app, thank you. Includes the owner's v4 and v5 edits. Font: Arial only. |
| `KAD_OS_Castrol_Global.pdf` | PDF export for e-mail; video slides show a still. |
| `KAD_OS_OnePager.pdf` | One-page A4 summary. |
| `kados/videos/*.mp4` | The demo videos (H.264, 390x844): `checkin`, `order`, `customer`, `pack`, with poster frames. |
| `kados/screenshots/*.png` | Framed iPhone screens used in the deck (home, map, customer list, filters, customer card, last order, payments, potential customer, check-in steps, competitors, too-far refusal, order steps, warehouse, stock count, driver home, route, dashboard, reports, AI agent, Executive Assistant). |
| `kados/source/` | `shoot.mjs` (screens + automatic rejection), `record.mjs` (videos), `frames.py`, `build_kados.py`, `onepager.html` / `onepager.mjs`, `assistant.html` / `assets.mjs`. |
| `assets/` | Official KAD logo; Castrol logo file used by the company's price lists (replace with Castrol's official high-resolution file). |

### Branding
- Name "KAD OS"; lockup = "KAD OS" with "powered by Castrol" directly under it (text only, never mixed into a logo file). Tagline: "The operating system for a modern Castrol distributor."
- Logos are only the files in `assets/`, unmodified, on white backgrounds with clear space (there is no official reversed version, so no logo sits on a dark background). Castrol logo appears on the title slide, the closing slide and the one-pager only; every content slide carries the small KAD OS lockup in the footer.
- Palette sampled from the official Castrol logo file: green `#009343`, red `#F00023`; text `#141B24`.
- "powered by Castrol" is framed in the notes of slide 1 (and on the one-pager) as a PROPOSED co-brand, subject to Castrol's approval.

### Claims check (every capability claimed -> where it exists in the code)

| Claim | Status | Proof in the repo |
|---|---|---|
| GPS-verified check-in, refused beyond the allowance (300 m default) | Live | `server/src/field/routes/checkins.js`, `server/migrations/111_checkin_allowance.sql`, `client/public/js/views/checkin.js` |
| Photo with the visit | Live | `checkins.photo_path` in `server/src/field/routes/checkins.js` |
| Shelf audit: Castrol present, full range, fake product, competitor brands | Live | `checkins.brand_status`; `GET /api/customers/brand-summary` in `server/src/customers/routes/customers.js`; `client/public/js/brandChips.js` |
| Customer map / CRM | Live | `client/public/js/views/map.js`, `client/public/js/views/customerDetail.js` |
| Routes (module "Customers & Map") | Live | `server/src/orders/routePlanner.js` |
| Central tier pricing, reps never type a price | Live | `server/src/products/tierPricing.js` (gold individual prices: management only) |
| Discounts: up to 3 % automatic, more needs approval, below cost needs the CEO | Live | `server/src/orders/discountPolicy.js` |
| Credit limits; over the limit the order waits for approval | Live | `server/src/orders/creditLimit.js` |
| Debt aged per invoice; overdue becomes a collection task | Live | `server/src/money/debtAge.js`, `server/src/money/debtCollectionTasks.js` |
| Targets and bonuses | Live | `server/src/bonus/`, `server/src/reports/routes/teamPerformance.js`, `client/public/js/views/teamPerformance.js` |
| Live dashboards, litres by product line, rep scorecards, debt ageing | Live | `server/src/reports/routes/dashboard.js`, `server/src/reports/routes/salesPerformance.js`, `server/src/reports/volumeReport.js`, `server/src/reports/scorecard.js` |
| Manager sees new orders live and approves | Live | `server/src/orders/routes/orders.js`, `client/public/js/views/orders.js` |
| KAD OS Executive Assistant: daily, weekly, monthly management reports with risks | Live | repo `kdavtian/castrol_ceo_report`, `automation/ceo_agent.py` (`build_period_briefing`, anomaly checks), `work/build_ceo_report.py` |
| AI deputy director: watches the field day, assigns, chases, escalates | Live (rule engine) | `server/src/team/vaghinak/` (`engine.js`, `evaluate.js`, `chasers.js`, `cluster.js`, `digest.js`) |
| Must-answer questions for reps | Live | `MANDATORY_ROLES` in `server/src/team/vaghinak/engine.js`; blocking sheet in `client/public/js/vaghinak.js` |
| AI analyst, anonymised | Live | `server/src/team/askKad/` |
| Self-closing tasks | Live | `server/src/team/taskAutoComplete.js`, `server/src/money/debtCollectionTasks.js` |
| Integration API for accounting, hashed tokens, test tokens | Live | `server/src/erp/routes/integration.js`, `server/src/erp/integrationTokens.js` |
| Daily accounting data feed, matched by ID | Live | `server/src/erp/routes/erpSync.js` |
| Customer ordering through partner endpoints | Pilot | `server/src/orders/routes/partner.js` (one customer) |
| Works offline, no duplicates | Live | `client/public/js/offlineQueue.js` (idempotent `client_ref`) |
| Fast on low-end phones: speed budgets on a slow phone | Live | `server/test/e2e/speed-budget.spec.mjs` |
| Mobile web app from a link, no app store | Live | `client/public/manifest.app.json`, `client/public/sw.js` |
| 8 roles, enforced on the server | Live | `client/public/js/shared/roles.js`, `server/test/architecture.test.js` |
| HTTPS; signed sessions, CSRF, rate limits, lockout | Live | `deploy/nginx.conf`, `server/src/system/routes/auth.js`, `server/src/app.js` (helmet) |
| Audit trail | Live | `server/migrations/071_immutable_audit_logs.sql`, `070_order_status_history.sql`, `045_customer_level_audit.sql` |
| Visit plans and weekly routes, planned automatically | Live | `server/src/orders/routePlanner.js`, `server/src/field/` visit plans |
| New customer added from the map | Live | `client/public/js/views/map.js` (add mode) |
| Usual basket / repeat order | Live | `server/src/customers/customerReorder.js`, `client/public/js/orderMenu.js` |
| Printable delivery form (order blank) | Live | `server/src/orders/orderBlankPdf.js` |
| Promise dates; broken promise to the sales director | Live | `server/src/money/debtCollectionTasks.js` |
| Payments tracked to the accountant (cash handover) | Live | `server/src/money/routes/cashHandoffs.js` |
| Debt statement PDF | Live | `server/src/money/debtStatementPdf.js` |
| Automatic calculations: landing cost, cost at price, credit-limit suggestion, order rhythm, days of stock, working hours, fuel | Live | `server/src/products/landingCalc.js`, `server/src/orders/discountPolicy.js`, `server/src/orders/creditLimitSuggest.js`, `server/src/orders/orderRhythm.js`, `server/src/products/stockForecast.js`, `server/src/field/repProgress.js`, `server/src/field/fuelRoute.js` |
| Delivery & Driver: route planning, next stop, arrival detection, customer signature, failed delivery | Live | `server/src/orders/routes/delivery.js`, `client/public/js/views/driverHome.js`, `client/public/js/views/deliveryRoute.js`, `client/public/js/views/deliveryArrivalAdmin.js` |
| Warehouse: home, pick & pack, problem button, daily blind stock count, reorder list | Live | `server/src/orders/routes/warehouse.js`, `client/public/js/views/warehouseHome.js`, `client/public/js/views/warehousePack.js`, `client/public/js/views/stockCount.js`, `server/src/orders/stockCount.js` |
| Potential customers with level, reasons, follow-up, expected volume; advanced filters | Live | `client/public/js/potential.js`, `client/public/js/potentialFilterSheet.js`, `client/public/js/views/customers.js` |
| Wrong pins found from GPS evidence | Live | `server/src/customers/pinReview.js` |
| Weekly route plans built automatically | Live | `server/src/field/routes/routePlanSets.js`, `server/src/orders/routePlanner.js` |
| Fuel allowance from the day's check-ins: road km, home legs outside Yerevan, city/highway consumption, monthly price, flags and corrections | Live | `server/src/field/fuelRoute.js`, `server/src/field/fuelReport.js`, `server/src/field/routes/fuel.js` |
| Invoice / waybill requested from the order, created by the AI accounting integration, documents attached back to the order | Live | `server/src/orders/routes/orders.js` (`/accounting-request`), `server/src/erp/routes/integration.js` (documents upload) |
| Order form ready to print after saving; signed slip photo or e-signature with a payment | Live | `server/src/orders/orderBlankPdf.js`, Payments "+" sheet (1.493.0) |
| Reorder reminder when a customer's usual order rhythm breaks; collection task closes itself when the payment is recorded | Live | `server/src/orders/orderRhythm.js`, `server/src/money/debtCollectionTasks.js`, `server/src/team/taskAutoComplete.js` |
| Late arrival logged, rep asked for the reason; repeated lateness reported to management | Live (management sees it in the weekly digest) | `server/src/team/vaghinak/engine.js`, `server/src/team/vaghinak/digest.js` |
| Human approvals: discounts, below-cost prices, credit limit, order confirmation, payments, customer edits, AI agent test mode | Live | `server/src/orders/discountPolicy.js`, `server/src/orders/creditLimit.js`, `client/public/js/shared/roles.js`, `server/src/team/vaghinak/settings.js` |
| Bonus system and leaderboard; monthly check-in contest | Live (contest prize paid by the company) | `server/src/bonus/`, `client/public/js/views/repProgress.js` |
| **Customer app (online orders, offers, balance, notifications)** | **Next** | not built for KAD Motors' customers yet |
| **Expert AI agents for sales, finance, stock** | **Next** | not built |
| **Brand-owner (Castrol) reports via the API** | **Proposed** | not built |

### Where every number comes from
| Number | Source |
|---|---|
| 3 months to the first live version (May -> Aug 2026); 4th month whole team; 6th month complete system | owner's figures (edited in v4, 2026-11-02): work started in May 2026; first production deploy 2026-08-24 (git history) |
| Whole field team in the app in September 2026, the first full month | live system, read-only query run by the owner on 2026-11-02: rep check-ins were 1 in August and 398 in September, by all 3 field reps |
| 763 improvements | 763 commits on `main` on 2026-11-02 |
| 300 m check-in allowance; 3 % automatic discount | `server/migrations/111_checkin_allowance.sql`; `AUTO_APPROVE_PCT` in `server/src/orders/discountPolicy.js` |
| Values on the app screens and in the Executive Assistant report | made-up demo data |

No business statistics (sales, customers, debt, visits) are shown, by the owner's decision of 2026-11-02.

### How to regenerate
1. A throwaway demo database with the app's demo seed, made deck-ready (never production):
   ```bash
   pg_ctlcluster 16 main start
   psql postgres://postgres:postgres@localhost:5432/postgres -c "CREATE DATABASE fv_kados"
   export DATABASE_URL=postgres://postgres:postgres@localhost:5432/fv_kados JWT_SECRET=deck-local-secret-xxxxxxxx NODE_ENV=test
   (cd server && npm run migrate && DEMO_MODE=1 DEMO_PASSWORD=pick-any-demo-password node scripts/demo-site.mjs seed)
   node docs/castrol-global/source/anonymize-demo.mjs
   psql "$DATABASE_URL" -c "update products set unit = trim(trailing '.' from trim(trailing '0' from size_l::text)) || 'L'"
   psql "$DATABASE_URL" -f docs/castrol-global/source/vaghinak-demo.sql
   (cd server && PORT=3201 E2E_RATE_LIMIT_BYPASS_TOKEN=deck node src/index.js &)
   ```
2. Screens, mock, frames, deck, PDFs:
   ```bash
   cd docs/castrol-global/kados/source
   DECK_BYPASS=deck DECK_PASSWORD=pick-any-demo-password node shoot.mjs    # rejects Armenian text, keys, banned words, empty screens
   DECK_BYPASS=deck DECK_PASSWORD=pick-any-demo-password node record.mjs   # demo videos (needs ffmpeg)
   node assets.mjs && python3 frames.py
   python3 build_kados.py && node onepager.mjs
   NO_VIDEO=1 DECK_OUT=/tmp/deck_stills.pptx python3 build_kados.py && soffice --headless --convert-to pdf --outdir /tmp /tmp/deck_stills.pptx
   cp /tmp/deck_stills.pdf ../../KAD_OS_Castrol_Global.pdf
   ```
3. QA: render the PDF to PNGs (`pdftoppm -r 80 -png KAD_OS_Castrol_Global.pdf s`), look at every page, and search all slide text, notes and both PDFs for the banned words listed in the owner's brief (must be zero).

## Earlier deck: KAD Platform (October 2026)

An English deck and leave-behind that present the KAD Motors platform (Field Visits PWA + Castrol CEO Telegram bot / ERP sync) to Castrol Global executives as a scalable "Castrol Distributor Sales Platform".

## Files

| File | What it is |
|---|---|
| `KAD_Platform_Castrol_Global.pptx` | The deck: 16:9, 21 slides + 1 appendix slide (architecture & security), speaker notes on every slide. Font Arial (same look in PowerPoint and LibreOffice). |
| `KAD_Platform_OnePager.pdf` | One-page A4 leave-behind: the ten distributor problems and what the platform does about each, the data → decision → action loop, the proposal. |
| `screenshots/*.png` | Framed iPhone images used in the deck and the one-pager: `checkin`, `map`, `customer`, `order`, `debt`, `dashboard`, `team`, `vaghinak` (management view), `vaghinak_rep` (a rep's must-answer question), `tasks`, `reports`, `bot` (CEO-bot mock), `shelf_audit` (Castrol-only crop). |
| `screenshots/raw/*.png` | The unframed screenshots (390x844 @3x) the frames are made from. |
| `source/` | Everything needed to rebuild the above (scripts, icons, the bot mock page, the one-pager page, the Vaghinak demo messages). |

**Logo spots:** slide 1, slide 21 and the one-pager top right have a dashed box marked "CASTROL LOGO". Replace it with the official Castrol asset; the deck never draws or imitates the Castrol logo.

## Deck outline

1 Title · 2 At a glance · 3 Built by our whole team · 4 Data → decision → action · 5 Ten real problems · 6-7 Problem → solution · 8 The platform (app, Vaghinak, bot) · 9 How it works · 10 Field execution · 11 Commercial control · 12 Vaghinak: what he controls · 13 Vaghinak closes the loop · 14 AI and automatic calculations · 15 Financial and management reports · 16 Management visibility · 17 Twelve unique features · 18 A month at a glance (illustrative) · 19 3-stage market plan · 20 Roadmap · 21 Why it matters + proposal · A1 Architecture and security.

## No real data (owner's rule, 2026-10-30)

- **No real company figures anywhere**: no sales, litres, customers, debt, plan or collection numbers of KAD Motors. Slide 18 and the bot mock use **illustrative values in USD**, labelled as such; they only show what the platform measures.
- Every app screen uses **made-up demo data** from the app's demo seed (`server/scripts/demo-site.mjs`). `source/anonymize-demo.mjs` gives the shops English names, the reps neutral names (Rep A/B/C), fake phones and a Castrol-only catalogue. The app screens keep the app's own currency (AMD) on demo amounts.
- Vaghinak's messages are written in Armenian by the app; `source/vaghinak-demo.sql` puts English demo messages and English automatic-task titles into the demo database for the screenshots (marked "demo, translated" on the slide).
- Map tiles are drawn locally by `source/tiles.mjs` (neutral made-up streets).
- Facts that are kept are product facts, not business data: the 300 m check-in limit and 3% discount rule (app defaults), 8 roles, ~1,200 automated tests, 750+ improvements since August 2026 (git history).

## How to regenerate

From the repo root, in a dev environment with Postgres 16 and `server/node_modules` installed (`cd server && npm install`):

```bash
# 1. a throwaway demo database (never production)
pg_ctlcluster 16 main start
psql postgres://postgres:postgres@localhost:5432/postgres -c "CREATE DATABASE fv_deck"
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/fv_deck JWT_SECRET=deck-local-secret-xxxxxxxx NODE_ENV=test
(cd server && npm run migrate && DEMO_MODE=1 DEMO_PASSWORD=pick-any-demo-password node scripts/demo-site.mjs seed)
node docs/castrol-global/source/anonymize-demo.mjs        # SHIFT_HOURS=0 if the machine clock is already Yerevan time
psql "$DATABASE_URL" -f docs/castrol-global/source/vaghinak-demo.sql

# 2. run the app on port 3201
(cd server && PORT=3201 node src/index.js &)

# 3. screenshots, icons + bot mock, frames, deck, one-pager
cd docs/castrol-global/source
DECK_PASSWORD=pick-any-demo-password node shoot.mjs      # or: node shoot.mjs map  (one screen)
node assets.mjs
python3 frames.py
python3 build_deck.py
node onepager.mjs
```

Needs Python 3 with `python-pptx` and `Pillow`, and Playwright's Chromium (pre-installed in the cloud sessions).

**QA render** (look at every slide before sharing):

```bash
soffice --headless --convert-to pdf --outdir /tmp/deck docs/castrol-global/KAD_Platform_Castrol_Global.pptx
pdftoppm -r 80 -png /tmp/deck/KAD_Platform_Castrol_Global.pdf /tmp/deck/s
```

Text edits: slide text and speaker notes live in `source/build_deck.py` (one block per slide); the one-pager text is in `source/onepager.html`; the bot mock is `source/bot.html`.
